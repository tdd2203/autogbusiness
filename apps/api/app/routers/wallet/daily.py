"""Ví — Báo cáo TRONG NGÀY của chính user: đã thêm bao nhiêu email, tiêu bao nhiêu.

Chỉ ĐỌC, không ghi gì. Trả số liệu của MỘT ngày theo lịch VIỆT NAM (UTC+7, không
DST) — mặc định hôm nay:

  • `emails_added`  = số email do user này thêm trong ngày và CÒN trong team, lấy
    mốc "ngày thêm" y như tab *Email đã thêm*: COALESCE(last_invited_at,
    created_at). Email bị gỡ (mời hỏng, thu hồi, admin xoá…) đếm riêng ở
    `emails_removed` để con số chính không bị thổi phồng bởi lượt mời thất bại.
  • `invite_count` = TỔNG lời mời tính phí trong ngày, đếm theo EMAIL: mỗi email là
    một lời mời và có một bút toán `invite_fee` riêng, dán 5 email trong một lần bấm
    vẫn là 5 lời mời (user 2026-08-27). Trừ đi `refunded_invite_count` ra số lời mời
    THÀNH CÔNG — đó là cặp số thẻ "Mời" ở trang Ví hiện. Thẻ KHÔNG đọc `emails_added`:
    mời lại email CÒN HẠN thì miễn phí nhưng vẫn đẩy `last_invited_at` sang ngày mới
    nên `emails_added` đếm cả lượt không tốn đồng nào.
  • Phần giao dịch tách theo NGUỒN TIỀN thay vì cộng dồn có dấu: một lượt mời trả
    qua hoá đơn ghi 2 bút toán cùng lúc (order_topup +X, invite_fee −X) nên tổng
    có dấu = 0 dù user vẫn tiêu X. Vì vậy `fee_total` là TOÀN BỘ phí phát sinh,
    còn `fee_from_invoice` / `fee_from_balance` cho biết tiền ra từ đâu.
  • `new_email_count` / `renew_email_count` = cặp số "New / Renew" ở tiêu đề ngày
    trong lịch sử ví, chia theo EMAIL chứ không theo loại bút toán: New = email
    chưa từng trả tiền thành công lần nào, Renew = email cũ trả tiếp (gia hạn,
    hoặc hết hạn rồi add lại — lượt này vẫn đi qua `invite_fee` nên phân loại
    theo `kind` sẽ đếm nhầm thành email mới).
  • Lượt mời HỎNG đã hoàn phí thì user KHÔNG mất đồng nào, nhưng bút toán phí vẫn
    nằm đó (cờ `reversed`) — cộng vào "đã tiêu" là thổi phồng con số rồi lại phải
    tự trừ nhẩm phần hoàn ở ô khác (user 2026-08-26: "khó nhìn khó hiểu"). Nên
    `fee_net` = THỰC CHI (đã trừ phần hoàn) mới là số chính, `fee_refunded` +
    `refunded_invite_count` kể riêng phần hỏng, và `fee_from_invoice` /
    `fee_from_balance` chỉ tách nguồn tiền của phần CÒN HIỆU LỰC.
"""

from __future__ import annotations

from datetime import date as date_type
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_session, require_super_admin, require_wallet_enabled
from app.models import Member, User, WalletTransaction
from app.schemas import WalletDailyKindOut, WalletDailySummaryOut

from ._shared import router

# VN không có DST → offset cứng là đủ (giống AUTO_SYNC_TZ ở main.py).
VN_TZ = timezone(timedelta(hours=7))

# Bút toán tính là "phí đã tiêu trong ngày" (mời lần đầu + gia hạn).
_FEE_KINDS = ("invite_fee", "renew_fee")


def _fee_email(row) -> str:
    """Email của bút toán phí (chữ thường). `meta.email` do charge_invite/charge_renew
    ghi; dòng cũ thiếu meta → chuỗi rỗng, coi như không đối chiếu được."""
    meta = row[4] or {}
    return str(meta.get("email") or "").lower()


def _summary_for(db: Session, user_id: UUID, date: date_type | None) -> WalletDailySummaryOut:
    """Thân chung của báo cáo ngày. Tách ra vì trang Quản trị Ví hiện ĐÚNG giao diện
    trang Ví cho tài khoản người khác — hai thẻ tổng kết ngày phải tính y hệt, không
    được chép lại một bản gần giống rồi lệch số (user 2026-08-29)."""
    target = date or datetime.now(VN_TZ).date()
    start = datetime.combine(target, time.min, tzinfo=VN_TZ)
    end = start + timedelta(days=1)

    # ── Email đã thêm trong ngày ───────────────────────────────────────────
    added_at = func.coalesce(Member.last_invited_at, Member.created_at)
    member_rows = db.execute(
        select(Member.status, func.count())
        .where(
            Member.invited_by_user_id == user_id,
            added_at >= start,
            added_at < end,
        )
        .group_by(Member.status)
    ).all()
    emails_added = sum(n for status, n in member_rows if status != "removed")
    emails_removed = sum(n for status, n in member_rows if status == "removed")

    # ── Giao dịch trong ngày ───────────────────────────────────────────────
    # Lấy dòng thô (không GROUP BY) vì cần cờ `reversed` của TỪNG phí và cần gom
    # theo `created_at` để biết phí nào trả bằng hoá đơn. Một user trong 1 ngày chỉ
    # cỡ vài trăm bút toán nên rẻ.
    rows = db.execute(
        select(
            WalletTransaction.kind,
            WalletTransaction.amount,
            WalletTransaction.reversed,
            WalletTransaction.created_at,
            WalletTransaction.meta,
            WalletTransaction.seq,
        )
        .where(
            WalletTransaction.user_id == user_id,
            WalletTransaction.created_at >= start,
            WalletTransaction.created_at < end,
        )
        .order_by(WalletTransaction.seq)
    ).all()

    per_kind: dict[str, list[int]] = {}
    for kind, amount, _reversed, _at, _meta, _seq in rows:
        acc = per_kind.setdefault(kind, [0, 0])
        acc[0] += 1
        acc[1] += int(amount)
    by_kind = [
        WalletDailyKindOut(kind=kind, count=acc[0], amount=acc[1])
        for kind, acc in sorted(per_kind.items())
    ]

    def total(kind: str) -> int:
        return per_kind.get(kind, [0, 0])[1]

    def count_of(kind: str) -> int:
        return per_kind.get(kind, [0, 0])[0]

    fee_rows = [r for r in rows if r[0] in _FEE_KINDS]
    fee_total = -sum(int(r[1]) for r in fee_rows)  # bút toán phí âm → đổi dấu
    fee_refunded = -sum(int(r[1]) for r in fee_rows if r[2])
    fee_net = fee_total - fee_refunded
    refunded_invite_count = sum(1 for r in fee_rows if r[0] == "invite_fee" and r[2])

    # ── New / Renew: email LẦN ĐẦU trả tiền vs email CŨ trả tiếp ──────────
    # New = email chưa từng có lượt thu phí thành công nào trước đó. Renew = email
    # cũ nay lại trả tiền, gồm cả gia hạn lẫn email hết hạn được add lại. Trước
    # đây trang Ví phân loại theo LOẠI bút toán nên mọi `invite_fee` đều là New,
    # email cũ add lại bị đếm như email mới toanh (user 2026-08-28).
    #
    # Mốc phân biệt là SỔ CÁI chứ không phải bản ghi member: lượt mời hỏng đã
    # hoàn phí thì không tính là "đã từng add" (email chưa vào team lần nào và
    # cũng chưa tốn đồng nào) → mời lại nó vẫn là New. Ngược lại, email trả tiền
    # thành công rồi thì mọi lượt trả sau đó đều là Renew, kể cả khi lượt sau đi
    # qua luồng mời mới (`invite_fee`) vì gói cũ đã hết hạn.
    live_fees = [r for r in rows if r[0] in _FEE_KINDS and not r[2]]
    emails = {_fee_email(r) for r in live_fees} - {""}
    first_seq: dict[str, int] = {}
    if emails:
        email_col = func.lower(WalletTransaction.meta["email"].astext)
        first_seq = {
            e: seq
            for e, seq in db.execute(
                select(email_col, func.min(WalletTransaction.seq))
                .where(
                    WalletTransaction.user_id == user_id,
                    WalletTransaction.kind.in_(_FEE_KINDS),
                    WalletTransaction.reversed.is_(False),
                    # Chặn trên = hết ngày đang xem: báo cáo ngày cũ không được đổi
                    # nghĩa vì những lượt trả tiền xảy ra SAU đó.
                    WalletTransaction.created_at < end,
                    email_col.in_(sorted(emails)),
                )
                .group_by(email_col)
            ).all()
        }
    new_email_count = 0
    renew_email_count = 0
    for r in live_fees:
        email = _fee_email(r)
        # `renew_fee` luôn là gia hạn, kể cả email add từ trước khi có ví (không có
        # bút toán nào cũ hơn để đối chiếu nên quy tắc "lần đầu" sẽ nhận nhầm).
        if r[0] == "renew_fee" or (email and first_seq.get(email) != r[5]):
            renew_email_count += 1
        else:
            new_email_count += 1

    # Tiền hoá đơn về ví (order_topup) luôn được tiêu ngay cho lượt mời/gia hạn CÙNG
    # THỜI ĐIỂM (một transaction = một mốc `created_at`) → đó chính là phần phí KHÔNG
    # trừ số dư. Ghép theo từng mốc thay vì so tổng cả ngày: lượt hỏng đã hoàn thì
    # tiền hoá đơn của nó Ở LẠI trong ví, không được tính là "đã tiêu qua hoá đơn".
    invoice_at: dict[datetime, int] = {}
    live_fee_at: dict[datetime, int] = {}
    for kind, amount, was_reversed, at, _meta, _seq in rows:
        if kind == "order_topup":
            invoice_at[at] = invoice_at.get(at, 0) + int(amount)
        elif kind in _FEE_KINDS and not was_reversed:
            live_fee_at[at] = live_fee_at.get(at, 0) - int(amount)
    # Kẹp trong [0, phí còn hiệu lực của mốc đó] phòng dữ liệu lệch (trả dư/thiếu).
    fee_from_invoice = sum(
        max(0, min(invoice_at.get(at, 0), live))
        for at, live in live_fee_at.items()
    )
    return WalletDailySummaryOut(
        date=target.isoformat(),
        emails_added=emails_added,
        emails_removed=emails_removed,
        txn_count=len(rows),
        fee_total=fee_total,
        fee_refunded=fee_refunded,
        fee_net=fee_net,
        fee_from_invoice=fee_from_invoice,
        fee_from_balance=fee_net - fee_from_invoice,
        invite_count=count_of("invite_fee"),
        refunded_invite_count=refunded_invite_count,
        renew_count=count_of("renew_fee"),
        new_email_count=new_email_count,
        renew_email_count=renew_email_count,
        topup_total=total("topup"),
        refund_total=total("invite_refund"),
        by_kind=by_kind,
    )


@router.get("/daily-summary", response_model=WalletDailySummaryOut)
def daily_summary(
    date: date_type | None = Query(
        None, description="Ngày cần xem (YYYY-MM-DD, giờ VN). Bỏ trống = hôm nay."
    ),
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> WalletDailySummaryOut:
    return _summary_for(db, user.id, date)


@router.get("/admin/users/{user_id}/daily-summary", response_model=WalletDailySummaryOut)
def admin_daily_summary(
    user_id: UUID,
    date: date_type | None = Query(
        None, description="Ngày cần xem (YYYY-MM-DD, giờ VN). Bỏ trống = hôm nay."
    ),
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> WalletDailySummaryOut:
    """Cùng báo cáo ngày, nhưng cho MỘT tài khoản bất kỳ (super-admin)."""
    return _summary_for(db, user_id, date)
