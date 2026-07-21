"""Shared router + helpers cho package `wallet` (feature 003-wallet-invite-payment).

Mọi sub-module (balance.py, topup.py, withdraw.py, admin.py) đăng ký endpoint lên
CÙNG một APIRouter (prefix `/api/v1/wallet`). Business logic thay đổi số dư nằm ở
`app/services/wallet_service.py`, KHÔNG ở router.
"""

import secrets

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PaymentSettings, User

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
