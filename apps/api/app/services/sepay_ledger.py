"""Sổ nhận tiền thô SePay — ghi/nâng cấp `sepay_webhook_events`, đọc theo NGÀY VN.

Một giao dịch ngân hàng = một dòng, khoá theo `key` (idempotency key của SePay). Hai
nguồn cùng đổ vào một dòng:

  • `webhook`  — SePay bắn tới lúc tiền về (ghi cả khi handler TỪ CHỐI).
  • `userapi`  — mình chủ động kéo sao kê về (`/wallet/admin/sepay/sync`), dùng để dựng
    lại ngày cũ và để bắt khoản KHÔNG có webhook (result `bank_only`).

Quy tắc nâng cấp: dòng đã có KẾT LUẬN thật (webhook đã xử lý) thì sao kê kéo về sau
KHÔNG được ghi đè kết luận đó — chỉ bù các ô còn trống (giờ ngân hàng, tên bank, số
tài khoản). Ngược lại, webhook tới sau khi đã có dòng `bank_only` thì ghi đè kết luận,
vì đó mới là điều thực sự xảy ra với tiền.
"""

from __future__ import annotations

from datetime import date as date_type
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import SepayWebhookEvent

# VN không DST → offset cứng (giống routers/wallet/daily.py).
VN_TZ = timezone(timedelta(hours=7))

#: Kết luận nghĩa là "tiền đã được ghi nhận vào ví".
CREDITED_RESULTS = ("credited", "dup_invoice")


def day_bounds(target: date_type) -> tuple[datetime, datetime]:
    """[đầu ngày, đầu ngày sau) theo giờ VN, dạng aware UTC-offset."""
    start = datetime.combine(target, time.min, tzinfo=VN_TZ)
    return start, start + timedelta(days=1)


def record_event(
    db: Session,
    *,
    key: str,
    source: str,
    parsed: dict,
    raw: dict,
    result: str,
    note: str | None = None,
    flow: str | None = None,
    code: str | None = None,
    user_id: UUID | None = None,
    bank_time: datetime | None = None,
) -> SepayWebhookEvent:
    """Ghi (hoặc nâng cấp) 1 dòng sổ nhận tiền. KHÔNG commit — caller lo.

    `key` rỗng vẫn ghi được: sinh khoá thay thế theo `source` + txn id + nội dung, để
    giao dịch lạ không có txn id cũng không rơi mất khỏi bảng đối soát.
    """
    txn_id = str(parsed.get("provider_txn_id") or "") or None
    if not key:
        key = f"{source}:{txn_id or ''}:{parsed.get('amount', 0)}:{parsed.get('content', '')}"[:128]

    row = db.execute(
        select(SepayWebhookEvent).where(SepayWebhookEvent.key == key)
    ).scalar_one_or_none()
    fields = dict(
        source=source,
        provider_txn_id=txn_id,
        amount=int(round(float(parsed.get("amount") or 0))),
        content=str(parsed.get("content") or "") or None,
        transfer_type=str(parsed.get("transfer_type") or ("in" if parsed.get("is_incoming", True) else "out")),
        account_number=str(parsed.get("account_number") or "") or None,
        bank=str(parsed.get("bank") or "") or None,
        payload_format=str(parsed.get("format") or "") or None,
        flow=flow,
        code=code,
        user_id=user_id,
        result=result,
        note=(note or None) and str(note)[:200],
        bank_time=bank_time,
        raw=raw or None,
    )
    if row is None:
        row = SepayWebhookEvent(key=key, **fields)
        db.add(row)
        db.flush()
        return row

    # Đã có dòng thì KHÔNG được hạ cấp kết luận. Hai đường hạ cấp:
    #   • sao kê (userapi) kéo về sau — nó chỉ thấy "tiền vào ngân hàng", không biết
    #     webhook đã cộng ví hay chưa; ghi đè là mất kết luận thật.
    #   • webhook LẶP (result='duplicate') — lần lặp không phải chuyện xảy ra với tiền,
    #     tiền đã vào ví ở lần đầu. Ghi đè thì đối soát báo "đã vào ví 0đ" trong khi ví
    #     đã cộng đủ.
    # Một giao dịch ngân hàng = một dòng, mang kết luận của thứ THỰC SỰ xảy ra với tiền.
    downgrade = (source == "userapi" and row.result != "bank_only") or (
        result == "duplicate" and row.result != "duplicate"
    )
    for name, value in fields.items():
        if downgrade and name in ("result", "note", "flow", "code", "user_id", "source", "raw"):
            continue
        if value is None and getattr(row, name) is not None:
            continue  # nguồn mới không biết ô này → giữ nguyên ô cũ
        setattr(row, name, value)
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.flush()
    return row


def events_for_day(
    db: Session, target: date_type, *, user_id: UUID | None = None
) -> list[SepayWebhookEvent]:
    """Giao dịch của NGÀY VN `target`, mới→cũ.

    Mốc ngày = `bank_time` (giờ ngân hàng) khi có, không thì `received_at`. Hai cột
    lệch nhau khi SePay retry muộn hoặc khi mình kéo sao kê ngày cũ về hôm nay — lấy
    giờ ngân hàng mới đúng nghĩa "tiền về ngày nào".

    `user_id` khác None ⇒ chỉ trả dòng đã khớp về đúng user đó (dòng chưa khớp ai
    KHÔNG lọt ra: nội dung CK của người khác không phải chuyện của họ).
    """
    start, end = day_bounds(target)
    stamp = SepayWebhookEvent.bank_time
    in_day = or_(
        stamp.is_not(None) & (stamp >= start) & (stamp < end),
        stamp.is_(None)
        & (SepayWebhookEvent.received_at >= start)
        & (SepayWebhookEvent.received_at < end),
    )
    q = select(SepayWebhookEvent).where(in_day)
    if user_id is not None:
        q = q.where(SepayWebhookEvent.user_id == user_id)
    q = q.order_by(
        SepayWebhookEvent.bank_time.desc().nullslast(),
        SepayWebhookEvent.received_at.desc(),
    )
    return list(db.execute(q).scalars().all())
