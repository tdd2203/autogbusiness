"""Ví — Báo cáo TRONG NGÀY của chính user: đã thêm bao nhiêu email, tiêu bao nhiêu.

Chỉ ĐỌC, không ghi gì. Trả số liệu của MỘT ngày theo lịch VIỆT NAM (UTC+7, không
DST) — mặc định hôm nay:

  • `emails_added`  = số email do user này thêm trong ngày và CÒN trong team, lấy
    mốc "ngày thêm" y như tab *Email đã thêm*: COALESCE(last_invited_at,
    created_at). Email bị gỡ (mời hỏng, thu hồi, admin xoá…) đếm riêng ở
    `emails_removed` để con số chính không bị thổi phồng bởi lượt mời thất bại.
  • Phần giao dịch tách theo NGUỒN TIỀN thay vì cộng dồn có dấu: một lượt mời trả
    qua hoá đơn ghi 2 bút toán cùng lúc (order_topup +X, invite_fee −X) nên tổng
    có dấu = 0 dù user vẫn tiêu X. Vì vậy `fee_total` là TOÀN BỘ phí phát sinh,
    còn `fee_from_invoice` / `fee_from_balance` cho biết tiền ra từ đâu.
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

from fastapi import Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_session, require_wallet_enabled
from app.models import Member, User, WalletTransaction
from app.schemas import WalletDailyKindOut, WalletDailySummaryOut

from ._shared import router

# VN không có DST → offset cứng là đủ (giống AUTO_SYNC_TZ ở main.py).
VN_TZ = timezone(timedelta(hours=7))

# Bút toán tính là "phí đã tiêu trong ngày" (mời lần đầu + gia hạn).
_FEE_KINDS = ("invite_fee", "renew_fee")


@router.get("/daily-summary", response_model=WalletDailySummaryOut)
def daily_summary(
    date: date_type | None = Query(
        None, description="Ngày cần xem (YYYY-MM-DD, giờ VN). Bỏ trống = hôm nay."
    ),
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> WalletDailySummaryOut:
    target = date or datetime.now(VN_TZ).date()
    start = datetime.combine(target, time.min, tzinfo=VN_TZ)
    end = start + timedelta(days=1)

    # ── Email đã thêm trong ngày ───────────────────────────────────────────
    added_at = func.coalesce(Member.last_invited_at, Member.created_at)
    member_rows = db.execute(
        select(Member.status, func.count())
        .where(
            Member.invited_by_user_id == user.id,
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
        )
        .where(
            WalletTransaction.user_id == user.id,
            WalletTransaction.created_at >= start,
            WalletTransaction.created_at < end,
        )
        .order_by(WalletTransaction.seq)
    ).all()

    per_kind: dict[str, list[int]] = {}
    for kind, amount, _reversed, _at in rows:
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

    # Tiền hoá đơn về ví (order_topup) luôn được tiêu ngay cho lượt mời/gia hạn CÙNG
    # THỜI ĐIỂM (một transaction = một mốc `created_at`) → đó chính là phần phí KHÔNG
    # trừ số dư. Ghép theo từng mốc thay vì so tổng cả ngày: lượt hỏng đã hoàn thì
    # tiền hoá đơn của nó Ở LẠI trong ví, không được tính là "đã tiêu qua hoá đơn".
    invoice_at: dict[datetime, int] = {}
    live_fee_at: dict[datetime, int] = {}
    for kind, amount, was_reversed, at in rows:
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
        topup_total=total("topup"),
        refund_total=total("invite_refund"),
        by_kind=by_kind,
    )
