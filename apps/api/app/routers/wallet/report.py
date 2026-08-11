"""Ví — Báo cáo tài chính (super-admin only).

Tổng hợp THU / CHI / LỢI NHUẬN cho 1 khoảng thời gian, KHÔNG ghi gì (chỉ đọc).

GỐC KẾ TOÁN: **DỒN TÍCH THEO NGÀY** cho CẢ HAI vế (chốt user 2026-08-11). Trước đây
THU ghi nhận MỘT CỤC tại ngày mời/gia hạn còn CHI ghi nhận theo NGÀY HOÁ ĐƠN Stripe —
hai gốc khác nhau nên mọi khoảng ngắn hơn 1 chu kỳ đều sai: xem "tháng này" (01→11/08)
ra CHI = 0 vì hai hoá đơn ChatGPT đang hiệu lực đều phát hành trong tháng 7, trong khi
11 ngày đó vẫn tiêu tốn chi phí của chúng → biên lợi nhuận 100% ảo. Nay mỗi khoản được
rải đều trên số ngày nó THỰC SỰ phủ, chỉ phần rơi vào [from, to] mới được tính:

  - THU (doanh thu) = Σ theo TỪNG KỲ của mọi member (không phải test, không phải chủ
    workspace) của: PHÍ MỜI hiệu lực (đơn giá/tháng) × số tháng của kỳ, RẢI ĐỀU trên
    [start_at, end_at) của kỳ. Mời lần đầu (chu kỳ 1) và mỗi lần gia hạn (chu kỳ 2, 3…)
    đều tính CÙNG một loại phí (chốt user 2026-07-14). Đơn giá phân giải LIVE:
    COALESCE(member.fee_vnd, chủ sở hữu user.invite_fee_vnd, global default) — admin
    sửa phí thì doanh thu đổi theo. Member thuộc user is_test bị loại. Ngày phục vụ
    TRƯỚC _SEPAY_LIVE_DATE (10/7/2026) KHÔNG tính THU (dữ liệu cũ chưa đi qua ví) —
    xem `rev_from`.
  - CHI (chi phí) = Σ tiền thực trả ChatGPT = total_vnd (gồm VAT) + phí ngân hàng của
    các hoá đơn Stripe 'paid' có NGÀY HOÁ ĐƠN >= workspace.finance_start_at (mốc bắt
    đầu tính CHI — hoá đơn hệ thống cũ / thanh toán ngoài trước mốc bị loại), RẢI ĐỀU
    trên [period_start, period_end) của hoá đơn. Hoá đơn không có chu kỳ (scrape cũ,
    chưa có period_*) → coi như phát sinh gọn trong 1 ngày = ngày hoá đơn.
  - LỢI NHUẬN = THU − CHI.

Hệ quả: THU và CHI cùng nhịp ngày nên lãi/lỗ THÁNG (và mọi khoảng lẻ) so sánh được
trực tiếp; `seat_months` = Σ seat-ngày có thu ÷ 30 nên cũng là số dồn tích (thập phân),
khiến "giá thu TB / seat" và "giá vốn TB / seat" đo cùng một mẫu số.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import NamedTuple
from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.deps import get_session, require_super_admin
from app.models import Member, User, Workspace
from app.schemas import (
    FinancialReportAgent,
    FinancialReportBucket,
    FinancialReportCycle,
    FinancialReportCyclesOut,
    FinancialReportOut,
)

from ._shared import router, get_payment_settings

# 1 tháng = 30 ngày (khớp SUBSCRIPTION_DAYS_PER_MONTH của luồng member) — dùng suy số
# tháng khi member có hạn nhưng chưa vật chất hoá chu kỳ nào.
_DAYS_PER_MONTH = 30

# Mốc SePay go-live (chốt user 2026-07-14): doanh thu (phí mời/gia hạn = "tiền admin
# add") CHỈ tính từ ngày này trở đi. Chỉ lọc trong báo cáo, không sửa/xoá dữ liệu gốc.
#
# CẮT MỐC thay vì loại cả kỳ (chốt user 2026-08-12): trước đây kỳ nào BẮT ĐẦU trước
# mốc là bị loại TOÀN BỘ, kể cả phần phục vụ sau mốc. Bất đối xứng với CHI — CHI tính
# từ workspace.finance_start_at nên đã gánh chính những ghế đó — làm tháng 7 hiện lỗ
# ảo 16,9tr và 4 ghế khách trả trước 2 tháng nằm ngoài sổ. Nay chỉ cắt phần ngày TRƯỚC
# mốc: trước mốc vẫn 0 đồng đúng như quyết định cũ, từ mốc trở đi thì ghi nhận.
_SEPAY_LIVE_DATE = date(2026, 7, 10)

# Số hàng đọc mỗi lô khi quét member/workspace (xem `financial_report`). Chỉ ảnh
# hưởng RAM, KHÔNG ảnh hưởng con số báo cáo.
_SCAN_CHUNK = 500


class _OwnerInfo(NamedTuple):
    """Vài cột của `User` mà báo cáo thực sự cần (RAM 2026-08-04).

    Trước đây báo cáo nạp NGUYÊN ORM `User` của mọi tài khoản chỉ để đọc 5 field
    này. NamedTuple nhẹ hơn nhiều lần và không nằm trong identity map của session.
    Giữ đúng tên field như `User` để `_member_per_month_fee` dùng chung được.
    """

    id: UUID
    username: str
    email: str | None
    is_test: bool
    invite_fee_vnd: int | None


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


def _first_of_next_month(d: date) -> date:
    return date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)


def _accrue(
    amount: int,
    start: date,
    end_excl: date,
    from_date: date,
    to_date: date,
    bucket: dict[str, int],
) -> tuple[int, int]:
    """Rải `amount` ĐỀU THEO NGÀY trên [start, end_excl), cộng phần rơi trong
    [from_date, to_date] (bao gồm 2 đầu) vào `bucket` theo tháng (khoá YYYY-MM).

    Trả về (số tiền ghi nhận trong kỳ, số ngày phủ trong kỳ). Tiền được làm tròn
    MỘT LẦN cho mỗi mảnh-tháng rồi cộng dồn, nên tổng trả về LUÔN khớp đúng tổng
    các cột trong biểu đồ (không lệch do làm tròn 2 nơi).

    Khoảng rỗng/ngược (end_excl <= start) → coi như phát sinh gọn trong 1 ngày.
    """
    if end_excl <= start:
        end_excl = start + timedelta(days=1)
    total_days = (end_excl - start).days
    lo = max(start, from_date)
    hi = min(end_excl, to_date + timedelta(days=1))
    if hi <= lo:
        return 0, 0
    taken = 0
    cur = lo
    while cur < hi:
        nxt = min(_first_of_next_month(cur), hi)
        part = round(amount * (nxt - cur).days / total_days)
        mk = _month_key(cur)
        if mk in bucket:
            bucket[mk] += part
        taken += part
        cur = nxt
    return taken, (hi - lo).days


def _default_from(today: date) -> date:
    """Đầu kỳ mặc định = ngày 1 của tháng cách đây 5 tháng (tổng ~6 tháng gần đây)."""
    y, m = today.year, today.month
    m -= 5
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


def _parse_inv_date(inv: dict, key: str) -> date | None:
    """Đọc 1 field ngày ISO của hoá đơn ('date' / 'period_start' / 'period_end')."""
    raw = inv.get(key)
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
    member: Member, owner: _OwnerInfo | None, default_fee: int
) -> int:
    """Đơn giá/tháng hiệu lực của 1 member = COALESCE(member.fee_vnd, chủ sở hữu
    user.invite_fee_vnd, global default). Chủ là admin (không đặt phí riêng) hoặc
    chưa có chủ → rơi về phí mặc định hệ thống."""
    if member.fee_vnd is not None:
        return int(member.fee_vnd)
    if owner is not None and owner.invite_fee_vnd is not None:
        return int(owner.invite_fee_vnd)
    return default_fee


def _member_revenue_events(
    member: Member, now: datetime
) -> list[tuple[bool, int, datetime, datetime]]:
    """Danh sách kỳ tính tiền của member → (is_invite, months, start, end).

    - `is_invite`: chu kỳ 1 (mời lần đầu) vs gia hạn (chu kỳ > 1).
    - `months`: số tháng của kỳ (đơn giá × months = phí kỳ đó).
    - `start`: mốc bắt đầu kỳ (kỳ 1 = ngày tham gia; gia hạn = hạn cũ).
    - `end`: mốc hết kỳ — phí được RẢI ĐỀU trên [start, end). Thiếu end_at (dữ liệu
      cũ) → suy start + months × 30 ngày để vẫn có độ dài phân bổ.

    Ưu tiên các chu kỳ đã vật chất hoá; member có hạn nhưng CHƯA có kỳ nào (mời trước
    bảng cycles) → suy 1 kỳ mời phủ [ngày tham gia → hạn]. Vô thời hạn (không hạn,
    không kỳ) → không có phí (owner/free)."""
    cycles = list(member.subscription_cycles)
    if cycles:
        out: list[tuple[bool, int, datetime, datetime]] = []
        for c in cycles:
            start = c.start_at or c.paid_at or member.created_at
            if start is None:
                continue
            months = int(c.months) if c.months else 1
            end = c.end_at
            if end is None or end <= start:
                end = start + timedelta(days=_DAYS_PER_MONTH * months)
            out.append((c.cycle_number == 1, months, start, end))
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
    return [(True, months, anchor, member.subscription_end_at)]


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

    # Đầu kỳ RIÊNG cho THU: không bao giờ ghi nhận ngày phục vụ trước mốc SePay.
    # Kỳ bắt đầu từ mốc trở đi không bị ảnh hưởng (start >= _SEPAY_LIVE_DATE nên
    # phần giao không đổi); kỳ cũ hơn chỉ mất phần đuôi trước mốc.
    rev_from = max(from_date, _SEPAY_LIVE_DATE)

    default_fee = int(get_payment_settings(db).invite_fee_vnd or 0)
    # RAM: chỉ lấy 5 cột báo cáo thực sự đọc, thay vì nạp nguyên ORM User của mọi
    # tài khoản vào identity map. Nội dung dùng tới không đổi (xem _OwnerInfo).
    users: dict[UUID, _OwnerInfo] = {
        row.id: _OwnerInfo(
            row.id, row.username, row.email, row.is_test, row.invite_fee_vnd
        )
        for row in db.execute(
            select(
                User.id,
                User.username,
                User.email,
                User.is_test,
                User.invite_fee_vnd,
            )
        )
    }

    # ── THU: phí mời/gia hạn theo từng kỳ của mọi member (loại test + chủ workspace) ──
    revenue_invite = 0
    revenue_renew = 0
    # Tổng "seat-NGÀY" có phát sinh THU trong kỳ (Σ số ngày mỗi kỳ phủ trong [from, to]).
    # ÷ 30 → seat-tháng dồn tích = mẫu số để suy giá vốn TB mỗi seat/tháng.
    seat_days = 0
    # Gom theo chủ sở hữu (invited_by_user_id); None = "chưa có chủ" (gộp riêng).
    agent_rev: dict[UUID | None, int] = {}
    agent_invites: dict[UUID | None, int] = {}
    agent_renews: dict[UUID | None, int] = {}

    # RAM: quét member theo LÔ rồi `expunge` từng lô. Vòng lặp chỉ cộng dồn số
    # (không giữ lại member nào) nên bộ nhớ ORM phẳng theo lô thay vì tăng theo cả
    # bảng — trước đây `.all()` giữ MỌI member + MỌI chu kỳ cùng lúc. Con số cộng
    # ra không đổi: cùng tập hàng, cùng thứ tự, cùng công thức.
    member_stmt = (
        select(Member)
        .options(selectinload(Member.subscription_cycles))
        .execution_options(yield_per=_SCAN_CHUNK)
    )
    for chunk in db.execute(member_stmt).scalars().partitions():
        for m in chunk:
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
            for is_invite, n_months, start_dt, end_dt in _member_revenue_events(m, now):
                start_d = start_dt.astimezone(timezone.utc).date()
                end_d = end_dt.astimezone(timezone.utc).date()
                # Phí cả kỳ rải đều theo ngày; chỉ phần phủ [rev_from, to] vào báo cáo —
                # nên kỳ bắt đầu từ tháng trước vẫn đóng góp THU cho tháng này.
                amt, days = _accrue(
                    per_month * n_months, start_d, end_d, rev_from, to_date, rev_by_month
                )
                seat_days += days
                if days > 0:
                    agent_rev[owner_key] = agent_rev.get(owner_key, 0) + amt
                    if is_invite:
                        revenue_invite += amt
                    else:
                        revenue_renew += amt
                # Số ĐƠN (mời/gia hạn) vẫn đếm theo SỰ KIỆN: kỳ bắt đầu trong khoảng
                # VÀ từ mốc SePay trở đi (kỳ cũ hơn không phải "đơn phát sinh qua ví").
                if from_date <= start_d <= to_date and start_d >= _SEPAY_LIVE_DATE:
                    agent_rev.setdefault(owner_key, 0)
                    if is_invite:
                        agent_invites[owner_key] = agent_invites.get(owner_key, 0) + 1
                    else:
                        agent_renews[owner_key] = agent_renews.get(owner_key, 0) + 1
        for m in chunk:
            db.expunge(m)

    revenue = revenue_invite + revenue_renew

    # ── CHI: hoá đơn Stripe 'paid' của mọi workspace, chỉ tính từ finance_start_at ──
    # RAM: chỉ 3 cột dùng tới, đọc theo lô. `billing_invoices` là JSONB chứa cả
    # lịch sử hoá đơn Stripe chi tiết — trước đây `.all()` giữ lịch sử của MỌI
    # workspace trong RAM cùng lúc, giờ chỉ giữ 1 lô. Cách tính CHI không đổi.
    ws_stmt = select(
        Workspace.billing_invoices,
        Workspace.finance_start_at,
        Workspace.created_at,
    ).execution_options(yield_per=_SCAN_CHUNK)
    cost = 0
    cost_missing = 0
    # Hoá đơn 'paid' sau mốc nhưng thiếu chu kỳ → không tính được, đếm để cảnh báo.
    cost_skipped = 0
    for ws_invoices, ws_finance_start_at, ws_created_at in db.execute(ws_stmt):
        invoices = ws_invoices or []
        paid = [inv for inv in invoices if inv.get("status") == "paid"]
        if not paid:
            cost_missing += 1
            continue
        # Mốc bắt đầu tính CHI: finance_start_at (backfill = đầu chu kỳ hiện tại);
        # chưa set → fallback created_at (workspace mới tính từ khi onboard).
        anchor = ws_finance_start_at or ws_created_at
        fstart = anchor.astimezone(timezone.utc).date() if anchor is not None else None
        for inv in paid:
            d = _parse_inv_date(inv, "date")
            if d is None:
                continue
            if fstart is not None and d < fstart:
                continue  # hoá đơn trước mốc = hệ thống cũ / thanh toán ngoài → bỏ
            # Chu kỳ hoá đơn phủ = [period_start, period_end). Hoá đơn THIẾU chu kỳ
            # (scrape cũ chưa lấy trang chi tiết) bị BỎ QUA — chốt user 2026-08-12:
            # không có chu kỳ thì không biết rải vào ngày nào, dồn cả cục vào ngày
            # hoá đơn làm méo tháng đó. Đếm lại để cảnh báo, không im lặng nuốt tiền.
            ps = _parse_inv_date(inv, "period_start")
            pe = _parse_inv_date(inv, "period_end")
            if ps is None or pe is None or pe <= ps:
                # Chỉ cảnh báo khi hoá đơn hỏng nằm TRONG kỳ đang xem — hoá đơn cũ
                # ngoài kỳ mà cứ kêu thì banner luôn sáng và mất tác dụng.
                if from_date <= d <= to_date:
                    cost_skipped += 1
                continue
            got, _days = _accrue(
                _invoice_cost(inv), ps, pe, from_date, to_date, cost_by_month
            )
            cost += got

    profit = revenue - cost

    # Seat-tháng DỒN TÍCH trong kỳ = Σ seat-ngày ÷ 30 (thập phân — khoảng 11 ngày của
    # 190 seat ≈ 69.7 seat-tháng, không phải 190).
    seat_months = round(seat_days / _DAYS_PER_MONTH, 2)

    # Giá vốn trung bình mỗi seat/tháng = TỔNG CHI (gồm VAT) ÷ tổng seat-tháng có THU.
    # Cả tử lẫn mẫu giờ cùng gốc dồn tích theo ngày nên so trực tiếp được với đơn
    # giá/tháng (vd 330k). 0 seat-tháng → None.
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
        cost_skipped_invoices=cost_skipped,
        seat_months=seat_months,
        avg_cost_per_seat=avg_cost_per_seat,
    )


@router.get("/admin/report/cycles", response_model=FinancialReportCyclesOut)
def financial_report_cycles(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
    limit: int = Query(default=3, ge=1, le=24),
) -> FinancialReportCyclesOut:
    """Lãi/lỗ cắt theo ĐÚNG CHU KỲ THANH TOÁN ChatGPT, mỗi workspace một dòng/kỳ.

    Chốt user 2026-08-12: báo cáo tháng lịch giữ nguyên để nhìn tổng, nhưng "tháng"
    của ChatGPT là 11/08→11/09 chứ không phải 01→31/08, nên cần xem thêm theo đúng
    chu kỳ. Ở đây CHI = TRỌN tiền hoá đơn (không chia ngày — đúng ý "thanh toán theo
    tháng"), THU = doanh thu của member THUỘC workspace đó rơi vào đúng những ngày
    của chu kỳ. `limit` = số chu kỳ gần nhất lấy cho MỖI workspace.

    Chỉ đọc. Chu kỳ đang chạy được đánh dấu `in_progress` — THU của nó còn thiếu phần
    khách chưa gia hạn, nên đừng kết luận lỗ khi kỳ chưa đóng.
    """
    now = datetime.now(timezone.utc)
    today = now.date()
    default_fee = int(get_payment_settings(db).invite_fee_vnd or 0)
    users: dict[UUID, _OwnerInfo] = {
        row.id: _OwnerInfo(row.id, row.username, row.email, row.is_test, row.invite_fee_vnd)
        for row in db.execute(
            select(User.id, User.username, User.email, User.is_test, User.invite_fee_vnd)
        )
    }

    # ── Dựng danh sách chu kỳ từ hoá đơn (mới nhất trước, tối đa `limit` mỗi ws) ──
    # cycles: workspace_id → list[(period_start, period_end, cost, seats)]
    cycles: dict[UUID, list[tuple[date, date, int, int | None]]] = {}
    ws_names: dict[UUID, str] = {}
    for wid, name, invs, fs, created in db.execute(
        select(
            Workspace.id,
            Workspace.name,
            Workspace.billing_invoices,
            Workspace.finance_start_at,
            Workspace.created_at,
        )
    ):
        ws_names[wid] = name
        anchor = fs or created
        fstart = anchor.astimezone(timezone.utc).date() if anchor is not None else None
        rows: list[tuple[date, date, int, int | None]] = []
        for inv in invs or []:
            if inv.get("status") != "paid":
                continue
            d = _parse_inv_date(inv, "date")
            if d is None or (fstart is not None and d < fstart):
                continue
            ps = _parse_inv_date(inv, "period_start")
            pe = _parse_inv_date(inv, "period_end")
            if ps is None or pe is None or pe <= ps:
                continue  # thiếu chu kỳ → không xếp vào đâu được (xem cost_skipped)
            qty = int(inv.get("quantity") or 0) or None
            rows.append((ps, pe, _invoice_cost(inv), qty))
        rows.sort(key=lambda r: r[0], reverse=True)
        if rows:
            cycles[wid] = rows[:limit]

    # ── THU cho từng chu kỳ: quét member theo lô, cộng vào các chu kỳ của ĐÚNG
    # workspace của member. Cùng công thức với báo cáo tháng (rải theo ngày + cắt
    # mốc SePay) nên hai màn hình không bao giờ lệch nhau.
    rev: dict[tuple[UUID, int], int] = {}
    sdays: dict[tuple[UUID, int], int] = {}
    member_stmt = (
        select(Member)
        .options(selectinload(Member.subscription_cycles))
        .execution_options(yield_per=_SCAN_CHUNK)
    )
    for chunk in db.execute(member_stmt).scalars().partitions():
        for m in chunk:
            ws_cycles = cycles.get(m.workspace_id)
            if not ws_cycles or m.chatgpt_role == "owner":
                continue
            owner = users.get(m.invited_by_user_id) if m.invited_by_user_id else None
            if owner is not None and owner.is_test:
                continue
            per_month = _member_per_month_fee(m, owner, default_fee)
            if per_month <= 0:
                continue
            for _iv, n_months, start_dt, end_dt in _member_revenue_events(m, now):
                start_d = start_dt.astimezone(timezone.utc).date()
                end_d = end_dt.astimezone(timezone.utc).date()
                for i, (ps, pe, _c, _q) in enumerate(ws_cycles):
                    amt, days = _accrue(
                        per_month * n_months,
                        start_d,
                        end_d,
                        max(ps, _SEPAY_LIVE_DATE),
                        pe - timedelta(days=1),  # _accrue nhận `to` BAO GỒM
                        {},
                    )
                    key = (m.workspace_id, i)
                    if days:
                        rev[key] = rev.get(key, 0) + amt
                        sdays[key] = sdays.get(key, 0) + days
        for m in chunk:
            db.expunge(m)

    out: list[FinancialReportCycle] = []
    for wid, rows in cycles.items():
        for i, (ps, pe, c, qty) in enumerate(rows):
            r = rev.get((wid, i), 0)
            total_days = (pe - ps).days
            elapsed = min(total_days, max(0, (today - ps).days))
            out.append(
                FinancialReportCycle(
                    workspace=ws_names[wid],
                    period_start=ps.isoformat(),
                    period_end=pe.isoformat(),
                    days=total_days,
                    days_elapsed=elapsed,
                    in_progress=elapsed < total_days,
                    seats=qty,
                    cost=c,
                    revenue=r,
                    profit=r - c,
                    seat_months=round(sdays.get((wid, i), 0) / _DAYS_PER_MONTH, 2),
                )
            )
    out.sort(key=lambda x: (x.period_start, x.workspace), reverse=True)
    return FinancialReportCyclesOut(cycles=out)
