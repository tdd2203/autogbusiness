"""sepay_integration — cầu nối module `app.sepay` với DB/ví, hỗ trợ MÃ ĐA LUỒNG.

SePay bank-monitoring bắn 1 webhook cho mọi khoản tiền vào; nội dung CK có tiền tố
phân luồng (NAP = nạp ví, ORDER = thanh toán đơn hàng, …). `process_multiflow_webhook`
tự: auth Apikey → normalize → lọc → chống trùng → thử khớp TỪNG luồng đang bật theo
tiền tố → dispatch handler đúng luồng. Dùng CHUNG một session request, commit 1 lần
ở router (tránh rò rỉ connection idle-in-transaction — xem fix 2026-07-12).

Hiện chỉ luồng `topup` (NAP) có consumer (cộng ví). Luồng khác nhận diện được nhưng
trả "recognized but not handled" cho tới khi có consumer riêng.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import PaymentOrder, PaymentSettings, SepayIdem, TopupOrder, User
from app.sepay import SepayConfig, SepayEvent
from app.sepay.payload import (
    build_idempotency_key,
    extract_prefixed_code,
    normalize_sepay_payload,
)
from app.services import wallet_service

logger = logging.getLogger("sepay_integration")


class PgIdemStore:
    """Chống trùng webhook trên session request (bảng sepay_idem). `mark` không
    commit — router commit 1 lần (atomic với credit)."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def seen(self, key: str) -> bool:
        return self.db.get(SepayIdem, key) is not None

    def mark(self, key: str) -> None:
        self.db.execute(
            text(
                "INSERT INTO sepay_idem (key, created_at) VALUES (:k, now()) "
                "ON CONFLICT (key) DO NOTHING"
            ),
            {"k": key},
        )


def build_sepay_config(settings_row: PaymentSettings) -> SepayConfig:
    """SepayConfig từ cấu hình DB (bank/tolerance) + secret từ env."""
    env = get_settings()
    return SepayConfig(
        apikey=env.sepay_apikey,
        secret_key=env.sepay_secret_key,
        bank_name=settings_row.bank_name or "",
        account_number=settings_row.account_number or "",
        account_name=settings_row.account_name or "",
        code_prefix=settings_row.code_prefix or "NAP",
        amount_tolerance=int(settings_row.amount_tolerance_vnd or 1000),
    )


def _verify_hmac(secret: str, raw_body: bytes, sig_header: str, timestamp: str) -> bool:
    """Verify chữ ký HMAC-SHA256 theo ĐÚNG cơ chế SePay (hướng dẫn chính thức):

        signed  = f"{timestamp}.{payload}"   # payload = body dạng text (raw)
        expected = "sha256=" + HMAC_SHA256(secret, signed).hexdigest()
        hợp lệ ⇔ compare_digest(expected, X-SePay-Signature)

    timestamp lấy từ header X-SePay-Timestamp (unix seconds). Secret trống → bỏ
    verify (demo). So khớp hằng-thời-gian, có cả nhánh không-timestamp để dự phòng.
    """
    if not secret:
        logger.warning("[sepay] hmac chọn nhưng SEPAY_WEBHOOK_SECRET trống → bỏ verify (demo)")
        return True
    sig = (sig_header or "").strip()
    if not sig:
        return False
    payload = raw_body.decode("utf-8", errors="replace")
    signed = f"{timestamp}.{payload}".encode()
    expected = "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    if hmac.compare_digest(expected, sig):
        return True
    # Dự phòng: một số cấu hình SePay ký chỉ payload (không timestamp).
    fallback = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(fallback, sig)


def _verify_auth(settings_row: PaymentSettings, headers: dict, raw_body: bytes) -> bool:
    """Xác thực webhook theo phương thức đã chọn: none | apikey | hmac."""
    env = get_settings()
    method = (settings_row.sepay_auth_method or "apikey").lower()
    if method == "none":
        return True
    if method == "hmac":
        sig = headers.get("x-sepay-signature", "") or headers.get("X-Sepay-Signature", "")
        ts = headers.get("x-sepay-timestamp", "") or headers.get("X-Sepay-Timestamp", "")
        return _verify_hmac(env.sepay_webhook_secret, raw_body, sig, ts)
    # apikey (mặc định)
    if not env.sepay_apikey:
        logger.warning("[sepay] apikey chọn nhưng SEPAY_APIKEY trống → bỏ verify (demo)")
        return True
    auth = headers.get("authorization", "") or headers.get("Authorization", "")
    return auth == f"Apikey {env.sepay_apikey}"


def handle_topup(db: Session, code: str, event: SepayEvent, tolerance: int) -> bool:
    """Luồng NẠP (topup): khớp theo MÃ NẠP CỐ ĐỊNH của user (users.topup_code) → cộng
    ĐÚNG số tiền nhận được cho user (user 2026-07-14). QR nạp cố định theo user, không
    đổi → user chuyển bao nhiêu cộng bấy nhiêu, KHÔNG phụ thuộc "lệnh nạp" nào.

    Best-effort đánh dấu 1 lệnh nạp `pending` của user (khớp số tiền nhất) thành `paid`
    để modal FE thấy "đã nhận tiền" + gắn giao dịch vào lịch sử; không có lệnh nào (user
    dùng QR đã lưu) vẫn cộng bình thường. Chống cộng đúp dựa vào idempotency webhook
    (provider_txn_id / sepay_idem) ở router — mỗi giao dịch ngân hàng chỉ vào 1 lần.

    Fallback: mã lệnh nạp LEGACY (per-order ref_code) vẫn khớp TopupOrder cũ. Trả True
    nếu đã cộng, False nếu không nhận diện được mã (→ thử luồng khác / bỏ qua)."""
    paid = int(event.amount)

    user = db.execute(select(User).where(User.topup_code == code)).scalar_one_or_none()
    if user is not None:
        # Lệnh nạp pending KHỚP SỐ TIỀN NHẤT của user (ưu tiên đúng số tiền, rồi mới
        # nhất) — chỉ để phản hồi UI/lịch sử; việc cộng ví KHÔNG phụ thuộc lệnh này.
        order = (
            db.execute(
                select(TopupOrder)
                .where(TopupOrder.user_id == user.id, TopupOrder.status == "pending")
                .order_by(
                    func.abs(TopupOrder.amount_vnd - paid).asc(),
                    TopupOrder.created_at.desc(),
                )
            )
            .scalars()
            .first()
        )
        ref_id = str(order.id) if order is not None else code
        txn = wallet_service.credit_topup(
            db, user.id, paid, ref_id=ref_id, provider_txn_id=event.provider_txn_id
        )
        if order is not None:
            order.status = "paid"
            order.paid_amount_vnd = paid
            order.provider_txn_id = event.provider_txn_id
            order.paid_at = datetime.now(timezone.utc)
            order.transaction_id = txn.id
            db.add(order)
        db.flush()
        logger.info(
            "[sepay] topup(user-code) credited user=%s amount=%s order=%s",
            user.id, paid, order.id if order else "-",
        )
        return True

    # ── Fallback LEGACY: mã lệnh nạp cũ (per-order ref_code) ─────────────────────
    order = db.execute(
        select(TopupOrder).where(TopupOrder.ref_code == code)
    ).scalar_one_or_none()
    if order is None:
        logger.info("[sepay] topup: no user/order for code=%s", code)
        return False
    if abs(paid - int(order.amount_vnd)) > tolerance:
        logger.warning("[sepay] topup(legacy): amount mismatch order=%s exp=%s got=%s",
                       order.id, order.amount_vnd, event.amount)
        return False
    updated = db.execute(
        text("UPDATE topup_orders SET status='paid' WHERE id = :id AND status = 'pending'"),
        {"id": str(order.id)},
    ).rowcount
    if not updated:
        return True  # đã paid trước đó → idempotent, không cộng lần 2
    txn = wallet_service.credit_topup(
        db, order.user_id, paid, ref_id=str(order.id), provider_txn_id=event.provider_txn_id
    )
    order.paid_amount_vnd = paid
    order.provider_txn_id = event.provider_txn_id
    order.paid_at = datetime.now(timezone.utc)
    order.transaction_id = txn.id
    db.add(order)
    db.flush()
    logger.info("[sepay] topup(legacy) credited order=%s amount=%s user=%s", order.id, paid, order.user_id)
    return True


def _fulfill_order(db: Session, order: PaymentOrder) -> None:
    """Thực thi intent của hoá đơn ĐÃ được credit ví (bước 2). Trừ phí SAU khi tạo
    member/queue (invite) / áp gia hạn (renew). Import router lazy để tránh circular.

    QUAN TRỌNG (user 2026-07-13): gọi SAU khi credit ví. Nếu hàm này lỗi → phí CHƯA
    trừ → tiền QR đã credit ở lại ví (caller bắt exception, set fulfillment_error)."""
    # Lazy import: routers.members.* import services → tránh vòng import lúc load.
    from app.models import Member, User, Workspace
    from app.routers.members.invite import (
        _assert_email_ownership,
        _assert_seat_available,
        _charge_renewals,
        _count_new_invite_seats,
        _member_fees,
        perform_invite_core,
    )
    from app.routers.members.renew import perform_renew_core
    from app.routers.members.subscription import (
        perform_subscription_core,
        subscription_fee,
    )
    from app.routers.wallet._shared import get_payment_settings
    from app.schemas import MemberUpdateSubscriptionIn
    from app.services import payment_flow, wallet_service
    from app.sse import publish_task_event

    user = db.get(User, order.user_id) if order.user_id else None
    if user is None:
        raise ValueError("order user missing")
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)
    payload = order.payload or {}
    now = datetime.now(timezone.utc)

    if order.kind == "invite":
        ws = db.get(Workspace, order.workspace_id) if order.workspace_id else None
        if ws is None:
            raise ValueError("order workspace missing")
        role = str(payload.get("role") or "member")
        entries = [
            (str(e["email"]).lower(), e.get("subscription_months"))
            for e in payload.get("entries", [])
            if e.get("email")
        ]
        if not entries:
            raise ValueError("order has no invite entries")
        # Kiểm lại chủ-sở-hữu + seat TẠI THỜI ĐIỂM fulfillment. Khác endpoint: order
        # tạo lúc trả 402 CHƯA tạo Member nên email chưa bị khoá quyền sở hữu. Trong
        # cửa sổ chờ trả tiền (<5 phút), tài khoản KHÁC có thể đã mời cùng email
        # (chiếm quyền sở hữu) hoặc seat đã lấp đầy. Nếu bỏ qua, perform_invite_core
        # sẽ ghi đè `invited_by_user_id` (cướp email của người khác) / vượt trần seat.
        # Fail → raise (handle_order bắt → fulfillment_error, tiền QR ở lại ví, KHÔNG
        # tạo member/queue). Xem [[invite-owner-lock]].
        _assert_email_ownership(db, [e for e, _ in entries], user)
        # Chỉ đếm email chiếm seat MỚI (email active = gia hạn, không thêm seat).
        _assert_seat_available(
            db, ws, _count_new_invite_seats(db, ws.id, [e for e, _ in entries]), user
        )
        single = len(entries) == 1
        # Giữ đúng hành vi mời-lại (cờ do endpoint re-invite gắn vào order payload):
        # extension chạy tiền tố tìm-thu-hồi + quy tắc miễn phí còn-hạn khi replay.
        reinvite = bool(payload.get("reinvite"))
        queue_item, _members, chargeable, renew_members = perform_invite_core(
            db, user, ws, entries, role, single=single, reinvite=reinvite
        )
        email_fees = _member_fees(user, chargeable, default_fee)
        if email_fees and queue_item is not None:
            wallet_service.charge_invite(db, user, queue_item.id, email_fees)
        # Gia hạn email đang active (nếu order gộp cả gia hạn) — phí renew per member.
        _charge_renewals(db, user, renew_members, default_fee)
        # Toàn gia hạn → không có task ChatGPT (queue_item None) → không publish event.
        if queue_item is not None:
            order.queue_item_id = queue_item.id
            publish_task_event(
                ws.id,
                {"type": "task-available", "task_id": str(queue_item.id), "task_type": "INVITE_MEMBER"},
            )
        order.fulfilled_at = now
        db.flush()
    elif order.kind == "renew":
        member = db.get(Member, UUID(str(payload["member_id"]))) if payload.get("member_id") else None
        if member is None:
            raise ValueError("order member missing")
        months = int(payload["months"])
        # Phí = đơn giá/tháng × số tháng — KHỚP amount đã tạo ở _create_renew_order
        # (nếu chỉ trừ phí phẳng, phần tiền QR dư months−1 sẽ kẹt lại trong ví).
        fee = payment_flow.effective_fee_for_months(
            member.fee_vnd, user, default_fee, months
        )
        perform_renew_core(db, user, member, months)
        if fee > 0:
            wallet_service.charge_renew(db, user, member.id, fee, email=member.email)
        order.member_id = member.id
        order.fulfilled_at = now
        db.flush()
    elif order.kind == "subscription":
        member = db.get(Member, UUID(str(payload["member_id"]))) if payload.get("member_id") else None
        if member is None:
            raise ValueError("order member missing")
        body = MemberUpdateSubscriptionIn(
            subscription_months=payload.get("subscription_months"),
            subscription_purchased_at=payload.get("subscription_purchased_at"),
            subscription_end_at=payload.get("subscription_end_at"),
        )
        # Tính lại phí tại thời điểm áp (member có thể đã đổi hạn giữa chừng). Phí =
        # đơn giá/tháng × số tháng kéo dài (subscription_fee), 0 nếu không kéo dài.
        fee = subscription_fee(member, user, default_fee, body)
        perform_subscription_core(db, user, member, body)
        if fee > 0:
            wallet_service.charge_renew(db, user, member.id, fee, email=member.email)
        order.member_id = member.id
        order.fulfilled_at = now
        db.flush()
    else:
        raise ValueError(f"unknown order kind {order.kind!r}")


def handle_order(db: Session, ref_code: str, event: SepayEvent, tolerance: int) -> bool:
    """Luồng ORDER (hoá đơn mời/gia hạn): khớp PaymentOrder theo ref_code → nạp ví →
    thực thi intent. Trả True nếu đã xử lý (hoặc đã paid trước đó), False nếu KHÔNG
    khớp/lệch tiền (→ "nạp thất bại, không làm gì" — order giữ pending).

    Nguyên tắc user 2026-07-13: chỉ nạp THÀNH CÔNG (đúng order + đúng số tiền) mới
    thực thi. Thứ tự: credit ví TRƯỚC → _fulfill_order (trừ phí) SAU → action lỗi thì
    tiền QR ở lại ví (fulfillment_error)."""
    from app.services import wallet_service  # lazy: tránh vòng import lúc load
    from app.services.payment_flow import is_order_expired

    order = db.execute(
        select(PaymentOrder).where(PaymentOrder.ref_code == ref_code)
    ).scalar_one_or_none()
    if order is None:
        logger.info("[sepay] order: no order for code=%s", ref_code)
        return False
    if order.user_id is None:
        logger.warning("[sepay] order=%s mồ côi (user_id NULL) → bỏ qua", order.id)
        return False
    if abs(int(event.amount) - int(order.amount_vnd)) > tolerance:
        logger.warning(
            "[sepay] order amount mismatch order=%s exp=%s got=%s → nạp thất bại, không xử lý",
            order.id, order.amount_vnd, event.amount,
        )
        return False  # KHÔNG credit, KHÔNG thực thi, order giữ pending

    paid = int(event.amount)

    if order.paid_amount_vnd is not None or order.status == "paid":
        # Hoá đơn NÀY đã được thanh toán trước đó. Nếu webhook này là CÙNG giao dịch
        # ngân hàng đã credit (provider_txn_id trùng) → idempotent thật, bỏ qua. Nhưng
        # nếu là GIAO DỊCH KHÁC (user quét lại QR đã lưu / chuyển 2 lần) thì đây là
        # THANH TOÁN TRÙNG HOÁ ĐƠN: KHÔNG thực thi lại intent, mà cộng thẳng vào ví
        # dạng nạp tiền + cờ trùng hoá đơn để tiền không bị mất (user 2026-07-27).
        # (idempotency `sepay_idem` chỉ chặn retry CÙNG txn — khoản trùng txn khác lọt
        # tới đây.)
        same_txn = bool(
            event.provider_txn_id
            and order.provider_txn_id
            and event.provider_txn_id == order.provider_txn_id
        )
        if same_txn:
            return True  # cùng 1 giao dịch NH → đã credit rồi, không cộng lần 2
        wallet_service.credit_duplicate_invoice(
            db,
            order.user_id,
            paid,
            order_id=str(order.id),
            order_ref=ref_code,
            provider_txn_id=event.provider_txn_id,
        )
        db.flush()
        logger.info(
            "[sepay] order=%s đã paid — THANH TOÁN TRÙNG HOÁ ĐƠN, cộng ví %s (txn=%s)",
            order.id, paid, event.provider_txn_id,
        )
        return True

    # HẾT HẠN (>5 phút hoặc đã bị đánh dấu expired): mã QR không còn thực thi (user
    # 2026-07-13: "mã chỉ tồn tại 5 phút"). Tiền chuyển trễ VẪN credit vào ví để KHÔNG
    # mất — user dùng số dư mời/gia hạn lại. Guard `paid_amount_vnd IS NULL` → credit 1 lần.
    if order.status == "expired" or is_order_expired(order):
        updated = db.execute(
            text(
                "UPDATE payment_orders SET status='expired', paid_amount_vnd=:p, paid_at=now(), "
                "provider_txn_id=:tx WHERE id=:id AND paid_amount_vnd IS NULL"
            ),
            {"p": paid, "tx": event.provider_txn_id, "id": str(order.id)},
        ).rowcount
        if not updated:
            return True  # webhook khác đã credit
        db.refresh(order)
        txn = wallet_service.credit_order_payment(
            db, order.user_id, paid, ref_id=str(order.id), provider_txn_id=event.provider_txn_id
        )
        order.transaction_id = txn.id
        db.add(order)
        db.flush()
        logger.info("[sepay] order=%s HẾT HẠN → credit ví %s (không thực thi mã cũ)", order.id, paid)
        return True

    # Chốt pending→paid nguyên tử (chống 2 webhook cùng lúc credit 2 lần).
    updated = db.execute(
        text("UPDATE payment_orders SET status='paid' WHERE id = :id AND status = 'pending'"),
        {"id": str(order.id)},
    ).rowcount
    if not updated:
        return True  # đã paid song song → idempotent
    db.refresh(order)

    # Bước 1 — credit ví số tiền nhận (đảm bảo balance đủ trừ phí ở bước 2).
    txn = wallet_service.credit_order_payment(
        db, order.user_id, paid, ref_id=str(order.id), provider_txn_id=event.provider_txn_id
    )
    order.paid_amount_vnd = paid
    order.provider_txn_id = event.provider_txn_id
    order.paid_at = datetime.now(timezone.utc)
    order.transaction_id = txn.id

    # Bước 2 — thực thi mời/gia hạn + trừ phí. Lỗi → giữ tiền trong ví.
    try:
        _fulfill_order(db, order)
    except Exception as e:  # noqa: BLE001 — webhook luôn trả 200; ghi lỗi vào order
        logger.exception("[sepay] order=%s đã nạp nhưng thực thi lỗi", order.id)
        order.fulfillment_error = str(e)[:500]
    db.add(order)
    db.flush()
    logger.info("[sepay] order handled order=%s kind=%s amount=%s user=%s",
                order.id, order.kind, paid, order.user_id)
    return True


def process_multiflow_webhook(db: Session, headers: dict, raw_body: bytes, body: dict, settings_row: PaymentSettings) -> dict:
    """Xử lý 1 webhook SePay theo cấu trúc mã ĐA LUỒNG. Luôn trả dict (HTTP 200).

    Xác thực theo `settings_row.sepay_auth_method` (none/apikey/hmac). HMAC cần
    `raw_body` (bytes gốc) để tính chữ ký khớp byte-for-byte.
    """
    if not _verify_auth(settings_row, headers, raw_body):
        logger.warning("[sepay] auth fail (method=%s)", settings_row.sepay_auth_method)
        return {"success": False, "error": "Unauthorized"}

    parsed = normalize_sepay_payload(body)
    amount = parsed.get("amount", 0.0)
    content = parsed.get("content", "")
    if parsed.get("is_test"):
        return {"success": True, "note": "test ipn accepted"}
    if not parsed.get("is_incoming", True):
        return {"success": True, "note": "ignored - outgoing transfer"}
    if amount <= 0:
        return {"success": True, "note": "ignored - non-positive amount"}
    if "order_invoice_number" in body and body.get("status") not in (None, "SUCCESS"):
        return {"success": True, "note": f"ignored pg status={body.get('status')}"}

    store = PgIdemStore(db)
    idem = build_idempotency_key(body, parsed)
    if idem and store.seen(idem):
        return {"success": True, "note": "duplicate"}

    tolerance = int(settings_row.amount_tolerance_vnd or 1000)
    event = SepayEvent(
        amount=amount, content=content, code=None,
        provider_txn_id=parsed.get("provider_txn_id", ""),
        idempotency_key=idem or "", currency=parsed.get("currency", "VND"),
        raw=body, parsed=parsed,
    )

    # Thử khớp từng luồng ĐANG BẬT theo tiền tố (topup trước để ưu tiên nạp ví).
    flows = settings_row.payment_codes or []
    for flow in sorted(flows, key=lambda f: 0 if f.get("key") == "topup" else 1):
        if not flow.get("enabled", True):
            continue
        prefix = str(flow.get("prefix") or "")
        smin = int(flow.get("suffix_min", 3))
        smax = int(flow.get("suffix_max", 30))
        # Kiểu hậu tố: numeric = chỉ số; mặc định alphanumeric = số & chữ.
        char_class = r"\d" if flow.get("suffix_type") == "numeric" else r"[A-Za-z0-9]"
        code = extract_prefixed_code(content, prefix, id_pattern=rf"{char_class}{{{smin},{smax}}}")
        if not code:
            continue
        event.code = code
        key = flow.get("key")
        if key == "topup":
            ok = handle_topup(db, code, event, tolerance)
        elif key == "order":
            ok = handle_order(db, code, event, tolerance)
        else:
            logger.warning("[sepay] flow=%s prefix=%s matched code=%s nhưng CHƯA có consumer", key, prefix, code)
            return {"success": True, "note": f"flow '{key}' recognized but not handled"}
        if not ok:
            return {"success": True, "note": "handler declined"}
        if idem:
            store.mark(idem)
        return {"success": True}

    return {"success": True, "note": "no recognized code in content"}
