"""Ví — ĐỐI SOÁT NGÂN HÀNG: dữ liệu SePay báo về, xếp theo ngày.

Trả lời câu hỏi mà sổ cái ví không trả lời được: "hôm nay ngân hàng nhận bao nhiêu, vào
ví bao nhiêu, phần chênh kẹt ở đâu". `wallet_transactions` chỉ ghi tiền ĐÃ vào ví — khoản
khách chuyển sai nội dung hoặc lệch số tiền bị webhook từ chối thì không để lại vết nào
(user 2026-08-26). Nguồn ở đây là `sepay_webhook_events`, ghi cả dòng bị từ chối.

  • `GET  /wallet/sepay-events?date=` — super-admin thấy TOÀN BỘ tiền vào; user thường
    chỉ thấy giao dịch khớp đúng mã nạp/hoá đơn của mình (nội dung CK của người khác
    không phải chuyện của họ).
  • `POST /wallet/admin/sepay/sync`  — super-admin kéo sao kê từ API SePay về, dựng lại
    ngày cũ và bắt khoản ngân hàng đã nhận mà webhook không tới.
"""

from __future__ import annotations

from datetime import date as date_type
from datetime import datetime

from fastapi import Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.deps import get_session, require_super_admin, require_wallet_enabled
from app.models import SepayWebhookEvent, User, WalletTransaction
from app.schemas import SepayDayOut, SepayEventOut, SepaySyncIn, SepaySyncOut
from app.sepay import userapi
from app.services import sepay_ledger

from ._shared import get_payment_settings, router


@router.get("/sepay-events", response_model=SepayDayOut)
def sepay_events(
    date: date_type | None = Query(None, description="Ngày cần đối soát (YYYY-MM-DD, giờ VN)."),
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> SepayDayOut:
    target = date or datetime.now(sepay_ledger.VN_TZ).date()
    is_admin = bool(user.is_super_admin)
    rows = sepay_ledger.events_for_day(db, target, user_id=None if is_admin else user.id)

    incoming = [r for r in rows if (r.transfer_type or "in") == "in"]
    credited = [r for r in incoming if r.result in sepay_ledger.CREDITED_RESULTS]
    # "Chờ xử lý" = tiền vào chưa thành số dư. `duplicate` KHÔNG nằm ở đây: đó là webhook
    # lặp của khoản đã cộng, cộng tiếp là nhân đôi tiền. `ignored` cũng không (tiền ra /
    # IPN test). Còn lại — declined, unmatched, bank_only, error — đều là tiền thật đang
    # kẹt, phải hiện lên để có người xử lý.
    pending = [
        r for r in incoming
        if r.result in ("declined", "unmatched", "bank_only", "error", "unauthorized")
    ]
    return SepayDayOut(
        date=target.isoformat(),
        received_total=sum(r.amount for r in incoming),
        credited_total=sum(r.amount for r in credited),
        pending_total=sum(r.amount for r in pending),
        received_count=len(incoming),
        credited_count=len(credited),
        pending_count=len(pending),
        empty=not rows,
        is_admin_view=is_admin,
        can_sync=bool(get_settings().sepay_user_api_token) and is_admin,
        events=[SepayEventOut.model_validate(r) for r in rows],
    )


def _wallet_credit_for(db: Session, provider_txn_id: str) -> WalletTransaction | None:
    """Bút toán ví đã ghi nhận ĐÚNG giao dịch ngân hàng này (dò `meta.provider_txn_id`).

    Dùng khi dựng lại ngày cũ: sổ nhận tiền mới có từ 26/8/2026, nhưng `provider_txn_id`
    thì đã được nhét vào `meta` của mọi khoản nạp/hoá đơn từ đầu. Nhờ vậy sao kê kéo về
    vẫn nói được "khoản này đã vào ví của ai", thay vì cả loạt "không rõ".
    """
    if not provider_txn_id:
        return None
    return db.execute(
        select(WalletTransaction)
        .where(WalletTransaction.meta["provider_txn_id"].astext == str(provider_txn_id))
        .order_by(WalletTransaction.seq.asc())
        .limit(1)
    ).scalar_one_or_none()


@router.post("/admin/sepay/sync", response_model=SepaySyncOut)
def sepay_sync(
    body: SepaySyncIn,
    db: Session = Depends(get_session),
    _admin: User = Depends(require_super_admin),
) -> SepaySyncOut:
    """Kéo sao kê ngân hàng từ API SePay về sổ nhận tiền (super-admin).

    KHÔNG đụng số dư ví: đây là việc ĐỐI SOÁT, không phải cộng tiền. Dòng nào dò được
    vết trong sổ cái ví thì đánh `credited` kèm chủ nhân; dòng tiền vào không có vết
    nào thì để `bank_only` — chính là danh sách cần soi tay.
    """
    env = get_settings()
    if not env.sepay_user_api_token:
        raise HTTPException(
            400,
            "Chưa cấu hình SEPAY_USER_API_TOKEN trên server — thêm vào .env rồi khởi động lại API.",
        )
    try:
        date_from = date_type.fromisoformat(body.date_from)
        date_to = date_type.fromisoformat(body.date_to)
    except ValueError:
        raise HTTPException(400, "Ngày phải ở dạng YYYY-MM-DD") from None
    if date_to < date_from:
        raise HTTPException(400, "Khoảng ngày không hợp lệ (đến < từ)")

    settings_row = get_payment_settings(db)
    try:
        rows = userapi.fetch_transactions(
            token=env.sepay_user_api_token,
            base=env.sepay_user_api_base,
            date_from=date_from.isoformat(),
            date_to=date_to.isoformat(),
            account_number=settings_row.account_number or "",
        )
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from e

    created = updated = matched = bank_only = 0
    for raw in rows:
        parsed = userapi.to_parsed(raw)
        txn_id = parsed["provider_txn_id"]
        key = f"sepay:{txn_id}" if txn_id else ""
        existed = (
            db.execute(
                select(SepayWebhookEvent.id).where(SepayWebhookEvent.key == key)
            ).scalar_one_or_none()
            if key
            else None
        )

        result, note, owner = "ignored", "giao dịch tiền ra", None
        if parsed["is_incoming"]:
            credit = _wallet_credit_for(db, txn_id)
            if credit is not None:
                result, note, owner = "credited", "dựng lại từ sao kê — đã có trong ví", credit.user_id
                matched += 1
            else:
                result, note = "bank_only", "ngân hàng đã nhận nhưng KHÔNG thấy vết trong ví"
                bank_only += 1

        sepay_ledger.record_event(
            db,
            key=key,
            source="userapi",
            parsed=parsed,
            raw=raw,
            result=result,
            note=note,
            user_id=owner,
            bank_time=_statement_time(raw),
        )
        if existed:
            updated += 1
        else:
            created += 1

    db.commit()
    return SepaySyncOut(
        date_from=date_from.isoformat(),
        date_to=date_to.isoformat(),
        fetched=len(rows),
        created=created,
        updated=updated,
        matched_to_wallet=matched,
        bank_only=bank_only,
    )


def _statement_time(raw: dict) -> datetime | None:
    """`transaction_date` của sao kê ("YYYY-MM-DD HH:MM:SS", giờ VN) → datetime aware."""
    value = str(raw.get("transaction_date") or "").strip().replace("T", " ")[:19]
    if not value:
        return None
    try:
        naive = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return naive.replace(tzinfo=sepay_ledger.VN_TZ)
