"""Shared router + helpers cho package `wallet` (feature 003-wallet-invite-payment).

Mọi sub-module (balance.py, topup.py, withdraw.py, admin.py) đăng ký endpoint lên
CÙNG một APIRouter (prefix `/api/v1/wallet`). Business logic thay đổi số dư nằm ở
`app/services/wallet_service.py`, KHÔNG ở router.
"""

import secrets
from collections.abc import Sequence
from uuid import UUID

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PaymentOrder, PaymentSettings, TopupOrder, User, WalletTransaction

router = APIRouter(prefix="/api/v1/wallet", tags=["wallet"])

# Cấu trúc mã thanh toán đa luồng mặc định (feature 003) — đồng bộ seed.DEFAULT_PAYMENT_CODES.
# Định nghĩa ở đây để tránh circular import; get_payment_settings backfill khi thiếu.
DEFAULT_PAYMENT_CODES = [
    {"key": "topup", "label": "Nạp tiền", "prefix": "NAP", "suffix_min": 3, "suffix_max": 30, "suffix_type": "alphanumeric", "enabled": True},
    {"key": "order", "label": "Thanh toán hoá đơn (mời/gia hạn)", "prefix": "ORDER", "suffix_min": 6, "suffix_max": 30, "suffix_type": "alphanumeric", "enabled": True},
]


def get_payment_settings(db: Session) -> PaymentSettings:
    """Lấy cấu hình thanh toán singleton (id=1), tạo mặc định nếu thiếu. Đảm bảo
    payment_codes luôn có (backfill mặc định cho row cũ/tạo mới)."""
    settings = db.get(PaymentSettings, 1)
    if settings is None:
        settings = PaymentSettings(id=1, payment_codes=[dict(c) for c in DEFAULT_PAYMENT_CODES])
        db.add(settings)
        db.flush()
    elif not settings.payment_codes:
        settings.payment_codes = [dict(c) for c in DEFAULT_PAYMENT_CODES]
        db.add(settings)
        db.flush()
    return settings


def topup_prefix(settings: PaymentSettings) -> str:
    """Tiền tố của luồng 'topup' (nạp ví) từ payment_codes; fallback code_prefix/'NAP'."""
    for flow in settings.payment_codes or []:
        if flow.get("key") == "topup" and flow.get("enabled", True):
            return str(flow.get("prefix") or settings.code_prefix or "NAP")
    return settings.code_prefix or "NAP"


def ensure_topup_code(db: Session, user: User) -> str:
    """Trả MÃ NẠP CỐ ĐỊNH của user, sinh lazy nếu chưa có (user 2026-07-14). Mã này
    KHÔNG đổi giữa các lần nạp → nội dung CK trên QR nạp luôn y hệt, user lưu lại được.

    12-hex ngẫu nhiên (nằm trong dải suffix mặc định 3..30 của luồng NAP). Retry nếu
    trùng (unique constraint uq_users_topup_code). KHÔNG commit — caller lo."""
    if user.topup_code:
        return user.topup_code
    for _ in range(8):
        code = secrets.token_hex(6)
        exists = db.execute(
            select(User.id).where(User.topup_code == code)
        ).scalar_one_or_none()
        if exists is None:
            user.topup_code = code
            db.add(user)
            db.flush()
            return code
    raise RuntimeError("không sinh được topup_code duy nhất")


def order_prefix(settings: PaymentSettings) -> str:
    """Tiền tố của luồng 'order' (hoá đơn mời/gia hạn) từ payment_codes; fallback 'ORDER'.

    Dùng để dựng nội dung CK trên QR hoá đơn. Webhook khớp luồng key='order' theo
    CHÍNH tiền tố này nên phải đọc từ cùng nguồn cấu hình."""
    for flow in settings.payment_codes or []:
        if flow.get("key") == "order":
            return str(flow.get("prefix") or "ORDER")
    return "ORDER"


# ── Mã đối soát của bút toán ────────────────────────────────────────────────

def _as_uuid_or_none(value: str | None) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def resolve_txn_codes(
    db: Session, rows: Sequence[WalletTransaction]
) -> dict[UUID, tuple[str | None, str | None]]:
    """`txn.id → (mã hoá đơn, mã giao dịch SePay)` cho cả lô bút toán.

    Sổ cái chỉ giữ `ref_type` + `ref_id` trần nên báo cáo xuất ra không có gì để
    đối chiếu với sao kê ngân hàng hay với hoá đơn user nhìn thấy trên web. Ở đây
    dịch ngược:

      • `ref_type='topup'` → topup_orders.ref_code (mã nạp cố định in trên QR nạp).
        Thanh toán TRÙNG hoá đơn cũng ghi ref_type='topup' nhưng ref_id lại là id
        hoá đơn → tra tiếp payment_orders, cuối cùng mới lấy `meta.order_ref`.
      • `ref_type='order'` → payment_orders.ref_code (mã ORDER trên QR hoá đơn).

    Phí mời/gia hạn KHÔNG tra ở đây: chúng trỏ về lệnh trong hàng đợi chứ không về
    hoá đơn, và một member có thể có nhiều hoá đơn gia hạn nên ghép theo ref_id là
    ghép ẩu. FE gán mã theo CỤM — phí trả qua hoá đơn dùng chung `created_at` với
    bút toán `order_topup` của nó (cùng một transaction), lấy mã từ đó là chắc.

    Trả về 2 truy vấn, không N+1.
    """
    topup_ids: set[UUID] = set()
    order_ids: set[UUID] = set()
    for r in rows:
        rid = _as_uuid_or_none(r.ref_id)
        if rid is None:
            continue
        if r.ref_type == "topup":
            topup_ids.add(rid)
            order_ids.add(rid)
        elif r.ref_type == "order":
            order_ids.add(rid)

    topups: dict[UUID, TopupOrder] = {}
    if topup_ids:
        found = db.execute(select(TopupOrder).where(TopupOrder.id.in_(topup_ids))).scalars().all()
        topups = {o.id: o for o in found}
    orders: dict[UUID, PaymentOrder] = {}
    if order_ids:
        found_o = db.execute(
            select(PaymentOrder).where(PaymentOrder.id.in_(order_ids))
        ).scalars().all()
        orders = {o.id: o for o in found_o}

    out: dict[UUID, tuple[str | None, str | None]] = {}
    for r in rows:
        meta = r.meta or {}
        raw_provider = meta.get("provider_txn_id")
        provider = str(raw_provider) if isinstance(raw_provider, str) and raw_provider else None
        code: str | None = None
        rid = _as_uuid_or_none(r.ref_id)
        src = None
        if rid is not None:
            if r.ref_type == "topup":
                src = topups.get(rid) or orders.get(rid)
            elif r.ref_type == "order":
                src = orders.get(rid)
        if src is not None:
            code = src.ref_code
            provider = provider or src.provider_txn_id
        if code is None:
            raw_ref = meta.get("order_ref")
            if isinstance(raw_ref, str) and raw_ref:
                code = raw_ref
        out[r.id] = (code, provider)
    return out
