"""Ví — Báo cáo tài chính (super-admin only).

Tổng hợp THU / CHI / LỢI NHUẬN cho 1 khoảng thời gian, KHÔNG ghi gì (chỉ đọc):

  - THU (doanh thu) = Σ theo TỪNG KỲ của mọi member (không phải test, không phải chủ
    workspace) của: PHÍ MỜI hiệu lực (đơn giá/tháng) × số tháng của kỳ. Mời lần đầu
    (chu kỳ 1) và mỗi lần gia hạn (chu kỳ 2, 3…) đều tính CÙNG một loại phí (chốt user
    2026-07-14). Đơn giá phân giải LIVE: COALESCE(member.fee_vnd, chủ sở hữu
    user.invite_fee_vnd, global default) — admin sửa phí thì doanh thu đổi theo. Member
    thuộc user is_test bị loại. CHỈ tính kỳ có mốc >= _SEPAY_LIVE_DATE (10/7/2026) —
    dữ liệu cũ chưa đi qua SePay không tính THU.
  - CHI (chi phí) = Σ tiền thực trả ChatGPT = total_vnd (gồm VAT) + phí ngân hàng của
    các hoá đơn Stripe 'paid' có ngày trong kỳ VÀ >= workspace.finance_start_at (mốc
    bắt đầu tính CHI — hoá đơn hệ thống cũ / thanh toán ngoài trước mốc bị loại).
  - LỢI NHUẬN = THU − CHI.

Lưu ý dòng thời gian: 1 kỳ được tính vào tháng của `start_at` (mốc bắt đầu kỳ = ngày
tham gia cho kỳ 1, hạn cũ cho kỳ gia hạn); còn Stripe tính CHI theo ngày hoá đơn — nên
lợi nhuận THÁNG có thể lệch pha, tổng theo kỳ dài thì hội tụ.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.deps import get_session, require_super_admin
from app.models import Member, User, Workspace
from app.schemas import (
    FinancialReportAgent,
    FinancialReportBucket,
    FinancialReportOut,
)

from ._shared import router, get_payment_settings

# 1 tháng = 30 ngày (khớp SUBSCRIPTION_DAYS_PER_MONTH của luồng member) — dùng suy số
# tháng khi member có hạn nhưng chưa vật chất hoá chu kỳ nào.
_DAYS_PER_MONTH = 30

# Mốc SePay go-live (chốt user 2026-07-14): doanh thu (phí mời/gia hạn = "tiền admin
# add") CHỈ tính từ ngày này trở đi. Kỳ mời/gia hạn có mốc trước đây = dữ liệu cũ chưa
# đi qua SePay → KHÔNG tính THU. Chỉ lọc trong báo cáo, không sửa/xoá dữ liệu gốc.
_SEPAY_LIVE_DATE = date(2026, 7, 10)


def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _month_range(start: date, end: date) -> list[str]:
    """Danh sách YYYY-MM liên tục từ tháng của `start` tới tháng của `end` (bao gồm)."""
    out: list[str] = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def _default_from(today: date) -> date:
    """Đầu kỳ mặc định = ngày 1 của tháng cách đây 5 tháng (tổng ~6 tháng gần đây)."""
    y, m = today.year, today.month
    m -= 5
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


def _parse_invoice_date(inv: dict) -> date | None:
    raw = inv.get("date")
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def _invoice_cost(inv: dict) -> int:
    """Tiền thực trả cho 1 hoá đơn = total_vnd (gồm VAT) fallback amount_vnd, cộng
    phí ngân hàng nhập tay (nếu có)."""
    base = inv.get("total_vnd")
    if base is None:
        base = inv.get("amount_vnd")
    fee = inv.get("service_fee_vnd") or 0
    return int(base or 0) + int(fee)


def _months_between(start: datetime, end: datetime) -> int:
    """Số tháng (30 ngày) giữa 2 mốc, tối thiểu 1. Dùng suy months cho member có hạn
    nhưng chưa có chu kỳ (mời trước bảng cycles / vô thời hạn cũ)."""
    days = (end - start).total_seconds() / 86400
    return max(1, round(days / _DAYS_PER_MONTH))


def _member_per_month_fee(
    member: Member, owner: User | None, default_fee: int
) -> int:
    """Đơn giá/tháng hiệu lực của 1 member = COALESCE(member.fee_vnd, chủ sở hữu
    user.invite_fee_vnd, global default). Chủ là admin (không đặt phí riêng) hoặc
    chưa có chủ → rơi về phí mặc định hệ thống."""
    if member.fee_vnd is not None:
        return int(member.fee_vnd)
    if owner is not None and owner.invite_fee_vnd is not None:
        return int(owner.invite_fee_vnd)
    return default_fee


def _member_revenue_events(member: Member, now: datetime) -> list[tuple[bool, int, datetime]]:
    """Danh sách kỳ tính tiền của member → (is_invite, months, when).

    - `is_invite`: chu kỳ 1 (mời lần đầu) vs gia hạn (chu kỳ > 1).
    - `months`: số tháng của kỳ (đơn giá × months = phí kỳ đó).
    - `when`: mốc gán tháng cho biểu đồ = start_at của kỳ (kỳ 1 = ngày tham gia).

    Ưu tiên các chu kỳ đã vật chất hoá; member có hạn nhưng CHƯA có kỳ nào (mời trước
    bảng cycles) → suy 1 kỳ mời phủ [ngày tham gia → hạn]. Vô thời hạn (không hạn,
    không kỳ) → không có phí (owner/free)."""
    cycles = list(member.subscription_cycles)
    if cycles:
        out: list[tuple[bool, int, datetime]] = []
        for c in cycles:
            when = c.start_at or c.paid_at or member.created_at
            if when is None:
                continue
            months = int(c.months) if c.months else 1
            out.append((c.cycle_number == 1, months, when))
        return out
    if member.subscription_end_at is None:
        return []  # vô thời hạn / chưa có hạn → không tính phí
    anchor = (
        member.joined_at
        or member.subscription_purchased_at
        or member.last_invited_at
        or member.created_at
    )
    if anchor is None:
        return []
    if anchor > now:
        anchor = now
    months = _months_between(anchor, member.subscription_end_at)
    return [(True, months, anchor)]


@router.get("/admin/report", response_model=FinancialReportOut)
def financial_report(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
) -> FinancialReportOut:
    """Báo cáo tài chính trong kỳ [from, to] (ISO date, bao gồm 2 đầu). Mặc định
    ~6 tháng gần đây. Chỉ đọc — an toàn gọi lại bất kỳ lúc nào."""
    now = datetime.now(timezone.utc)
    today = now.date()
    from_date = date.fromisoformat(from_) if from_ else _default_from(today)
    to_date = date.fromisoformat(to) if to else today
    if to_date < from_date:
        from_date, to_date = to_date, from_date

    months = _month_range(from_date, to_date)
    rev_by_month: dict[str, int] = {k: 0 for k in months}
    cost_by_month: dict[str, int] = {k: 0 for k in months}

    default_fee = int(get_payment_settings(db).invite_fee_vnd or 0)
    users = {u.id: u for u in db.execute(select(User)).scalars().all()}

    # ── THU: phí mời/gia hạn theo từng kỳ của mọi member (loại test + chủ workspace) ──
    revenue_invite = 0
    revenue_renew = 0
    # Tổng "seat-tháng" có phát sinh THU (Σ số tháng của mọi kỳ được tính) — mẫu số để
    # suy giá vốn TB mỗi seat/tháng = TỔNG CHI ÷ seat-tháng.
    seat_months = 0
    # Gom theo chủ sở hữu (invited_by_user_id); None = "chưa có chủ" (gộp riêng).
    agent_rev: dict[UUID | None, int] = {}
    agent_invites: dict[UUID | None, int] = {}
    agent_renews: dict[UUID | None, int] = {}

    members = (
        db.execute(
            select(Member).options(selectinload(Member.subscription_cycles))
        )
        .scalars()
        .all()
    )
    for m in members:
        # Chủ workspace (role owner) = vô thời hạn/miễn phí — không tính doanh thu.
        if m.chatgpt_role == "owner":
            continue
        owner = users.get(m.invited_by_user_id) if m.invited_by_user_id else None
        # Member thuộc tài khoản test → loại khỏi báo cáo.
        if owner is not None and owner.is_test:
            continue
        per_month = _member_per_month_fee(m, owner, default_fee)
        if per_month <= 0:
            continue
        owner_key = m.invited_by_user_id  # có thể None → nhóm "chưa có chủ"
        for is_invite, n_months, when in _member_revenue_events(m, now):
            bucket = when.astimezone(timezone.utc).date()
            if bucket < from_date or bucket > to_date:
                continue
            if bucket < _SEPAY_LIVE_DATE:
                continue  # kỳ trước mốc SePay = dữ liệu cũ chưa qua ví → không tính THU
            amt = per_month * n_months
            seat_months += n_months
            if is_invite:
                revenue_invite += amt
                agent_invites[owner_key] = agent_invites.get(owner_key, 0) + 1
            else:
                revenue_renew += amt
                agent_renews[owner_key] = agent_renews.get(owner_key, 0) + 1
            agent_rev[owner_key] = agent_rev.get(owner_key, 0) + amt
            mk = _month_key(bucket)
            if mk in rev_by_month:
                rev_by_month[mk] += amt

    revenue = revenue_invite + revenue_renew

    # ── CHI: hoá đơn Stripe 'paid' của mọi workspace, chỉ tính từ finance_start_at ──
    workspaces = db.execute(select(Workspace)).scalars().all()
    cost = 0
    cost_missing = 0
    for ws in workspaces:
        invoices = ws.billing_invoices or []
        paid = [inv for inv in invoices if inv.get("status") == "paid"]
        if not paid:
            cost_missing += 1
            continue
        # Mốc bắt đầu tính CHI: finance_start_at (backfill = đầu chu kỳ hiện tại);
        # chưa set → fallback created_at (workspace mới tính từ khi onboard).
        anchor = ws.finance_start_at or ws.created_at
        fstart = anchor.astimezone(timezone.utc).date() if anchor is not None else None
        for inv in paid:
            d = _parse_invoice_date(inv)
            if d is None or d < from_date or d > to_date:
                continue
            if fstart is not None and d < fstart:
                continue  # hoá đơn trước mốc = hệ thống cũ / thanh toán ngoài → bỏ
            c = _invoice_cost(inv)
            cost += c
            mk = _month_key(d)
            if mk in cost_by_month:
                cost_by_month[mk] += c

    profit = revenue - cost

    # Giá vốn trung bình mỗi seat/tháng = TỔNG CHI (gồm VAT) ÷ tổng seat-tháng có THU.
    # Đây là giá vốn TB — đã "san phẳng" phần prorate lẻ ngày của ChatGPT và chi phí seat
    # owner/free — nên so trực tiếp được với đơn giá/tháng (vd 330k). 0 seat-tháng → None.
    avg_cost_per_seat = round(cost / seat_months) if seat_months > 0 else None

    monthly = [
        FinancialReportBucket(
            month=mk,
            revenue=rev_by_month[mk],
            cost=cost_by_month[mk],
            profit=rev_by_month[mk] - cost_by_month[mk],
        )
        for mk in months
    ]

    # ── Doanh thu theo đại lý (giảm dần) ────────────────────────────────────
    by_agent = []
    for owner_key, rev in agent_rev.items():
        u = users.get(owner_key) if owner_key else None
        by_agent.append(
            FinancialReportAgent(
                user_id=owner_key,
                username=(u.username if u else "Chưa có chủ"),
                email=(u.email if u else None),
                revenue=rev,
                invite_count=agent_invites.get(owner_key, 0),
                renew_count=agent_renews.get(owner_key, 0),
            )
        )
    by_agent.sort(key=lambda a: a.revenue, reverse=True)

    return FinancialReportOut(
        from_date=from_date.isoformat(),
        to_date=to_date.isoformat(),
        revenue=revenue,
        revenue_invite=revenue_invite,
        revenue_renew=revenue_renew,
        cost=cost,
        profit=profit,
        monthly=monthly,
        by_agent=by_agent,
        cost_missing_workspaces=cost_missing,
        seat_months=seat_months,
        avg_cost_per_seat=avg_cost_per_seat,
    )
