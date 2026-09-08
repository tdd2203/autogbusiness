"""Ví — Báo cáo tài chính (super-admin only).

Tổng hợp THU / CHI / LỢI NHUẬN cho 1 khoảng thời gian, KHÔNG ghi gì (chỉ đọc).

GỐC KẾ TOÁN: **TIỀN MẶT** (chốt user 2026-08-12) — "chỉ lấy tiền nhận trong tháng đó
và chi phí trong tháng đó". Không phân bổ theo ngày:

  - THU = Σ phí của các CHU KỲ ĐÃ ĐÁNH DẤU TRẢ (payment_status='paid') có NGÀY BẮT
    ĐẦU KỲ (start_at, thiếu thì paid_at) nằm trong [from, to]. Phí = đơn giá/tháng
    hiệu lực × số chu kỳ TRỌN, CỘNG phần lẻ của kỳ nếu có (chế độ `cycle_aligned` bán
    lẻ ngày — xem `cycle_units`/`cycle_amount` và EXPIRY_RULES §3.6.5).
    Mời lần đầu (chu kỳ 1) và gia hạn (chu kỳ 2, 3…) cùng
    loại phí (chốt user 2026-07-14). Đơn giá phân giải LIVE: COALESCE(member.fee_vnd,
    chủ sở hữu user.invite_fee_vnd, global default). Member thuộc user is_test và
    member chủ workspace (role owner) bị loại. Kỳ CHƯA trả không vào THU — công nợ.
    KHÔNG chặn theo workspace.finance_start_at (đã thử và bỏ — xem chú thích trong
    vòng lặp): chặn thì mất doanh thu của khách mà chi phí ghế của họ vẫn đang tính.

    KHÔNG dùng paid_at làm mốc (chốt user 2026-08-12): đó là lúc bấm đánh dấu chứ
    không phải lúc tiền về. Ngày 13/07/2026 — SePay go-live — có 172 kỳ được chốt
    cùng lúc, trong đó 44,7tr thuộc về tháng 5 và 6; lấy paid_at thì tháng 7 phình
    lên 122tr còn tháng 5, 6 rỗng. start_at là dữ liệu thật, không đổi theo thao tác.
  - CHI = Σ TRỌN tiền hoá đơn Stripe 'paid' (total_vnd gồm VAT + phí ngân hàng: theo
    % của workspace nếu đã đặt, không thì phí nhập tay từng hoá đơn) có NGÀY HOÁ ĐƠN nằm trong [from, to] VÀ >= workspace.finance_start_at (mốc
    bắt đầu tính CHI — hoá đơn hệ thống cũ / thanh toán ngoài trước mốc bị loại).
  - LỢI NHUẬN = THU − CHI.

ĐÁNH ĐỔI ĐÃ BIẾT: hai vế neo vào hai mốc khác nhau (kỳ member vs ngày hoá đơn ChatGPT)
nên tháng nào chỉ có 1 hoá đơn mà ít khách mở kỳ mới sẽ hụt, và ngược lại. Muốn biết
THỰC SỰ lãi/lỗ trên mỗi ghế thì xem `financial_report_cycles` bên dưới — nó cắt đúng
chu kỳ hoá đơn và có tỷ lệ lấp đầy.

`invite_credit_held` (endpoint riêng, super-admin) đếm TIỀN ĐANG GIỮ ở các email mời
hỏng: đã thu mà chưa giao dịch vụ nên KHÔNG nằm trong THU ở trên, phải đối soát riêng.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone
from typing import Callable, NamedTuple
from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.billing_fee import invoice_fee_vnd
from app.deps import get_session, require_super_admin
from app.models import (
    PLATFORM_CANVA,
    PLATFORM_GPT,
    PRICE_ROUND_TO_VND_DEFAULT,
    Member,
    MemberSubscriptionCycle,
    User,
    Workspace,
)
from app.schemas import (
    FinancialReportAgent,
    FinancialReportBucket,
    FinancialReportCycle,
    FinancialReportCyclesOut,
    FinancialReportOut,
    PlatformSplit,
)

from app.services import canva_price, payment_flow

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
    # Bảng giá Canva riêng của đại lý (None = dùng bảng mặc định hệ thống). Nhánh
    # Canva bán theo BẬC nên không suy ra được từ `invite_fee_vnd`.
    canva_price_tiers: list[dict] | None = None


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


# 1 dòng chu kỳ đã gộp: (period_start, period_end, cost, seats_start, seats_end)
_CycleRow = tuple[date, date, int, "int | None", "int | None"]


def _parse_inv_date(inv: dict, key: str) -> date | None:
    """Đọc 1 field ngày ISO của hoá đơn ('date' / 'period_start' / 'period_end')."""
    raw = inv.get(key)
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def _invoice_cost(inv: dict, bank_fee_percent: float | None = None) -> int:
    """Tiền thực trả cho 1 hoá đơn = total_vnd (gồm VAT) fallback amount_vnd, cộng
    phí ngân hàng: theo % của workspace nếu đã đặt, không thì phí nhập tay từng
    dòng (xem `app/billing_fee.py`)."""
    base = inv.get("total_vnd")
    if base is None:
        base = inv.get("amount_vnd")
    return int(base or 0) + invoice_fee_vnd(inv, bank_fee_percent)


def _unit_price_lookup(paid: list[dict]) -> tuple[dict, list]:
    """Bảng tra ĐƠN GIÁ/ghế/tháng của workspace, dựng từ hoá đơn gia hạn.

    Trả về (theo period_end, danh sách (ngày, đơn giá) tăng dần). Hoá đơn mua thêm
    suất giữa kỳ KHÔNG có `unit_price_vnd` nên phải mượn đơn giá của kỳ nó thuộc về.
    """
    by_period_end: dict = {}
    dated: list = []
    for inv in paid:
        u = inv.get("unit_price_vnd")
        if not u:
            continue
        u = int(u)
        pe = _parse_inv_date(inv, "period_end")
        if pe is not None:
            by_period_end.setdefault(pe, u)
        d = _parse_inv_date(inv, "date")
        if d is not None:
            dated.append((d, u))
    dated.sort()
    return by_period_end, dated


def _cycle_unit_price(inv: dict, by_period_end: dict, dated: list) -> int | None:
    """Đơn giá/ghế/THÁNG áp dụng cho hoá đơn này: của chính nó → của kỳ cùng
    period_end (hoá đơn proration mượn giá kỳ gia hạn) → đơn giá gần nhất trước đó."""
    u = inv.get("unit_price_vnd")
    if u:
        return int(u)
    pe = _parse_inv_date(inv, "period_end")
    if pe is not None and pe in by_period_end:
        return by_period_end[pe]
    d = _parse_inv_date(inv, "date")
    before = [u for dd, u in dated if d is None or dd <= d]
    if before:
        return before[-1]
    return dated[0][1] if dated else None


def _seat_months_billed(inv: dict, unit_price: int | None) -> float | None:
    """Số ghế·tháng mà hoá đơn này THỰC SỰ trả tiền (mẫu số của "phí seat thực tế").

    1 KỲ = 1 THÁNG (chốt user 2026-08-25): thuê bao ChatGPT thu đúng 1 tháng tiền
    dù kỳ dài 28/30/31 ngày, nên KHÔNG quy đổi span ÷ 30 nữa — quy đổi làm mỗi kỳ
    31 ngày "rẻ đi" 3,2% so với giá thật.

    Vì vậy ghế·tháng = subtotal ÷ đơn giá/ghế/tháng. Cách này còn tự xử lý hoá đơn
    mua thêm suất giữa kỳ, thứ mà `quantity` KHÔNG nói được: Stripe ghi `quantity`
    = TỔNG suất SAU khi mua (vd 60) nhưng chỉ thu phần chênh mấy suất vừa thêm (vd
    6 suất × 3 ngày). Lấy thẳng quantity thổi mẫu số lên ~9% và kéo "phí seat thực
    tế" xuống dưới cả giá gốc chưa VAT (ca thật tháng 8/2026: 254.106 đ).

    Thiếu đơn giá/subtotal → rơi về `quantity × số tháng của kỳ`. None = không đủ
    dữ liệu, bỏ hoá đơn khỏi CẢ tử lẫn mẫu để hai bên cùng một tập hoá đơn.
    """
    sub = inv.get("subtotal_vnd")
    if unit_price and unit_price > 0 and sub:
        return int(sub) / unit_price
    qty = int(inv.get("quantity") or 0)
    if qty <= 0:
        return None
    ps = _parse_inv_date(inv, "period_start")
    pe = _parse_inv_date(inv, "period_end")
    span = (pe - ps).days if ps and pe and pe > ps else _DAYS_PER_MONTH
    return qty * max(1, round(span / _DAYS_PER_MONTH))


def _months_between(start: datetime, end: datetime) -> int:
    """Số tháng (30 ngày) giữa 2 mốc, tối thiểu 1. Dùng suy months cho member có hạn
    nhưng chưa có chu kỳ (mời trước bảng cycles / vô thời hạn cũ)."""
    days = (end - start).total_seconds() / 86400
    return max(1, round(days / _DAYS_PER_MONTH))


# ── THÀNH TIỀN CỦA MỘT DÒNG CHU KỲ ──────────────────────────────────────────────
#
# Chế độ `cycle_aligned` (EXPIRY_RULES §3.6.5) chẻ MỘT lượt bán thành hai phần: phần
# LẺ tới mốc chốt (`prorated_half_days`, đơn vị NỬA NGÀY) và số chu kỳ TRỌN
# (`months`). Đọc mỗi `months` rồi nhân đơn giá là sai CẢ HAI CHIỀU:
#
#   - kỳ thuần phần lẻ có `months = 0` ⇒ `if c.months` là falsy ⇒ rơi về "1 tháng"
#     và báo cáo ghi THU trọn tháng cho một kỳ khách chỉ trả 22 ngày;
#   - kỳ "phần lẻ + mua thêm 1 tháng" thì mất sạch phần lẻ ⇒ ghi THIẾU.
#
# Hai chiều đó kéo theo `seat_months_sold`, `avg_seat_cost`, `profit` và `by_agent`.
# Vì vậy MỌI nơi tính tiền một dòng kỳ phải đi qua `cycle_units` + `cycle_amount`.
# Đơn giá tháng vẫn ba tầng như cũ (`_member_per_month_fee` /
# `payment_flow.effective_fee`): member → đại lý → hệ thống.


class _CycleUnits(NamedTuple):
    """Đơn vị tính tiền của MỘT dòng `MemberSubscriptionCycle`.

    Tiền = đơn_giá × `whole_months` + phần lẻ (`half_days` nửa ngày trên chu kỳ dài
    `cycle_days` ngày). Dòng của chế độ `legacy_30d` luôn có `half_days = 0` nên công
    thức thu về đúng "đơn giá × số tháng" như trước — chế độ cũ KHÔNG được lệch một
    đồng nào, đó là điều kiện bắt buộc khi thêm chế độ mới.
    """

    whole_months: int
    half_days: int
    cycle_days: int


def workspace_anchor_day(
    cycle_anchor_day: int | None, renewal_date: datetime | None
) -> int | None:
    """NGÀY trong tháng mà chu kỳ hoá đơn của workspace chốt (1–31), hoặc None.

    Cùng thứ tự ưu tiên với `members/_shared.cycle_params`: cột riêng của workspace,
    thiếu thì MỒI từ `renewal_date` để workspace vừa gạt sang chế độ mới không phải
    gõ tay. Không nhân bản thêm tầng nào — mốc TỰ CUỘN theo tháng từ con số này
    (EXPIRY_RULES §3.6.3) nên chỉ cần đúng NGÀY, không cần đọc lại hoá đơn.

    ⚠️ PHẢI ép về UTC rồi mới đọc `.day`. `renewal_date` là `timestamptz`, driver trả
    về theo múi giờ của phiên nên `.day` trần có thể lệch MỘT NGÀY so với đường bán
    (`_shared.cycle_params` đọc `_as_utc(...).day`). Lệch một ngày ở đây không phải sai
    số nhỏ: nó làm `_cycle_length_days` lùi mốc vượt qua một biên, mẫu số nhảy từ 31
    lên 58 ngày và tiền phần lẻ hụt gần một nửa — mà con số đó đi thẳng vào nút
    "Thanh toán" lẫn `replay_cycle_order`. Đúng lỗi mà migration 0067 đã chữa bằng
    `AT TIME ZONE 'UTC'`; đừng cài lại nó ở tầng Python. EXPIRY_RULES §3.6.4: mọi mốc
    đều là UTC.
    """
    if cycle_anchor_day:
        return int(cycle_anchor_day)
    if renewal_date is not None:
        at = renewal_date
        at = at.replace(tzinfo=timezone.utc) if at.tzinfo is None else at.astimezone(timezone.utc)
        return at.day
    return None


def _boundary_prev(boundary: datetime, anchor_day: int) -> datetime:
    """Mốc chốt liền TRƯỚC `boundary` — lùi đúng MỘT tháng dương lịch (không phải 30
    ngày). Ngày neo 29/30/31 rơi vào tháng ngắn thì lùi về ngày cuối tháng, y hệt
    `members/_shared._boundary_on`; không lùi thì tháng 2 mất mốc và cả chu kỳ biến
    mất khỏi phép tính.
    """
    year, month = (
        (boundary.year - 1, 12) if boundary.month == 1 else (boundary.year, boundary.month - 1)
    )
    return boundary.replace(
        year=year, month=month, day=min(anchor_day, calendar.monthrange(year, month)[1])
    )


def _cycle_length_days(
    cycle: MemberSubscriptionCycle, whole_months: int, anchor_day: int | None
) -> int:
    """Độ dài LỊCH (28–31 ngày) của chu kỳ hoá đơn CHỨA ĐIỂM NỐI của kỳ này — mẫu số
    của công thức tiền §3.6.5.

    Suy NGƯỢC từ mốc đã lưu, cùng tinh thần với `members/_shared.sold_window`: `end_at`
    là mốc chốt SAU khi đã cộng `whole_months` mốc (§3.6.2), nên lùi đúng ngần ấy tháng
    dương lịch là ra mốc CHỐT của chu kỳ chứa điểm nối; lùi thêm một tháng nữa là mốc
    MỞ. Hai mốc đó trừ nhau ra độ dài thật. Suy ngược thay vì hỏi lại workspace vì
    tiền phải ra từ ĐÚNG cửa sổ đã bán — hỏi lại là lấy chu kỳ của HÔM NAY áp cho một
    kỳ bán từ ba tháng trước.

    `anchor_day` thiếu (workspace chưa đặt và cũng chưa có `renewal_date`) thì mượn
    `end_at.day`.

    ⚠️ CŨNG mượn `end_at.day` khi `anchor_day` KHÔNG khớp mốc chốt của kỳ này. Hai số
    đó lệch nhau nghĩa là ngày neo đã bị đổi SAU khi bán kỳ này (hoặc suy ra sai), và
    lúc ấy `_boundary_prev` sẽ đặt lại ngày theo neo mới rồi lùi vượt qua một biên —
    mẫu số ra 58 ngày thay vì 31, tiền phần lẻ hụt gần một nửa. Mốc đã lưu trên chính
    dòng kỳ mới là sự thật của cửa sổ đã bán; ngày neo hôm nay chỉ là suy đoán.
    """
    end = cycle.end_at
    if end is None:
        # Dữ liệu cũ thiếu mốc chốt: không có gì để suy ngược, lấy 30 ngày như phần
        # còn lại của báo cáo. Kỳ `cycle_aligned` luôn được ghi kèm end_at nên đây chỉ
        # là lưới an toàn, không phải đường chạy thật.
        return _DAYS_PER_MONTH
    day = int(anchor_day) if anchor_day else end.day
    # Ngày neo phải rơi ĐÚNG vào mốc chốt của kỳ. So với ngày neo ĐÃ LÙI về cuối tháng
    # ngắn, không so với con số thô: neo 31 mà kỳ chốt tháng 6 thì `end.day` là 30 và
    # đó vẫn là KHỚP. So thô là bác bỏ luôn mọi ngày neo 29/30/31 hợp lệ rồi tính mẫu
    # số theo `end.day`, ra 31 ngày cho một chu kỳ 30 ngày.
    if end.day != min(day, calendar.monthrange(end.year, end.month)[1]):
        day = end.day
    boundary = end
    for _ in range(max(0, whole_months)):
        boundary = _boundary_prev(boundary, day)
    return max(1, (boundary - _boundary_prev(boundary, day)).days)


def cycle_units(
    cycle: MemberSubscriptionCycle, anchor_day: int | None = None
) -> _CycleUnits:
    """Tách MỘT dòng kỳ ra (số chu kỳ TRỌN, số nửa ngày lẻ, độ dài chu kỳ).

    `prorated_half_days` NULL/0 = dòng của chế độ `legacy_30d` (hoặc kỳ trọn mốc của
    chế độ mới): giữ NGUYÊN quy ước cũ "thiếu số tháng thì thu tối thiểu 1 tháng" —
    đổi chỗ này là lệch toàn bộ số liệu lịch sử.

    Có phần lẻ ⇒ dòng của `cycle_aligned`: `months` được đọc ĐÚNG NHƯ ĐANG LƯU, kể cả
    khi bằng 0 (kỳ mua giữa chu kỳ, chỉ có phần lẻ). Không có nhánh nào đọc
    `workspaces.billing_mode` ở đây: bản thân dòng kỳ đã nói nó thuộc chế độ nào, mà
    workspace thì có thể đã được gạt chế độ SAU khi kỳ này bán xong.
    """
    half_days = int(cycle.prorated_half_days or 0)
    months = int(cycle.months or 0)
    if half_days <= 0:
        return _CycleUnits(max(1, months), 0, _DAYS_PER_MONTH)
    return _CycleUnits(
        max(0, months), half_days, _cycle_length_days(cycle, months, anchor_day)
    )


def cycle_amount(
    units: _CycleUnits,
    per_month: int,
    round_to: int,
    *,
    months_price: Callable[[int], int] | None = None,
) -> int:
    """Thành tiền của MỘT dòng kỳ = các chu kỳ TRỌN + phần lẻ (EXPIRY_RULES §3.6.5).

    Một chu kỳ TRỌN = đúng MỘT đơn giá tháng, bất kể chu kỳ dài 28 hay 31 ngày —
    giống hệt cách ChatGPT tính cho ta. Phần lẻ đi qua `payment_flow.prorated_fee` để
    làm tròn LÊN đúng bội `price_round_to_vnd`, dùng chung hàm với lúc BÁN nên báo cáo
    và số tiền đã thu không thể lệch nhau.

    `months_price` = cách tính tiền phần TRỌN, mặc định "đơn giá × số tháng". Nhánh
    CANVA truyền hàm tra BẢNG BẬC vào đây (mua càng dài càng rẻ nên KHÔNG được nhân
    đơn giá lên); Canva không dùng chế độ `cycle_aligned` nên phần lẻ của nó luôn 0 và
    đường tiền của Canva giữ nguyên như trước.
    """
    whole = (
        months_price(units.whole_months)
        if months_price is not None
        else per_month * units.whole_months
    )
    return whole + payment_flow.prorated_fee(
        per_month, units.half_days, units.cycle_days, round_to
    )


def cycle_seat_months(units: _CycleUnits) -> float:
    """Seat-THÁNG mà một dòng kỳ đã bán — mẫu số của "giá bán TB / seat".

    Phần lẻ quy ra tỷ lệ của chu kỳ nó nằm trong (nửa ngày ÷ 2 ÷ số ngày chu kỳ) chứ
    KHÔNG làm tròn lên thành một tháng: cộng tròn tháng cho một kỳ 22 ngày là kéo giá
    bán trung bình mỗi ghế xuống thấp hơn thực tế. Dòng `legacy_30d` có phần lẻ 0 nên
    trả về đúng số nguyên như trước.
    """
    lele = units.half_days / (2 * units.cycle_days) if units.cycle_days > 0 else 0.0
    return units.whole_months + lele


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


def _starts_new_stint(prev_end: datetime | None, start: datetime) -> bool:
    """Kỳ này MỞ ĐẦU một đợt tham gia mới? (⇒ tiền của nó là PHÍ MỜI, không phải gia
    hạn). Kỳ đầu tiên luôn đúng; các kỳ sau chỉ đúng khi bắt đầu SAU hạn kỳ trước quá
    1 phút — tức có khoảng hết hạn xen giữa (email bị gỡ rồi mời lại).

    Chỉ tính lệch MỘT CHIỀU: kỳ bắt đầu TRƯỚC hạn kỳ trước (chồng lấn, do chỉnh tay)
    vẫn là gia hạn — chồng lấn không phải khoảng ngừng. Sai số 1 phút cho mốc chỉnh
    tay."""
    if prev_end is None:
        return True
    return (start - prev_end).total_seconds() > 60


def _fallback_span(units: _CycleUnits) -> timedelta:
    """Độ dài suy ra cho một kỳ THIẾU `end_at` (dữ liệu cũ) — chỉ để có quãng mà rải
    tiền theo ngày, không dùng để tính tiền.

    Kỳ có phần lẻ phải cộng cả phần lẻ vào: kỳ thuần phần lẻ có `months = 0`, lấy
    tháng×30 sẽ ra quãng RỖNG và toàn bộ doanh thu của kỳ đó biến mất khỏi biểu đồ.
    """
    days = _DAYS_PER_MONTH * units.whole_months + units.half_days / 2
    return timedelta(days=days or _DAYS_PER_MONTH)


def _member_revenue_events(
    member: Member, now: datetime, anchor_day: int | None = None
) -> list[tuple[bool, _CycleUnits, datetime, datetime]]:
    """Danh sách kỳ tính tiền của member → (is_invite, units, start, end).

    - `is_invite`: kỳ MỞ ĐẦU một đợt tham gia (phí mời) vs gia hạn (nối tiếp kỳ trước).
      KHÔNG dùng `cycle_number == 1`: từ 31/8/2026 lịch sử kỳ được giữ qua các lần mời
      lại, nên email hết hạn rồi mời lại có kỳ mở đầu mang số 2, 3… Dấu hiệu đúng là
      KHOẢNG TRỐNG: kỳ không nối liền kỳ trước ⇒ đợt mới ⇒ phí mời.
    - `units`: đơn vị tính tiền của kỳ (`cycle_units` — chu kỳ trọn + phần lẻ). Trả về
      ĐƠN VỊ chứ không phải số tháng vì kỳ của chế độ `cycle_aligned` có phần lẻ không
      nhét vào số nguyên tháng được; `cycle_amount` mới ra thành tiền.
    - `start`: mốc bắt đầu kỳ (kỳ 1 = ngày tham gia; gia hạn = hạn cũ).
    - `end`: mốc hết kỳ — phí được RẢI ĐỀU trên [start, end). Thiếu end_at (dữ liệu
      cũ) → suy độ dài từ chính đơn vị của kỳ (`_fallback_span`).

    `anchor_day` = ngày chốt chu kỳ của workspace chứa member, chỉ dùng để suy độ dài
    chu kỳ cho kỳ có phần lẻ (xem `_cycle_length_days`); None vẫn chạy đúng cho mọi
    workspace ở chế độ cũ.

    Ưu tiên các chu kỳ đã vật chất hoá; member có hạn nhưng CHƯA có kỳ nào (mời trước
    bảng cycles) → suy 1 kỳ mời phủ [ngày tham gia → hạn]. Vô thời hạn (không hạn,
    không kỳ) → không có phí (owner/free)."""
    cycles = sorted(member.subscription_cycles, key=lambda c: c.cycle_number)
    if cycles:
        out: list[tuple[bool, _CycleUnits, datetime, datetime]] = []
        prev_end: datetime | None = None
        for c in cycles:
            start = c.start_at or c.paid_at or member.created_at
            if start is None:
                continue
            units = cycle_units(c, anchor_day)
            end = c.end_at
            if end is None or end <= start:
                end = start + _fallback_span(units)
            out.append((_starts_new_stint(prev_end, start), units, start, end))
            prev_end = end
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
    # Member chưa có dòng kỳ nào thì cũng chưa có phần lẻ nào để đọc — suy nguyên
    # tháng như trước.
    return [
        (
            True,
            _CycleUnits(months, 0, _DAYS_PER_MONTH),
            anchor,
            member.subscription_end_at,
        )
    ]


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

    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)
    # RAM: chỉ lấy 5 cột báo cáo thực sự đọc, thay vì nạp nguyên ORM User của mọi
    # tài khoản vào identity map. Nội dung dùng tới không đổi (xem _OwnerInfo).
    users: dict[UUID, _OwnerInfo] = {
        row.id: _OwnerInfo(
            row.id,
            row.username,
            row.email,
            row.is_test,
            row.invite_fee_vnd,
            row.canva_price_tiers,
        )
        for row in db.execute(
            select(
                User.id,
                User.username,
                User.email,
                User.is_test,
                User.invite_fee_vnd,
                User.canva_price_tiers,
            )
        )
    }
    # Nhánh + NGÀY CHỐT CHU KỲ của từng workspace, đọc một lần (vài dòng) — vòng quét
    # member bên dưới không join workspace để giữ nguyên cách đọc theo lô. Ngày chốt
    # chỉ dùng để suy độ dài chu kỳ cho kỳ có phần lẻ (`cycle_units`); workspace ở chế
    # độ cũ không có phần lẻ nên con số này không đụng tới số liệu của họ.
    ws_platform: dict[UUID, str] = {}
    ws_anchor_day: dict[UUID, int | None] = {}
    for row in db.execute(
        select(
            Workspace.id,
            Workspace.platform,
            Workspace.cycle_anchor_day,
            Workspace.renewal_date,
        )
    ):
        ws_platform[row.id] = row.platform
        ws_anchor_day[row.id] = workspace_anchor_day(
            row.cycle_anchor_day, row.renewal_date
        )
    # Bảng giá Canva MẶC ĐỊNH của hệ thống, dùng khi đại lý chưa có bảng riêng.
    default_canva_tiers = canva_price.normalize_tiers(settings_row.canva_price_tiers)
    # Bước làm tròn của PHẦN LẺ ở chế độ `cycle_aligned` — đọc từ cấu hình, không
    # hard-code (EXPIRY_RULES §3.6.6). Phải là ĐÚNG bước đã dùng lúc bán, kẻo báo cáo
    # lệch vài trăm đồng mỗi kỳ so với số tiền thật đã trừ ví.
    price_round_to = int(settings_row.price_round_to_vnd or PRICE_ROUND_TO_VND_DEFAULT)
    revenue_by_platform: dict[str, int] = {PLATFORM_GPT: 0, PLATFORM_CANVA: 0}
    cost_by_platform: dict[str, int] = {PLATFORM_GPT: 0, PLATFORM_CANVA: 0}

    def _canva_tiers_for(owner: _OwnerInfo | None) -> list[dict]:
        own = canva_price.normalize_tiers(owner.canva_price_tiers) if owner else []
        return own or default_canva_tiers or [dict(t) for t in canva_price.DEFAULT_TIERS]

    # ── THU: kỳ mở trong khoảng (loại test + chủ workspace) ─────────────────────
    revenue_invite = 0
    revenue_renew = 0
    # Tổng seat-tháng ĐÃ BÁN trong kỳ (Σ seat-tháng của các chu kỳ được thu tiền) —
    # mẫu số của "giá bán TB / seat". SỐ THỰC vì kỳ của chế độ `cycle_aligned` bán lẻ
    # ngày (xem `cycle_seat_months`); chế độ cũ vẫn ra đúng số nguyên như trước.
    seat_months_sold = 0.0
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
            platform = ws_platform.get(m.workspace_id, PLATFORM_GPT)
            anchor_day = ws_anchor_day.get(m.workspace_id)
            if platform == PLATFORM_CANVA:
                # Canva bán theo GÓI: tiền của một kỳ tra thẳng bảng bậc theo số
                # tháng của kỳ đó, KHÔNG nhân đơn giá (mua 12 tháng rẻ hơn 12 lần
                # mua 1 tháng — nhân lên là báo cáo thổi doanh thu lên gấp rưỡi).
                # Canva KHÔNG dùng chế độ neo-theo-chu-kỳ (không có hoá đơn business
                # để neo) nên kỳ của nó không bao giờ có phần lẻ.
                tiers = _canva_tiers_for(owner)
                per_month = 0

                def months_price(n: int, _tiers: list[dict] = tiers) -> int:
                    return canva_price.fee_for_months(_tiers, n)
            else:
                per_month = _member_per_month_fee(m, owner, default_fee)
                if per_month <= 0:
                    continue
                months_price = None
            owner_key = m.invited_by_user_id  # có thể None → nhóm "chưa có chủ"
            # Chỉ chu kỳ ĐÃ ĐÁNH DẤU TRẢ (chưa trả = công nợ, không phải doanh thu),
            # tính vào tháng BẮT ĐẦU KỲ — KHÔNG dùng paid_at (chốt user 2026-08-12).
            # Lý do: paid_at là lúc bấm đánh dấu, không phải lúc tiền về. Ngày
            # 13/07/2026 (SePay go-live) có 172 kỳ được chốt cùng lúc, trong đó
            # 44,7tr là tiền của tháng 5 và 6 — dồn hết vào tháng 7 làm sai cả ba
            # tháng. start_at là dữ liệu thật, không phụ thuộc thao tác chốt sổ.
            # Đánh dấu TRƯỚC kỳ nào là phí mời (kỳ mở đầu một đợt tham gia) — phải
            # duyệt TRỌN danh sách theo thứ tự, kể cả kỳ chưa trả hay ngoài khoảng
            # lọc, vì "nối liền hay không" đo bằng kỳ ngay trước nó.
            ordered = sorted(m.subscription_cycles, key=lambda c: c.cycle_number)
            invite_cycle_ids: set = set()
            prev_end: datetime | None = None
            for c in ordered:
                c_start = c.start_at or c.paid_at
                if c_start is None:
                    continue
                if _starts_new_stint(prev_end, c_start):
                    invite_cycle_ids.add(c.id)
                # Thiếu end_at (dữ liệu cũ) → suy từ months, giống _member_revenue_events;
                # để prev_end tụt lại kỳ trước nữa thì kỳ sau bị chấm nhầm là "có khoảng
                # trống" ⇒ đếm nhầm gia hạn thành phí mời.
                prev_end = c.end_at or (
                    c_start + _fallback_span(cycle_units(c, anchor_day))
                )
            for c in ordered:
                if c.payment_status != "paid":
                    continue
                when = c.start_at or c.paid_at
                if when is None:
                    continue
                book_d = when.astimezone(timezone.utc).date()
                if book_d < from_date or book_d > to_date:
                    continue
                # KHÔNG chặn THU theo finance_start_at (đã thử và bỏ, 2026-08-12):
                # hoá đơn GPT1 ngày 11/07 trả cho 183 ghế mà phần lớn mở kỳ TRƯỚC
                # 11/07 — chặn thì mất 12tr doanh thu tháng 7 trong khi chi phí của
                # chính họ vẫn tính. Đổi một cái lệch lấy một cái lệch to hơn. Thay
                # vào đó: cảnh báo tháng nào có thu mà chưa có chi (xem months_no_cost).
                # Thành tiền đọc CẢ `months` lẫn `prorated_half_days` (§3.6.5) —
                # đọc mỗi `months` thì kỳ mua giữa chu kỳ (`months = 0`) bị ghi trọn
                # một tháng, còn kỳ "lẻ + 1 tháng" bị mất phần lẻ.
                units = cycle_units(c, anchor_day)
                amt = cycle_amount(
                    units, per_month, price_round_to, months_price=months_price
                )
                if amt <= 0:
                    continue
                revenue_by_platform[platform] = revenue_by_platform.get(platform, 0) + amt
                seat_months_sold += cycle_seat_months(units)
                agent_rev[owner_key] = agent_rev.get(owner_key, 0) + amt
                if c.id in invite_cycle_ids:
                    revenue_invite += amt
                    agent_invites[owner_key] = agent_invites.get(owner_key, 0) + 1
                else:
                    revenue_renew += amt
                    agent_renews[owner_key] = agent_renews.get(owner_key, 0) + 1
                mk = _month_key(book_d)
                if mk in rev_by_month:
                    rev_by_month[mk] += amt
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
        Workspace.bank_fee_percent,
        Workspace.platform,
    ).execution_options(yield_per=_SCAN_CHUNK)
    cost = 0
    cost_missing = 0
    # Hoá đơn trong kỳ nhưng CHƯA có chi tiết (period_*) → không tính, đếm để cảnh báo.
    cost_skipped = 0
    # Phí seat thực tế = seat_cost_basis ÷ billed_seat_months. Chỉ cộng hoá đơn suy
    # được số ghế·tháng (xem _seat_months_billed), để tử/mẫu cùng một tập hoá đơn.
    billed_seat_months = 0.0
    seat_cost_basis = 0
    for (
        ws_invoices,
        ws_finance_start_at,
        ws_created_at,
        ws_fee_pct,
        ws_platform_value,
    ) in db.execute(ws_stmt):
        invoices = ws_invoices or []
        paid = [inv for inv in invoices if inv.get("status") == "paid"]
        if not paid:
            cost_missing += 1
            continue
        # Mốc bắt đầu tính CHI: finance_start_at (backfill = đầu chu kỳ hiện tại);
        # chưa set → fallback created_at (workspace mới tính từ khi onboard).
        anchor = ws_finance_start_at or ws_created_at
        fstart = anchor.astimezone(timezone.utc).date() if anchor is not None else None
        # Đơn giá/ghế/tháng theo kỳ — hoá đơn proration mượn giá của kỳ nó thuộc về.
        price_by_end, price_dated = _unit_price_lookup(paid)
        for inv in paid:
            d = _parse_inv_date(inv, "date")
            if d is None:
                continue
            if fstart is not None and d < fstart:
                continue  # hoá đơn trước mốc = hệ thống cũ / thanh toán ngoài → bỏ
            if d < from_date or d > to_date:
                continue
            # CHỈ hoá đơn ĐÃ CÓ CHI TIẾT (period_start/period_end — tức đã dán hoặc
            # scrape được trang chi tiết) mới được tính. Chốt user 2026-08-12: "tháng
            # nào dán chi tiết hoá đơn vào thì mới cho xem". Hoá đơn chỉ có mỗi tổng
            # tiền thì chưa đủ tin để đưa vào sổ — đếm lại và cảnh báo trên giao diện
            # thay vì lặng lẽ cộng vào hoặc lặng lẽ bỏ đi.
            ps = _parse_inv_date(inv, "period_start")
            pe = _parse_inv_date(inv, "period_end")
            if ps is None or pe is None or pe <= ps:
                cost_skipped += 1
                continue
            # TIỀN MẶT: TRỌN tiền hoá đơn vào tháng PHÁT HÀNH, không chia theo ngày.
            amt = _invoice_cost(inv, ws_fee_pct)
            cost += amt
            cost_by_platform[ws_platform_value] = (
                cost_by_platform.get(ws_platform_value, 0) + amt
            )
            mk = _month_key(d)
            if mk in cost_by_month:
                cost_by_month[mk] += amt
            # Mẫu số cho PHÍ SEAT THỰC TẾ: ghế·tháng hoá đơn này THỰC SỰ trả tiền,
            # 1 kỳ = 1 tháng (không quy span ÷ 30). Xem _seat_months_billed.
            sm = _seat_months_billed(
                inv, _cycle_unit_price(inv, price_by_end, price_dated)
            )
            if sm is not None and sm > 0:
                billed_seat_months += sm
                seat_cost_basis += amt

    profit = revenue - cost

    # Seat-tháng ĐÃ BÁN trong kỳ (Σ seat-tháng của các chu kỳ thu được tiền).
    seat_months = round(float(seat_months_sold), 2)

    # Giá BÁN trung bình mỗi seat/tháng = tiền nhận ÷ seat-tháng bán ra. CỐ Ý không
    # tính "giá vốn TB" ở đây nữa: gốc tiền mặt thì CHI của tháng là hoá đơn ChatGPT
    # cho công suất cả chu kỳ, chia cho số seat-tháng BÁN ĐƯỢC sẽ ra số vô nghĩa.
    # Giá vốn/ghế đọc ở bảng "theo chu kỳ thanh toán" (cột lấp đầy).
    avg_price_per_seat = round(revenue / seat_months) if seat_months > 0 else None

    # PHÍ SEAT THỰC TẾ = tiền hoá đơn ÷ số ghế·tháng ChatGPT thu tiền (1 kỳ = 1 tháng).
    # Đây là giá ChatGPT lấy trên MỖI GHẾ, so trực tiếp được với avg_price_per_seat.
    # KHÁC "lợi nhuận ròng" của kỳ: kỳ có thể lỗ dù mỗi ghế vẫn lãi, khi tiền vào và
    # hoá đơn không rơi cùng tháng, hoặc khi còn ghế chưa bán được.
    avg_seat_cost = (
        round(seat_cost_basis / billed_seat_months) if billed_seat_months > 0 else None
    )

    monthly = [
        FinancialReportBucket(
            month=mk,
            revenue=rev_by_month[mk],
            cost=cost_by_month[mk],
            profit=rev_by_month[mk] - cost_by_month[mk],
        )
        for mk in months
    ]

    # Tháng CÓ THU mà CHI = 0 → lãi tháng đó là ảo. Xảy ra với các tháng trước
    # workspace.finance_start_at: hoá đơn ChatGPT của chúng bị loại (hệ thống cũ /
    # trả ngoài) trong khi kỳ của khách vẫn được ghi nhận. Nói ra thay vì để người
    # đọc tưởng tháng đó lãi to.
    months_no_cost = sum(1 for b in monthly if b.revenue > 0 and b.cost == 0)

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
        revenue_by_platform=PlatformSplit(
            gpt=revenue_by_platform.get(PLATFORM_GPT, 0),
            canva=revenue_by_platform.get(PLATFORM_CANVA, 0),
        ),
        cost_by_platform=PlatformSplit(
            gpt=cost_by_platform.get(PLATFORM_GPT, 0),
            canva=cost_by_platform.get(PLATFORM_CANVA, 0),
        ),
        monthly=monthly,
        by_agent=by_agent,
        cost_missing_workspaces=cost_missing,
        cost_skipped_invoices=cost_skipped,
        months_no_cost=months_no_cost,
        seat_months=seat_months,
        avg_price_per_seat=avg_price_per_seat,
        billed_seat_months=round(billed_seat_months, 2),
        avg_seat_cost=avg_seat_cost,
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
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)
    # Cùng bước làm tròn phần lẻ với báo cáo tháng, để hai màn hình không lệch nhau.
    price_round_to = int(settings_row.price_round_to_vnd or PRICE_ROUND_TO_VND_DEFAULT)
    users: dict[UUID, _OwnerInfo] = {
        row.id: _OwnerInfo(row.id, row.username, row.email, row.is_test, row.invite_fee_vnd)
        for row in db.execute(
            select(User.id, User.username, User.email, User.is_test, User.invite_fee_vnd)
        )
    }

    # ── Dựng danh sách chu kỳ từ hoá đơn (mới nhất trước, tối đa `limit` mỗi ws) ──
    # cycles: workspace_id → list[(period_start, period_end, cost, seats_start, seats)]
    cycles: dict[UUID, list[_CycleRow]] = {}
    ws_names: dict[UUID, str] = {}
    # Ngày chốt chu kỳ của workspace — chỉ để suy độ dài chu kỳ cho kỳ có phần lẻ
    # (`cycle_units`); workspace ở chế độ cũ không có phần lẻ nên không bị ảnh hưởng.
    ws_anchor_day: dict[UUID, int | None] = {}
    for wid, name, invs, fs, created, fee_pct, anchor_day_col, renewal_date in db.execute(
        select(
            Workspace.id,
            Workspace.name,
            Workspace.billing_invoices,
            Workspace.finance_start_at,
            Workspace.created_at,
            Workspace.bank_fee_percent,
            Workspace.cycle_anchor_day,
            Workspace.renewal_date,
        )
        # CHỈ nhánh ChatGPT: bảng này cắt theo CHU KỲ HOÁ ĐƠN Stripe (period_start /
        # period_end / đơn giá mỗi ghế) — team Canva không có hoá đơn nào như thế, đưa
        # vào chỉ tạo ra dòng rỗng trông như thiếu dữ liệu.
        .where(Workspace.platform == PLATFORM_GPT)
    ):
        ws_names[wid] = name
        ws_anchor_day[wid] = workspace_anchor_day(anchor_day_col, renewal_date)
        anchor = fs or created
        fstart = anchor.astimezone(timezone.utc).date() if anchor is not None else None
        # GỘP HOÁ ĐƠN THEO `period_end` = 1 chu kỳ (sửa 2026-08-25). Hoá đơn mua thêm
        # suất giữa kỳ (proration) có period = [ngày mua → ngày gia hạn] nên TRÙNG
        # period_end với kỳ đang chạy. Trước đây mỗi hoá đơn thành một dòng, hậu quả
        # thật ở CHATGPT PRO kỳ 25/07→25/08: 5 dòng ma "22/08→25/08", chi của kỳ thật
        # thiếu 369.767 đ tiền mua thêm ghế, còn THU của 3 ngày cuối bị đếm lại 4 lần
        # (mỗi dòng ma khoe "+2,7 triệu lãi"), và `limit` bị hoá đơn ma ăn hết chỗ.
        acc: dict[date, list] = {}  # period_end → [ps, cost, seats_start, seats_max]
        for inv in invs or []:
            if inv.get("status") != "paid":
                continue
            d = _parse_inv_date(inv, "date")
            if d is None or (fstart is not None and d < fstart):
                continue
            ps = _parse_inv_date(inv, "period_start")
            pe = _parse_inv_date(inv, "period_end")
            if ps is None or pe is None or pe <= ps:
                # Thiếu chu kỳ → BỎ, không suy đoán (chốt user 2026-08-12: "chỉ áp
                # dụng cho những kỳ gần đây khi paste chi tiết hoá đơn vào thôi").
                # Hoá đơn cũ chưa dán chi tiết thì không lên bảng này; dán vào là có.
                continue
            qty = int(inv.get("quantity") or 0) or None
            cur = acc.get(pe)
            if cur is None:
                acc[pe] = [ps, _invoice_cost(inv, fee_pct), qty, qty]
                continue
            cur[1] += _invoice_cost(inv, fee_pct)
            if ps < cur[0]:
                # Hoá đơn mở kỳ (gia hạn) → nó mới là mốc đầu kỳ và số ghế ĐẦU kỳ.
                cur[0], cur[2] = ps, qty
            if qty is not None and (cur[3] is None or qty > cur[3]):
                # Stripe ghi `quantity` = TỔNG suất SAU khi mua → max = ghế CUỐI kỳ.
                cur[3] = qty
        rows: list[_CycleRow] = [
            (ps, pe, cost, s_start, s_end) for pe, (ps, cost, s_start, s_end) in acc.items()
        ]
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
            anchor_day = ws_anchor_day.get(m.workspace_id)
            for _iv, units, start_dt, end_dt in _member_revenue_events(
                m, now, anchor_day
            ):
                start_d = start_dt.astimezone(timezone.utc).date()
                end_d = end_dt.astimezone(timezone.utc).date()
                # Bảng này CHỈ có nhánh ChatGPT (lọc platform ở trên) nên phần trọn
                # luôn là "đơn giá × số tháng"; phần lẻ của chế độ neo-theo-chu-kỳ
                # cộng thêm vào đây, đúng công thức §3.6.5 như báo cáo tháng.
                event_amount = cycle_amount(units, per_month, price_round_to)
                for i, (ps, pe, _c, _q0, _q) in enumerate(ws_cycles):
                    amt, days = _accrue(
                        event_amount,
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
        for i, (ps, pe, c, qty_start, qty) in enumerate(rows):
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
                    seats_start=qty_start,
                    cost=c,
                    revenue=r,
                    profit=r - c,
                    # CÔNG SUẤT lấy GHẾ CUỐI KỲ × số ngày (chốt user 2026-08-25):
                    # ghế mua thêm giữa kỳ cũng phải bán được thì mới hoà, nên đưa
                    # hết vào mẫu số dù chúng chỉ tồn tại vài ngày cuối kỳ.
                    capacity_seat_months=(
                        round(qty * total_days / _DAYS_PER_MONTH, 2) if qty else None
                    ),
                    seat_months=round(sdays.get((wid, i), 0) / _DAYS_PER_MONTH, 2),
                )
            )
    out.sort(key=lambda x: (x.period_start, x.workspace), reverse=True)
    return FinancialReportCyclesOut(cycles=out)


@router.get("/admin/report/invite-credit", response_model=dict)
def invite_credit_held(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> dict:
    """TIỀN ĐANG GIỮ ở các email mời hỏng — số để super-admin ĐỐI SOÁT.

    Từ 7/9/2026 lượt mời hỏng KHÔNG hoàn phí về ví nữa mà giữ khoản đã thu gắn với
    email (`members.invite_credit_vnd`), để lượt mời lại miễn phí. Khoản đó chỉ tắt khi
    email vào nhóm thật (`settle_invite_credit`). Trong lúc còn treo thì tiền ĐÃ THU
    mà dịch vụ CHƯA giao: báo cáo THU không được tính nó là doanh thu, nên nếu không ai
    đếm thì nó là một khoản thất thoát im lặng — đúng thứ mà cột kia sinh ra để canh.

    Ở endpoint RIÊNG chứ không phải một badge trên trang đại lý: đây là số nội bộ để
    đối chiếu sổ, đại lý không cần thấy cơ chế giữ tiền của hệ thống.

    Member thuộc tài khoản test bị loại, cùng quy ước với THU của `financial_report`.
    Chỉ đọc.
    """
    users: dict[UUID, _OwnerInfo] = {
        row.id: _OwnerInfo(
            row.id, row.username, row.email, row.is_test, row.invite_fee_vnd
        )
        for row in db.execute(
            select(User.id, User.username, User.email, User.is_test, User.invite_fee_vnd)
        )
    }
    # Gộp thẳng trong DB: bảng member lớn mà số dòng còn treo thì rất ít, quét ORM cả
    # bảng chỉ để cộng ba con số là phí vô ích.
    rows = db.execute(
        select(
            Member.invited_by_user_id,
            func.sum(Member.invite_credit_vnd),
            func.count(Member.id),
            func.min(Member.invite_credit_at),
        )
        .where(Member.invite_credit_vnd > 0)
        .group_by(Member.invited_by_user_id)
    ).all()

    total = 0
    total_members = 0
    oldest: datetime | None = None
    by_agent: list[dict] = []
    for owner_key, held, count, since in rows:
        owner = users.get(owner_key) if owner_key else None
        # Tài khoản test không phải tiền thật — loại như mọi con số khác của báo cáo.
        if owner is not None and owner.is_test:
            continue
        held = int(held or 0)
        total += held
        total_members += int(count or 0)
        if since is not None and (oldest is None or since < oldest):
            oldest = since
        by_agent.append(
            {
                "user_id": str(owner_key) if owner_key else None,
                "username": (owner.username if owner else "Chưa có chủ"),
                "email": (owner.email if owner else None),
                "held_vnd": held,
                "members": int(count or 0),
                "oldest_held_at": since.isoformat() if since is not None else None,
            }
        )
    by_agent.sort(key=lambda a: a["held_vnd"], reverse=True)
    return {
        "invite_credit_held_vnd": total,
        "invite_credit_members": total_members,
        "oldest_held_at": oldest.isoformat() if oldest is not None else None,
        "by_agent": by_agent,
    }
