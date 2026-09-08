"""Shared router + helpers cho package `members`.

Mọi sub-module (core.py, remove.py, ...) import `router` và các helper từ đây để
đăng ký endpoint lên CÙNG một APIRouter
(prefix `/api/v1/workspaces/{workspace_id}/members`).

Đây KHÔNG phải nơi chứa business logic của 1 chức năng cụ thể — chỉ những thứ
dùng chung giữa nhiều chức năng (lookup workspace, visibility filter). Mỗi chức
năng có module + file docs (.md) riêng.

⚠️ 3 HÀM CÔNG THỨC HẠN DÙNG (`_end_from_purchase`, `_extend_subscription_end`,
`_months_between`) + hằng số 30-ngày/ân-hạn-0 sống ở file này. Quy tắc đầy đủ:
`EXPIRY_RULES.md` (cùng thư mục) — NGUỒN CHÂN LÝ DUY NHẤT, KHÔNG tự chế công thức.

⚠️ Chế độ `cycle_aligned` (neo hạn vào mốc chu kỳ hoá đơn) có bộ hàm RIÊNG ở cuối
file — `workspace_cycle` / `half_days_between` / `quote_cycle`. Ba hàm 30-ngày ở
trên KHÔNG áp cho chế độ đó. Xem `EXPIRY_RULES.md` §3.6.
"""

import calendar
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    BILLING_MODE_CYCLE_ALIGNED,
    CYCLE_CUTOFF_UTC_DEFAULT,
    CYCLE_FORCE_EXTRA_FROM_DAY_DEFAULT,
    PLATFORM_GPT,
    Member,
    MemberSubscriptionCycle,
    PaymentSettings,
    QueueItem,
    User,
    WalletTransaction,
    Workspace,
)

router = APIRouter(
    prefix="/api/v1/workspaces/{workspace_id}/members", tags=["members"]
)

# Subscription tracking: 1 tháng = 30 ngày cứng (theo spec user). Đặt const để
# tránh magic number rải rác. ChatGPT bill day 11 của tháng → admin set
# subscription_months cho từng member, end_at = created_at + months × 30 days.
SUBSCRIPTION_DAYS_PER_MONTH = 30

# Ân hạn sau khi hết hạn: 0 — hết hạn là xoá NGAY, không chờ (yêu cầu user
# 2026-07-10). Dùng CHUNG cho cả endpoint `cleanup-expired` (remove.py) lẫn
# scheduler nền (main.py) để 2 nơi luôn cùng rule — xem remove.md §4.
SUBSCRIPTION_GRACE_AFTER_EXPIRY = timedelta(0)

# ÂN HẠN QUYỀN SỞ HỮU — khác hẳn ân hạn XOÁ ngay trên (chốt user 2026-09-07). Gói
# hết hạn thì email bị gỡ khỏi workspace ngay, nhưng nó vẫn còn là KHÁCH CỦA ĐẠI LÝ
# đã bán: khách trả tiền muộn vài hôm là chuyện thường, và trong lúc đó không ai
# được nhận email đó thành của mình. Hết 30 ngày mà vẫn không thanh toán thì email
# mới thành vô chủ, ai mời cũng được.
OWNERSHIP_GRACE_AFTER_EXPIRY = timedelta(days=30)


def ownership_cutoff(now: datetime) -> datetime:
    """Mốc `subscription_end_at` sớm nhất mà quyền sở hữu CÒN được giữ. Gói hết hạn
    trước mốc này = đã quá 30 ngày không thanh toán → email vô chủ."""
    return now - OWNERSHIP_GRACE_AFTER_EXPIRY


def ownership_still_held(member: Member, now: datetime) -> bool:
    """Email này còn thuộc về ai không?

    CHỦ = NGƯỜI MỜI ĐẦU TIÊN, không phải người bấm nút gần nhất (chốt user
    2026-09-07). Còn hạn (hoặc vô thời hạn) → còn chủ; hết hạn → còn chủ thêm 30
    ngày ân hạn; sau đó vô chủ."""
    if member.invited_by_user_id is None:
        return False
    if member.subscription_end_at is None:
        return True
    return member.subscription_end_at > ownership_cutoff(now)


def claim_ownership(member: Member, user_id: UUID, now: datetime) -> None:
    """Gán chủ cho lệnh mời — CHỈ khi email đang VÔ CHỦ (chưa ai mời, hoặc chủ cũ đã
    hết 30 ngày ân hạn).

    Trước 7/9/2026 mọi lệnh mời đều `invited_by_user_id = user.id`, nên chỉ cần
    super-admin bấm "Mời lại" hộ một đại lý (lời mời của họ hỏng giữa chừng) là email
    ĐỔI CHỦ sang admin — mất khỏi sổ của đại lý, dù tiền vẫn là tiền họ trả. Mời hộ
    là giúp một lượt gọi, không phải sang tên. Xem `ownership.md`."""
    if not ownership_still_held(member, now):
        member.invited_by_user_id = user_id


def _end_from_purchase(
    purchased_at: datetime, months: int | None
) -> datetime | None:
    """Hạn = MỐC NEO (ngày gia hạn / ngày add đầu tiên / ngày mua) + months×30 ngày
    CHÍNH XÁC (giữ nguyên giờ tới giây, KHÔNG chốt cuối ngày, KHÔNG dư dù 1 giây).

    Quy tắc DUY NHẤT cho hạn dùng (yêu cầu user 2026-07-06):
    **Ngày hết hạn = Ngày gia hạn + 30×tháng**. Ngày gia hạn (mốc neo) lưu ở
    `subscription_purchased_at`; INVITE set = giờ gửi lệnh mời (chính xác tới giây),
    SYNC lần đầu set = giờ ghi nhận, modal Đổi hạn set = ngày mua admin nhập.

    Ví dụ neo 5/7 10:15:38, gói 1 tháng → 4/8 10:15:38 (đúng 30 ngày). Dùng CHUNG
    cho invite / reconcile / subscription — không còn nhánh chốt-cuối-ngày (bỏ mô
    hình `-1` ngày cũ vốn cho ra 3/8 23:59:59)."""
    if months is None or months <= 0:
        return None
    return purchased_at + timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)


def _period_is_funded(member: Member, now: datetime) -> bool:
    """Kỳ ĐANG CHẠY của member có TIỀN phía sau không.

    "Đã thanh toán" ở đây đọc từ nhãn nghiệp vụ, KHÔNG đọc sổ ví: mời/gia hạn luôn
    dựng chu kỳ `paid` (`_apply_invite_paid_cycle`) cho MỌI tài khoản, kể cả tài
    khoản được miễn phí (super-admin, đại lý chưa bật Ví) vốn không có một bút toán
    nào. Bắt phải có bút toán là cắt nhầm cả nhóm đó — 49 member ngày 3/9/2026.

    Đủ MỘT trong hai là có tiền:
      • `member.payment_status == 'paid'` — nhãn tổng hợp cấp member; hoặc
      • còn một chu kỳ `paid` PHỦ hiện tại (`end_at` None = chưa biết phủ tới đâu,
        tính là còn phủ — cùng cách đọc với `_drop_open_cycles`).

    Chu kỳ `paid` của các ĐỢT ĐÃ KẾT THÚC không tính: tiền đợt trước không trả cho
    cửa sổ đang chạy.

    Hai đường ghi nợ đều hạ nhãn về `unpaid` nên tự động rơi vào đây: hoàn phí +
    void kỳ (`void_refunded_invite_periods`) và hoàn phí khi member đang `active`
    (`flag_refunded_invite_debt`)."""
    if member.payment_status == "paid":
        return True
    return any(
        c.payment_status == "paid" and (c.end_at is None or c.end_at > now)
        for c in member.subscription_cycles
    )


def _funded_period_clause(now: datetime):
    """Bản SQL của `_period_is_funded` (dùng cho truy vấn quét nhiều member cùng
    lúc). Giữ HAI vế y hệt bản Python — lệch một vế là hai đường ra hai giá phí."""
    return or_(
        Member.payment_status == "paid",
        select(MemberSubscriptionCycle.id)
        .where(
            MemberSubscriptionCycle.member_id == Member.id,
            MemberSubscriptionCycle.payment_status == "paid",
            or_(
                MemberSubscriptionCycle.end_at.is_(None),
                MemberSubscriptionCycle.end_at > now,
            ),
        )
        .exists(),
    )


def _is_paid_period_active(member: Member, now: datetime) -> bool:
    """CÒN HẠN **VÀ ĐÃ CÓ TIỀN**: mốc hết hạn cụ thể còn ở tương lai
    (`subscription_end_at` không None và > now) VÀ kỳ đang chạy có tiền phía sau
    (`_period_is_funded`). Ân hạn = 0 (mirror rule cleanup-expired/scheduler).

    Dùng để quyết định MỜI LẠI MIỄN PHÍ: email còn hạn bị xoá → mời lại KHÔNG tính
    phí và GIỮ NGUYÊN cửa sổ hạn + chu kỳ đã thanh toán (đã trả tiền cho kỳ này rồi,
    xoá không hoàn tiền → mời lại chỉ là tiếp tục kỳ cũ, không phải chu kỳ mới).

    ⚠️ VẾ "ĐÃ CÓ TIỀN" THÊM 3/9/2026 — CA THẬT `uochenchieudong` (task e29569d3).
    Trước đó hàm này CHỈ đọc `subscription_end_at`, tức tin rằng hễ có hạn thì đã có
    người trả. Không đúng: `reconcile.py` cấp gói mặc định 30 ngày cho MỌI dòng nó
    dựng ra khi đồng bộ thấy email lạ trong workspace (xem `EXPIRY_RULES.md` §3.5).
    Chuỗi ngày hôm đó: mời 14:44 (thu 330.000đ) → 14:55 verify đọc không ra, chốt
    hỏng, HOÀN phí + xoá bản ghi → 15:23 đồng bộ thấy lời mời vẫn nằm trong tab Lời
    mời nên DỰNG LẠI member kèm hạn tới 3/10 → 15:48 gỡ tay → 15:54 mời lại: "còn
    hạn" ⇒ miễn phí. Email dùng trọn 30 ngày, thực thu 0đ.
    `void_refunded_invite_periods` đã làm đúng phần của nó (hoàn phí thì void kỳ);
    cái phá luật là hạn do ĐỒNG BỘ dựng lại từ bên ngoài, không có đồng nào phía sau.

    VÔ THỜI HẠN (`subscription_end_at` None) KHÔNG tính là "còn hạn" — 'vô hạn' là
    khái niệm khác 'còn hạn', giữ hành vi mời-lại cũ (reset cửa sổ + tính phí 1 kỳ)."""
    if member.subscription_end_at is None or member.subscription_end_at <= now:
        return False
    return _period_is_funded(member, now)


def find_movable_paid_members(
    db: Session,
    *,
    emails: list[str],
    exclude_workspace_id: UUID,
    owner_id: UUID,
    now: datetime,
    platform: str = PLATFORM_GPT,
) -> dict[str, "Member"]:
    """Tìm member CÓ THỂ CHUYỂN WORKSPACE miễn phí: cùng email, CÙNG CHỦ SỞ HỮU
    (`invited_by_user_id == owner_id`), đã `removed` khỏi workspace KHÁC, CÒN HẠN
    (`subscription_end_at` > now) và kỳ đó ĐÃ CÓ TIỀN (`_funded_period_clause`).

    Ca dùng — "add nhầm workspace" (user 2026-07-16): email đã THANH TOÁN, bị gỡ khỏi
    ws SAI, giờ mời sang ws ĐÚNG. Vì MỌI truy vấn member đều lọc theo `workspace_id`
    nên nếu không có helper này, mời sang ws khác bị coi là email MỚI → TÍNH PHÍ LẠI
    oan. Caller (`perform_invite_core`) sẽ CHUYỂN nguyên record sang ws mới (đổi
    `workspace_id`, giữ `member.id` → cửa sổ hạn + chu kỳ đã thanh toán gắn theo
    `member_id` tự đi theo), đặt `pending`, KHÔNG tính phí. Xem
    [[cross-workspace-move-keeps-paid]] / [[reinvite-still-valid-is-free]].

    Chỉ xét `removed` — KHÔNG đụng email đang `active`/`pending` ở ws khác (đang dùng /
    đang mời dở nơi khác, không được "cướp" đi). Cơ chế chủ sở hữu (`_assert_email_
    ownership`) đã chặn email của tài khoản KHÁC trước khi tới đây. Nhiều ứng viên →
    chọn kỳ hạn XA NHẤT (`order_by end desc`). Trả {email_lowercase: member}.

    CHỈ TRONG CÙNG NHÁNH (`platform`): gói ChatGPT còn hạn không được "dời" sang team
    Canva — hai nhánh khác giá, khác dịch vụ, dời qua là vừa mất doanh thu vừa tặng
    khách một chỗ họ chưa trả tiền."""
    if not emails:
        return {}
    rows = (
        db.execute(
            select(Member)
            .join(Workspace, Workspace.id == Member.workspace_id)
            .where(
                Member.email.in_([e.lower() for e in emails]),
                Member.invited_by_user_id == owner_id,
                Member.workspace_id != exclude_workspace_id,
                Workspace.platform == platform,
                Member.status == "removed",
                Member.subscription_end_at.isnot(None),
                Member.subscription_end_at > now,
                # Cùng vế "đã có tiền" của `_is_paid_period_active` (thêm 3/9/2026):
                # hạn do ĐỒNG BỘ dựng ra không có đồng nào phía sau, dời nó sang ws
                # khác miễn phí là nhân bản đúng lỗ vừa bịt ở nhánh mời lại. Ca thật
                # nằm sẵn trong DB hôm đó: `haiquynh.hcfarm` (GPT1, `removed`, hạn
                # tới 30/9, chưa từng có bút toán lẫn chu kỳ nào).
                _funded_period_clause(now),
            )
            .order_by(Member.subscription_end_at.desc())
        )
        .scalars()
        .all()
    )
    out: dict[str, Member] = {}
    for m in rows:
        out.setdefault(m.email, m)  # kỳ hạn xa nhất (order desc) thắng
    return out


def _extend_subscription_end(
    current_end: datetime, months: int | None
) -> datetime | None:
    """GIA HẠN: cộng tiếp từ hạn hiện tại (đã là mốc cuối ngày 23:59:59) → cộng
    ĐÚNG months×30 ngày, KHÔNG chốt lại (giữ nguyên 23:59:59). Không dư ngày.

    Ví dụ current_end=3/8 23:59:59, gia hạn 1 tháng → 2/9 23:59:59 (thêm đúng 30 ngày).
    """
    if months is None or months <= 0:
        return None
    return current_end + timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)


def _months_between(start_at: datetime, end_at: datetime) -> int:
    """Số THÁNG (đơn vị 30 ngày) của khoảng [start → end], làm tròn, tối thiểu 1.
    Dùng khi chỉ biết cửa sổ (đổi hạn theo ngày / vật chất hoá) mà không biết số tháng
    lần mua."""
    days = (end_at - start_at).total_seconds() / 86400.0
    return max(1, round(days / SUBSCRIPTION_DAYS_PER_MONTH))


def _append_paid_cycle(
    member: Member,
    *,
    start_at: datetime | None,
    end_at: datetime | None,
    months: int | None,
    actor_id: UUID | None,
    now: datetime,
    prorated_half_days: int | None = None,
) -> None:
    """Nối MỘT chu kỳ ĐÃ THANH TOÁN phủ [start_at → end_at].

    Mô hình chu kỳ (chốt user 2026-07-13): **1 LẦN MUA = 1 chu kỳ** — mua gộp N tháng
    thì gộp cả N vào 1 kỳ (`months=N`), KHÔNG tách thành N kỳ 1-tháng. Phí (ví/QR) luôn
    thu TRƯỚC nên kỳ sinh ra là 'paid' NGAY (không còn 'chưa thanh toán'/duyệt thủ công).
    `months` = số tháng lần mua (biết trước) hoặc suy từ cửa sổ. `cycle_number` nối tiếp
    max hiện có. No-op nếu khoảng rỗng. Xem [[subscription-cycle-model]].

    `prorated_half_days` chỉ có ở chế độ `cycle_aligned`: kỳ đầu thường lẻ ngày nên
    không nhét vào `months` nguyên được (EXPIRY_RULES §3.6.7). Chế độ cũ để None."""
    if start_at is None or end_at is None or end_at <= start_at:
        return
    next_number = (
        max((c.cycle_number for c in member.subscription_cycles), default=0) + 1
    )
    member.subscription_cycles.append(
        MemberSubscriptionCycle(
            cycle_number=next_number,
            months=months if months is not None else _months_between(start_at, end_at),
            prorated_half_days=prorated_half_days,
            start_at=start_at,
            end_at=end_at,
            payment_status="paid",
            paid_at=now,
            paid_marked_by_id=actor_id,
        )
    )


def _clamp_future(dt: datetime | None, now: datetime) -> datetime | None:
    """Kẹp mốc rơi vào TƯƠNG LAI về `now` (dữ liệu chỉnh tay có thể cho mốc > now)
    để kỳ không bắt đầu sau hôm nay → tránh khoảng còn-hạn không được phủ."""
    if dt is not None and dt > now:
        return now
    return dt


def _first_cycle_anchor(member: Member, now: datetime) -> datetime | None:
    """Mốc bắt đầu KỲ 1 = **ngày tham gia** (`joined_at`) — chốt user 2026-07-13: ngày
    tham gia đầu tiên CHÍNH LÀ ngày gia hạn đầu tiên, BẤT BIẾN. Fallback khi thiếu
    joined_at. Kẹp về now nếu lỡ rơi tương lai."""
    anchor = (
        member.joined_at
        or member.subscription_purchased_at
        or member.last_invited_at
        or member.created_at
    )
    return _clamp_future(anchor, now)


def _ensure_cycles_materialized(
    member: Member,
    *,
    now: datetime,
    actor_id: UUID | None,
    db: Session | None = None,
) -> None:
    """Member CÓ hạn nhưng CHƯA có chu kỳ nào (mời trước khi có bảng cycles / vô thời
    hạn cũ) → vật chất hoá 1 chu kỳ ĐÃ THANH TOÁN phủ [ngày tham gia → hạn] (months suy
    từ cửa sổ). Gọi TRƯỚC khi nối kỳ mới để lịch sử liền mạch. No-op nếu đã có chu kỳ.

    ⚠️ Ở chế độ `cycle_aligned` KHÔNG được để `months=None`: khi đó `_append_paid_cycle`
    suy bằng `_months_between`, mà kỳ đầu của chế độ này thường lẻ (vd 20,5 ngày) nên
    `round(20,5/30)` ra 1 — lịch sử kỳ nói khách đã mua TRỌN MỘT THÁNG cho quãng chưa
    tới ba tuần. `sold_window` đọc lại đúng cửa sổ đã bán từ hai mốc trên bản ghi.
    """
    if member.subscription_cycles or member.subscription_end_at is None:
        return
    start_at = _first_cycle_anchor(member, now)
    months: int | None = None
    prorated: int | None = None
    ws = getattr(member, "workspace", None)
    if ws is not None and is_cycle_aligned(ws) and start_at is not None:
        try:
            prorated, _cycle_days, months = sold_window(
                ws,
                join_at=start_at,
                end_at=member.subscription_end_at,
                settings_row=cycle_settings(db) if db is not None else None,
            )
        except HTTPException:
            # Chưa có mốc chu kỳ → để nguyên đường cũ, đừng chặn lượt gia hạn.
            months, prorated = None, None
    _append_paid_cycle(
        member,
        start_at=start_at,
        end_at=member.subscription_end_at,
        months=months,  # None ⇒ suy từ cửa sổ (chế độ 30-ngày)
        prorated_half_days=prorated,
        actor_id=actor_id,
        now=now,
    )


def _trim_cycles_to_end(
    member: Member, end_at: datetime | None, *, now: datetime
) -> None:
    """Đổi hạn RÚT NGẮN / VÔ THỜI HẠN: bỏ các chu kỳ vượt hạn mới.

    - end_at None (vô thời hạn) → bỏ các kỳ CÒN HIỆU LỰC (vô hạn không có kỳ tính
      tiền), nhưng GIỮ kỳ của các đợt đã kết thúc: chuyển một ghế sang vô thời hạn
      không xoá được tiền đã thu của những đợt trước đó.
    - Ngược lại: bỏ kỳ bắt đầu từ hạn mới trở đi (start_at ≥ end_at); kỳ còn lại mà
      kết thúc sau hạn mới → cắt end_at về đúng hạn mới. (delete-orphan tự xoá row.)"""
    if end_at is None:
        member.subscription_cycles = [
            c
            for c in member.subscription_cycles
            if c.end_at is not None and c.end_at <= now
        ]
        return
    kept: list[MemberSubscriptionCycle] = []
    for c in member.subscription_cycles:
        if c.start_at is not None and c.start_at >= end_at:
            continue
        if c.end_at is not None and c.end_at > end_at:
            c.end_at = end_at
            # Cắt kỳ → cập nhật lại số tháng cho khớp cửa sổ mới.
            if c.start_at is not None:
                c.months = _months_between(c.start_at, end_at)
        kept.append(c)
    member.subscription_cycles = kept


def _rebuild_paid_cycles(
    db: Session, member: Member, *, actor_id: UUID | None, now: datetime
) -> None:
    """Dựng LẠI 1 chu kỳ ĐÃ THANH TOÁN từ [mốc gia hạn mới → hạn] của member.

    Dùng khi RE-ANCHOR (sửa "Ngày gia hạn"): cả cửa sổ dời theo mốc gia hạn VỪA ĐẶT
    (`subscription_purchased_at`), nên bỏ kỳ của ĐỢT HIỆN TẠI rồi dựng lại (months suy
    từ cửa sổ). Kỳ của các đợt đã kết thúc TRƯỚC mốc neo mới được giữ — sửa ngày gia
    hạn của đợt này không xoá được hoá đơn các đợt trước. Vô thời hạn (hạn None) →
    đợt hiện tại không còn kỳ."""
    anchor = _clamp_future(
        member.subscription_purchased_at or member.joined_at, now
    )
    _drop_open_cycles(db, member, boundary=anchor or now)
    _append_paid_cycle(
        member,
        start_at=anchor,
        end_at=member.subscription_end_at,
        months=None,
        actor_id=actor_id,
        now=now,
    )


def _mark_member_paid(member: Member, *, now: datetime, actor_id: UUID | None) -> None:
    """Đồng bộ trạng thái thanh toán TỔNG HỢP cấp member sau khi cycles thay đổi.

    Mô hình mới: mọi chu kỳ đều 'paid' → member 'paid' (còn kỳ) hoặc giữ 'paid' khi
    vô thời hạn (không kỳ). Dọn mọi dấu vết chờ duyệt cũ (requested)."""
    member.payment_status = "paid"
    member.paid_at = now
    member.paid_marked_by_id = actor_id
    member.payment_requested_at = None
    member.payment_requested_by_id = None


def _apply_invite_paid_cycle(
    db: Session,
    member: Member,
    *,
    months: int | None,
    actor_id: UUID | None,
    now: datetime,
) -> None:
    """MỜI = phí thu TRƯỚC (ví/QR) → member ĐÃ THANH TOÁN NGAY (nhất quán với renew,
    chốt user 2026-07-13: không còn 'chưa thanh toán'/duyệt thủ công cho email mới mời).

    Dựng 1 chu kỳ 'paid' phủ [ngày gia hạn → hạn] rồi đồng bộ trạng thái member.

    Chỉ bỏ kỳ CÒN PHỦ cửa sổ mới (mời lại khi đang `pending`: lượt mời trước chưa dùng
    tới, cửa sổ bị đặt lại nên kỳ cũ phải nhường chỗ). Kỳ của các ĐỢT ĐÃ KẾT THÚC được
    GIỮ: email hết hạn bị gỡ rồi vài tuần sau mời lại vẫn là tiền đã thu có hoá đơn
    trong ví, xoá đi là lệch sổ (user báo 31/8/2026). Kỳ mới nối số tiếp (Kỳ 2, 3…) và
    cách kỳ trước một khoảng — chính khoảng đó đánh dấu "đợt mới", xem
    `current_stint_cycles`. Vô thời hạn (hạn None) → không nối kỳ nhưng member vẫn
    'paid'. Xem [[subscription-cycle-model]]."""
    start_at = _clamp_future(member.subscription_purchased_at, now)
    _drop_open_cycles(db, member, boundary=start_at or now)
    # Chế độ `cycle_aligned`: `months` truyền vào là SỐ MỐC khách yêu cầu, không phải
    # phân rã thật của lần bán. Kỳ đầu thường lẻ (vd 20,5 ngày) nên phải ghi cả phần
    # lẻ, không thì lịch sử kỳ nói khách mua trọn một tháng cho quãng chưa tới ba
    # tuần — và đó chính là con số người ta mở ra đối soát. Xem EXPIRY_RULES §3.6.7.
    cycle_months, prorated = months, None
    ws = getattr(member, "workspace", None)
    if (
        ws is not None
        and is_cycle_aligned(ws)
        and start_at is not None
        and member.subscription_end_at is not None
    ):
        try:
            prorated, _days, cycle_months = sold_window(
                ws,
                join_at=start_at,
                end_at=member.subscription_end_at,
                settings_row=cycle_settings(db),
            )
        except HTTPException:
            # Chưa có mốc chu kỳ → giữ đường cũ, đừng chặn lượt mời.
            cycle_months, prorated = months, None
    _append_paid_cycle(
        member,
        start_at=start_at,
        end_at=member.subscription_end_at,
        months=cycle_months,
        prorated_half_days=prorated,
        actor_id=actor_id,
        now=now,
    )
    _mark_member_paid(member, now=now, actor_id=actor_id)


def _drop_open_cycles(db: Session, member: Member, *, boundary: datetime) -> None:
    """Bỏ các chu kỳ CÒN PHỦ mốc `boundary` (end_at > boundary), GIỮ NGUYÊN các kỳ đã
    kết thúc trước đó.

    Dùng ở các đường "dựng lại cửa sổ hiện tại" (mời lại tính phí, void hoàn phí, đổi
    mốc gia hạn). Trước đây các đường này xoá SẠCH lịch sử kỳ, nên email hết hạn → bị
    gỡ → vài tuần sau mời lại thì "Kỳ thanh toán" quay về đúng 1 dòng, trong khi ví vẫn
    còn hoá đơn của các đợt trước ⇒ lệch sổ (user báo 31/8/2026). Kỳ đã kết thúc là
    tiền ĐÃ THU, không được xoá theo lượt mua mới.

    `boundary` = mốc bắt đầu cửa sổ mới. Kỳ còn hiệu lực tại mốc đó là kỳ của chính
    lượt đang dựng lại (hoặc lượt mời hỏng vừa hoàn phí) → bỏ. Kỳ thiếu `end_at` (dữ
    liệu cũ, không biết phủ tới đâu) cũng bỏ — giữ nguyên hành vi xoá sạch trước đây.

    FLUSH ngay sau khi bỏ: `_append_paid_cycle` chèn liền sau đó, để delete-orphan và
    INSERT cùng một flush thì SQLAlchemy có thể chèn (member_id, cycle_number) TRƯỚC
    khi xoá dòng cũ → vi phạm unique `uq_member_cycle_number`."""
    kept = [
        c
        for c in member.subscription_cycles
        if c.end_at is not None and c.end_at <= boundary
    ]
    if len(kept) == len(member.subscription_cycles):
        return
    member.subscription_cycles = kept
    db.flush()


def current_stint_cycles(
    cycles: list[MemberSubscriptionCycle],
) -> list[MemberSubscriptionCycle]:
    """Các kỳ thuộc ĐỢT THAM GIA HIỆN TẠI = chuỗi kỳ liền mạch cuối cùng.

    Sau khi giữ lịch sử qua các lần mời lại, danh sách kỳ của một member có thể gồm
    nhiều đợt cách nhau bởi khoảng hết hạn. Trạng thái/tiến độ của GHẾ ĐANG DÙNG chỉ
    được tính trên đợt hiện tại — nợ cũ của một đợt đã đóng không được sống lại trên
    ghế mới. Mở đợt mới = kỳ bắt đầu SAU hạn kỳ trước quá 1 phút; kỳ chồng lấn (mốc
    chỉnh tay lùi lại) vẫn thuộc cùng đợt."""
    ordered = sorted(cycles, key=lambda c: c.cycle_number)
    stint_start = 0
    for i in range(1, len(ordered)):
        prev_end, start = ordered[i - 1].end_at, ordered[i].start_at
        if prev_end is None or start is None:
            continue
        if (start - prev_end).total_seconds() > 60:
            stint_start = i
    return ordered[stint_start:]


def void_refunded_invite_periods(
    db: Session,
    *,
    workspace_id: UUID,
    emails: list[str],
    now: datetime,
) -> list[str]:
    """HOÀN PHÍ lời mời ⇒ kỳ đã trả cho lời mời đó KHÔNG còn hiệu lực → clear hạn +
    xoá chu kỳ để `_is_paid_period_active` KHÔNG đọc "hạn ma" (đã hoàn tiền) rồi cho
    mời lại MIỄN PHÍ oan.

    Bug gốc (user 2026-07-16, thuylinhtctbg): lần 1 mời removed→tính phí đặt joined_at
    = lúc mời (invite.py) nên khi lời mời hỏng, `reconcile_failed_invite` KHÔNG xoá được
    phantom (bộ lọc joined_at IS NULL) — member sống sót với `subscription_end_at` còn
    hạn dù phí ĐÃ HOÀN. Lần 2 mời lại → còn-hạn → miễn phí → mất tiền. Bất biến sửa:
    **hoàn phí thì phải void kỳ**. Xem [[invite-timeout-reconciles-like-failed]].

    CHỈ đụng member `pending`/`removed` (chưa thực sự dùng dịch vụ). KHÔNG đụng
    `active`: active = đang trong team, phí gia hạn đi luồng khác (kind != invite_fee)
    nên không bao giờ bị hoàn qua đây. Chỉ void kỳ CÒN HIỆU LỰC (kỳ của chính lời mời
    vừa hoàn); kỳ của các đợt tham gia TRƯỚC đã kết thúc thì giữ — tiền đợt đó không
    được hoàn nên sổ phải còn.

    ⚠️ VOID = "HẾT HẠN NGAY" (`end_at = now`), KHÔNG PHẢI `None` (sửa 12/8/2026):
    theo `EXPIRY_RULES.md` §5, `subscription_end_at IS NULL` nghĩa là **VÔ THỜI HẠN** —
    đúng cái bẫy mà `flag_refunded_invite_debt` đã ghi cho member `active`, nhưng
    member `pending` sống sót (bộ lọc xoá phantom cần `joined_at IS NULL`, mà
    `invite.py` stamp `joined_at` = lúc mời khi mời lại) thì rơi thẳng vào: hoàn phí
    xong hạn thành NULL ⇒ dashboard hiện "Vô hạn", `_enqueue_expired_removals_once`
    KHÔNG BAO GIỜ quét tới ⇒ email dùng miễn phí VĨNH VIỄN mà không có tín hiệu nào.
    Đặt `end_at = now` giữ nguyên mọi tính chất cần thiết (`_is_paid_period_active`
    False ⇒ mời lại vẫn TÍNH PHÍ, không có "hạn ma") nhưng member hiện ĐÚNG là "đã hết
    hạn" và bị quét gỡ như mọi email hết hạn khác — sai thì lộ ra, không im lặng.

    ⚠️ CALLER PHẢI TRUYỀN `emails` = ĐÚNG các email vừa được HOÀN TIỀN
    (`InviteRefund.emails`), KHÔNG phải mọi email trong payload task (ca
    thật 23/8/2026): mời lại email CÒN HẠN là miễn phí ⇒ task đó
    không sinh `invite_fee` ⇒ hoàn 0đ, nhưng void theo payload vẫn cắt kỳ hạn mà MỘT
    TASK KHÁC đã trả tiền → `end_at = now` → job auto-expire gỡ khách khỏi workspace
    trong vòng 1 phút, không đồng nào bù. Bất biến là HAI CHIỀU: hoàn phí ⇒ void kỳ,
    và KHÔNG hoàn phí ⇒ KHÔNG void. Xem `tests/test_reinvite_free_fail_keeps_period.py`.

    Trả list email đã void (để caller log). KHÔNG commit — caller commit."""
    if not emails:
        return []
    lowered = [e.lower() for e in emails]
    members = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(lowered),
                Member.status.in_(("pending", "removed")),
            )
        )
        .scalars()
        .all()
    )
    voided: list[str] = []
    for m in members:
        if m.subscription_end_at is None and not m.subscription_cycles:
            continue  # đã sạch (vô hạn / chưa có kỳ) → bỏ qua
        _drop_open_cycles(db, m, boundary=now)
        # `now`, KHÔNG `None` — xem cảnh báo "VOID = HẾT HẠN NGAY" ở docstring.
        # Member VỐN ĐÃ vô hạn (end_at None) thì giữ nguyên: 'vô hạn' đó do admin cố ý
        # đặt, hoàn 1 phí mời không phải lý do để cắt dịch vụ họ đang được cho.
        if m.subscription_end_at is not None:
            m.subscription_end_at = now
        m.subscription_months = None
        m.subscription_purchased_at = None
        m.payment_status = "unpaid"
        m.paid_at = None
        m.paid_marked_by_id = None
        voided.append(m.email)
    return voided


def net_collected_for_member(db: Session, member: Member) -> int:
    """Tiền THỰC THU của email này = tổng sổ cái ví (âm là trừ, dương là hoàn) đảo dấu.
    `0` ⇒ chưa thu được đồng nào (thu rồi hoàn hết). Ghép theo CẢ email lẫn member_id —
    phí mời neo `ref_id = queue_item_id` (chỉ có email trong meta), phí gia hạn neo
    `ref_id = member_id`. Cùng công thức với endpoint `payments.py` (đọc `payments.md`
    §3 trước khi đổi)."""
    total = db.execute(
        select(func.coalesce(func.sum(WalletTransaction.amount), 0)).where(
            or_(
                func.lower(WalletTransaction.meta["email"].astext)
                == member.email.lower(),
                WalletTransaction.ref_id == str(member.id),
            )
        )
    ).scalar_one()
    return -int(total or 0)


def flag_refunded_invite_debt(
    db: Session,
    *,
    workspace_id: UUID,
    emails: list[str],
    now: datetime,
) -> list[Member]:
    """HOÀN PHÍ nhưng email VẪN Ở TRONG TEAM (`active`) → đánh dấu **CHƯA THANH TOÁN**.

    Vì sao KHÔNG void hạn như `void_refunded_invite_periods`: member `active` là dịch
    vụ ĐANG được giao thật. Void đặt `subscription_end_at = None`, mà theo
    `EXPIRY_RULES.md` §5 nghĩa là **vô thời hạn** — hoá ra tặng luôn dịch vụ vĩnh viễn,
    tệ hơn cả việc mất 1 tháng. Nên: giữ nguyên hạn, chỉ lật nhãn thanh toán về `unpaid`
    để KHOẢN NỢ HIỆN RA (bảng "Email đã add" + khối Dòng tiền ở panel chi tiết).

    Vì sao có hàm này (kiểm chứng 2026-08-04, ca stockbox.m): `void_refunded_invite_
    periods` CHỈ đụng `pending`/`removed`. Nếu đồng bộ kịp lật member sang `active`
    TRƯỚC khi task mời báo FAILED thì hoàn phí xong member vẫn giữ nguyên kỳ 'đã thanh
    toán' + hạn dùng — nhìn màn hình tưởng đã trả tiền, thực tế thu 0 ₫. Thất thoát ẩn.

    CHỈ đánh dấu khi email đó thực sự KHÔNG còn đồng nào thu được
    (`net_collected_for_member <= 0`) — nếu vẫn còn tiền (vd đã gia hạn có thu phí) thì
    khoản 'paid' đó là THẬT, tuyệt đối không được lật thành nợ.

    Trả list member đã đánh dấu (để caller ghi audit). KHÔNG commit — caller commit."""
    if not emails:
        return []
    lowered = [e.lower() for e in emails]
    members = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(lowered),
                Member.status == "active",
            )
        )
        .scalars()
        .all()
    )
    flagged: list[Member] = []
    for m in members:
        looks_paid = m.payment_status == "paid" or any(
            c.payment_status == "paid" for c in m.subscription_cycles
        )
        if not looks_paid:
            continue  # đã hiện "chưa thanh toán" rồi → không cần đụng
        if net_collected_for_member(db, m) > 0:
            continue  # vẫn còn tiền thu được → nhãn 'đã trả' là THẬT
        m.payment_status = "unpaid"
        m.paid_at = None
        m.paid_marked_by_id = None
        for c in m.subscription_cycles:
            if c.payment_status == "paid":
                c.payment_status = "unpaid"
                c.paid_at = None
                c.paid_marked_by_id = None
        flagged.append(m)
    return flagged


def _has_open_remove_task(db: Session, member: Member) -> bool:
    """True nếu member ĐÃ có 1 task GỠ đang mở (PENDING/IN_PROGRESS) — bất kể loại:
    `REMOVE_MEMBER` (payload.member_id, cho member đã tham gia) HOẶC `REVOKE_INVITES`
    (payload.emails chứa email, cho member chờ tham gia). Backend chọn loại theo status
    (xem `remove.py::_build_removal_task`) nên guard phải soi cả hai, nếu không member
    pending sẽ bị enqueue REVOKE trùng mỗi tick cleanup.

    Dùng để enqueue idempotent: cả scheduler nền (main.py) lẫn endpoint
    `cleanup-expired` (remove.py) enqueue theo trạng thái member, NHƯNG member chỉ
    chuyển `removed` khi extension hoàn tất task (completion.py). Trong cửa sổ giữa
    enqueue và completion member vẫn `active`/`pending` + vẫn hết hạn → tick/lần
    gọi kế tiếp sẽ enqueue LẠI cùng member (đẻ task rác + audit log rác). Guard
    này chặn việc đó. Không chống được race 2 luồng enqueue ĐỒNG THỜI (không khoá
    dòng) nhưng đủ cho ca thực tế: 2 tick/2 lần bấm CÁCH NHAU vài giây — xem
    memory `removed-retention-30d` / remove.md."""
    return (
        db.execute(
            select(QueueItem.id)
            .where(
                QueueItem.workspace_id == member.workspace_id,
                QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
                or_(
                    and_(
                        QueueItem.type == "REMOVE_MEMBER",
                        QueueItem.payload["member_id"].astext == str(member.id),
                    ),
                    and_(
                        QueueItem.type == "REVOKE_INVITES",
                        QueueItem.payload.contains({"emails": [member.email.lower()]}),
                    ),
                ),
            )
            .limit(1)
        ).first()
        is not None
    )


def _get_workspace_or_404(db: Session, workspace_id: UUID) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if not ws:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace không tồn tại"
        )
    return ws


def _visibility_filter(stmt: Select, user: User) -> Select:
    """Sub-admin chỉ thấy member họ invite. Super-admin thấy tất cả."""
    if user.is_super_admin:
        return stmt
    return stmt.where(Member.invited_by_user_id == user.id)


def _member_or_404_visible(
    db: Session, workspace_id: UUID, member_id: UUID, user: User
) -> Member:
    stmt = select(Member).where(
        Member.id == member_id, Member.workspace_id == workspace_id
    )
    stmt = _visibility_filter(stmt, user)
    member = db.execute(stmt).scalar_one_or_none()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member không tồn tại hoặc bạn không có quyền truy cập",
        )
    return member


# ═════════════════════════════════════════════════════════════════════════════
# CHẾ ĐỘ `cycle_aligned` — NEO HẠN VÀO MỐC CHU KỲ HOÁ ĐƠN (EXPIRY_RULES §3.6)
# ═════════════════════════════════════════════════════════════════════════════
# Đây là chỗ DUY NHẤT biết cách suy ra mốc chu kỳ và cách đếm ngày tính tiền.
# Router/service tuyệt đối KHÔNG tự trừ hai datetime rồi chia 86400 — sai một chỗ
# là sai tiền hàng loạt mà không có gì báo.

_DAY = timedelta(days=1)
_HALF_DAY = timedelta(hours=12)


def is_cycle_aligned(ws: Workspace) -> bool:
    """Workspace này có neo hạn theo chu kỳ hoá đơn không?

    Mặc định `legacy_30d` là CẦU DAO: mọi thứ chạy như cũ tới khi super-admin gạt
    từng workspace một. Giá trị lạ (dữ liệu hỏng) rơi về nhánh cũ — hướng an toàn.
    """
    return ws.billing_mode == BILLING_MODE_CYCLE_ALIGNED


def _as_utc(at: datetime) -> datetime:
    """Ép về UTC. Naive coi như đã là UTC (DB lưu UTC).

    Mọi phép đo thời gian của chế độ này phải đi qua đây: đọc `.day` của giờ máy là
    lệch 7 tiếng so với ngày UTC, khách được thừa hoặc thiếu mà không ai thấy.
    """
    if at.tzinfo is None:
        return at.replace(tzinfo=timezone.utc)
    return at.astimezone(timezone.utc)


def cycle_settings(db: Session) -> PaymentSettings | None:
    """Hàng cấu hình thanh toán (singleton id=1) — nơi giữ mặc định hệ thống."""
    return db.get(PaymentSettings, 1)


def cycle_params(
    ws: Workspace, settings_row: PaymentSettings | None = None
) -> tuple[int | None, dtime, int]:
    """`(ngày neo, giờ chốt UTC, ngưỡng ép thêm tháng)` có hiệu lực cho workspace.

    Ba tầng: cột riêng của workspace → `payment_settings` → hằng trong `models.py`.
    KHÔNG hard-code con số nào ở chỗ khác (EXPIRY_RULES §3.6.6).

    `cycle_anchor_day` chưa có thì MỒI từ `renewal_date` để workspace vừa gạt sang
    chế độ mới không phải gõ tay. Chỉ là giá trị khởi đầu: mốc tự cuộn theo tháng từ
    con số đó, không đọc lại `renewal_date` ở mỗi lần tính (§3.6.3).
    """
    anchor_day = ws.cycle_anchor_day
    if anchor_day is None and ws.renewal_date is not None:
        anchor_day = _as_utc(ws.renewal_date).day
    cutoff = (
        ws.cycle_cutoff_utc
        or (settings_row.cycle_cutoff_utc if settings_row is not None else None)
        or CYCLE_CUTOFF_UTC_DEFAULT
    )
    force_from = (
        ws.cycle_force_extra_from_day
        or (
            settings_row.cycle_force_extra_from_day
            if settings_row is not None
            else None
        )
        or CYCLE_FORCE_EXTRA_FROM_DAY_DEFAULT
    )
    return anchor_day, cutoff, force_from


def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def _boundary_on(anchor_day: int, cutoff: dtime, year: int, month: int) -> datetime:
    """Mốc chốt của tháng `(year, month)`.

    Ngày neo 29/30/31 rơi vào tháng ngắn thì LÙI về ngày cuối tháng — không thì
    tháng 2 sẽ không có mốc nào và cả chu kỳ biến mất.
    """
    last_day = calendar.monthrange(year, month)[1]
    return datetime(
        year,
        month,
        min(anchor_day, last_day),
        cutoff.hour,
        cutoff.minute,
        cutoff.second,
        tzinfo=timezone.utc,
    )


def _require_anchor_day(ws: Workspace, settings_row: PaymentSettings | None) -> tuple:
    anchor_day, cutoff, force_from = cycle_params(ws, settings_row)
    if anchor_day is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Workspace đang ở chế độ neo theo chu kỳ nhưng chưa biết ngày chốt "
                "chu kỳ. Dán một hoá đơn hoặc đặt 'ngày chốt chu kỳ' cho workspace "
                "trước khi bán."
            ),
        )
    return anchor_day, cutoff, force_from


def workspace_cycle(
    ws: Workspace, at: datetime, *, settings_row: PaymentSettings | None = None
) -> tuple[datetime, datetime]:
    """Chu kỳ hoá đơn CHỨA `at`, trả `(mốc mở, mốc chốt)` — nửa mở `[start, end)`.

    Mốc TỰ CUỘN theo tháng dương lịch từ `cycle_anchor_day`, KHÔNG chờ ai dán hoá
    đơn: `renewal_date` chỉ đổi khi super-admin dán tay, để chu kỳ phụ thuộc thao
    tác đó thì một kỳ quên dán là cả kỳ bán sai giá mà không có gì báo (§3.6.3).
    """
    anchor_day, cutoff, _ = _require_anchor_day(ws, settings_row)
    at = _as_utc(at)
    here = _boundary_on(anchor_day, cutoff, at.year, at.month)
    if at < here:
        y, m = _shift_month(at.year, at.month, -1)
        return _boundary_on(anchor_day, cutoff, y, m), here
    y, m = _shift_month(at.year, at.month, 1)
    return here, _boundary_on(anchor_day, cutoff, y, m)


def next_boundary(
    ws: Workspace, boundary: datetime, *, settings_row: PaymentSettings | None = None
) -> datetime:
    """Mốc chốt kế tiếp sau `boundary` — đúng MỘT tháng dương lịch, không phải 30 ngày."""
    anchor_day, cutoff, _ = _require_anchor_day(ws, settings_row)
    y, m = _shift_month(boundary.year, boundary.month, 1)
    return _boundary_on(anchor_day, cutoff, y, m)


def half_days_between(start: datetime, end: datetime) -> int:
    """Số NỬA NGÀY tính tiền giữa hai mốc (EXPIRY_RULES §3.6.4).

        dư = 0       → không cộng thừa
        dư ≤ 12 giờ  → nửa ngày
        dư > 12 giờ  → trọn ngày

    Ví dụ chốt với user: mua ngày 20 lúc 23:00, mốc chốt ngày 30 lúc 10:00 ⇒ span
    9 ngày 11 tiếng ⇒ dư 11 tiếng ≤ 12 ⇒ **9,5 ngày** = 19 nửa ngày. Cùng ngày đó
    mà mua lúc 10:00 thì tròn 10 ngày = 20 nửa ngày.

    Trả về đơn vị nửa-ngày (số nguyên) chứ KHÔNG trả float: tiền không được dính
    số thực, và không có phần lẻ nào nhỏ hơn nửa ngày.
    """
    span = _as_utc(end) - _as_utc(start)
    if span <= timedelta(0):
        return 0
    whole_days = span // _DAY
    remainder = span - whole_days * _DAY
    if remainder == timedelta(0):
        extra = 0
    elif remainder <= _HALF_DAY:
        extra = 1
    else:
        extra = 2
    return int(whole_days) * 2 + extra


@dataclass(frozen=True)
class CycleQuote:
    """Kết quả áp luật §3.6.2 cho MỘT lượt bán (mời mới hoặc gia hạn).

    Mọi nơi cần "bán tới bao giờ, thu bao nhiêu" phải đi qua `quote_cycle` và đọc
    dataclass này — không nơi nào được tự suy lại, kẻo hạn và tiền lệch nhau.
    """

    join_at: datetime  # ĐIỂM NỐI = max(hạn hiện tại, now)
    cycle_start: datetime
    cycle_end: datetime
    cycle_days: int  # độ dài LỊCH của chu kỳ chứa điểm nối (28–31)
    day_of_cycle: int  # điểm nối là ngày thứ mấy của chu kỳ (1-based)
    prorated_half_days: int  # phần lẻ, đơn vị NỬA NGÀY
    whole_months: int  # số chu kỳ TRỌN phải trả (gồm cả tháng bị ép)
    forced_extra_month: bool  # có bị ngưỡng ép cộng thêm 1 tháng không
    end_at: datetime  # HẠN DÙNG — luôn rơi đúng một mốc chốt


def quote_cycle(
    ws: Workspace,
    now: datetime,
    *,
    current_end: datetime | None = None,
    extra_months: int = 0,
    settings_row: PaymentSettings | None = None,
) -> CycleQuote:
    """Áp luật §3.6.2 — dùng CHUNG cho mời mới, gia hạn, và khách cũ chuyển sang.

    `current_end` = hạn hiện tại của member (None nếu chưa có). ĐIỂM NỐI =
    `max(current_end, now)`: khách gia hạn SỚM mà đếm từ lúc bấm nút là thu trùng
    phần họ đã trả, còn khách gia hạn MUỘN mà đếm từ hạn cũ là tính lùi về quá khứ.

    KHÔNG có nhánh riêng cho từng nhóm khách — thêm nhánh là phá mất tính chất
    "không ai thiệt ở bất kỳ ca nào" vốn là điều kiện để giữ một luật duy nhất.
    """
    now = _as_utc(now)
    join_at = now
    if current_end is not None:
        current_end = _as_utc(current_end)
        if current_end > now:
            join_at = current_end

    _, _, force_from = _require_anchor_day(ws, settings_row)
    start, end = workspace_cycle(ws, join_at, settings_row=settings_row)
    cycle_days = int((end - start) // _DAY)
    day_of_cycle = int((join_at - start) // _DAY) + 1

    prorated = half_days_between(join_at, end)
    base_months = 0
    # Điểm nối trùng đúng mốc mở (khách đã hội tụ, gia hạn đúng kỳ) ⇒ phần "lẻ" phủ
    # trọn một chu kỳ. Cùng số tiền, nhưng gọi thẳng là MỘT THÁNG thì hoá đơn và
    # giao diện đọc ra "1 tháng" thay vì "62 nửa ngày".
    if prorated == cycle_days * 2:
        prorated = 0
        base_months = 1

    forced = day_of_cycle >= force_from
    end_at = end
    for _ in range(int(forced) + max(0, extra_months)):
        end_at = next_boundary(ws, end_at, settings_row=settings_row)

    return CycleQuote(
        join_at=join_at,
        cycle_start=start,
        cycle_end=end,
        cycle_days=cycle_days,
        day_of_cycle=day_of_cycle,
        prorated_half_days=prorated,
        whole_months=base_months + int(forced) + max(0, extra_months),
        forced_extra_month=forced,
        end_at=end_at,
    )


def settle_invite_credit(member: Member) -> None:
    """Email đã vào nhóm thật ⇒ khoản đang giữ coi như đã đổi lấy dịch vụ, thôi treo.

    Không đụng ví và không sinh giao dịch nào: tiền vốn đã trừ từ lượt mời hỏng, đây
    chỉ là thôi đánh dấu "đã thu mà chưa giao" (xem `Member.invite_credit_vnd`).

    Sống ở đây chứ không ở `queue/completion.py` vì có BỐN đường đưa member lên
    `active` — ba đường trong completion (verify, đồng bộ lẻ, đồng bộ mẻ) và một
    đường trong `reconcile.bulk_upsert_members`. Sót một đường là khoản treo không
    bao giờ tắt, và con số đối soát phình mãi.
    """
    if member.invite_credit_vnd:
        member.invite_credit_vnd = None
        member.invite_credit_at = None


def snap_to_boundary(
    ws: Workspace,
    at: datetime,
    extra_months: int = 0,
    *,
    settings_row: PaymentSettings | None = None,
) -> datetime:
    """Mốc chốt kết thúc chu kỳ CHỨA `at`, cộng thêm `extra_months` mốc nữa.

    Khác `boundary_for` ở đúng một điểm, và điểm đó quan trọng: hàm này **KHÔNG áp
    ngưỡng `cycle_force_extra_from_day`**.

    Ngưỡng ép thêm tháng sinh ra cho việc BÁN — đừng bán kỳ quá ngắn. Nhưng khi
    SỬA một bản ghi đã có (vd super-admin sửa "Ngày gia hạn"), ép thêm một tháng là
    tự tay tặng khách 30 ngày mà không ai bấm mua. Sửa dữ liệu thì chỉ nắn cho hạn
    rơi đúng mốc, không được đổi số lượng đã bán.
    """
    _, boundary = workspace_cycle(ws, at, settings_row=settings_row)
    for _ in range(max(0, extra_months)):
        boundary = next_boundary(ws, boundary, settings_row=settings_row)
    return boundary


def sold_window(
    ws: Workspace,
    *,
    join_at: datetime,
    end_at: datetime,
    settings_row: PaymentSettings | None = None,
) -> tuple[int, int, int]:
    """Suy NGƯỢC cửa sổ đã bán ra `(nửa ngày lẻ, số ngày chu kỳ, số chu kỳ trọn)`.

    Dùng khi member ĐÃ được tạo và ta cần tính tiền của đúng quãng vừa bán: đọc lại
    từ hai mốc đã lưu (`subscription_purchased_at` = điểm nối, `subscription_end_at`)
    thay vì mang theo `CycleQuote` qua nhiều tầng hàm.

    VÌ SAO SUY NGƯỢC THAY VÌ TRUYỀN QUOTE: hạn và tiền phải ra từ CÙNG một cửa sổ.
    Truyền quote qua ba tầng gọi thì chỉ cần một nhánh quên truyền là tiền tính theo
    một cửa sổ, hạn ghi theo cửa sổ khác — lệch mà không ai thấy. Suy từ mốc đã lưu
    thì hai thứ đó khớp nhau theo định nghĩa.

    Kết quả trùng khít `quote_cycle` của chính lượt bán đó (có test khoá).
    """
    start, cycle_end = workspace_cycle(ws, join_at, settings_row=settings_row)
    cycle_days = int((cycle_end - start) // _DAY)
    prorated = half_days_between(join_at, cycle_end)
    months = 0
    # Phần lẻ phủ trọn một chu kỳ ⇒ gọi thẳng là MỘT THÁNG (khớp `quote_cycle`).
    if cycle_days > 0 and prorated == cycle_days * 2:
        prorated, months = 0, 1
    boundary = cycle_end
    end_at = _as_utc(end_at)
    while boundary < end_at:
        boundary = next_boundary(ws, boundary, settings_row=settings_row)
        months += 1
    return prorated, cycle_days, months


def boundary_for(
    ws: Workspace,
    now: datetime,
    extra_months: int = 0,
    *,
    current_end: datetime | None = None,
    settings_row: PaymentSettings | None = None,
) -> datetime:
    """HẠN DÙNG theo §3.6.2 — vỏ mỏng của `quote_cycle` cho nơi chỉ cần cái hạn."""
    return quote_cycle(
        ws,
        now,
        current_end=current_end,
        extra_months=extra_months,
        settings_row=settings_row,
    ).end_at
