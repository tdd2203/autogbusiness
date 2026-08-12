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
"""

from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    Member,
    MemberSubscriptionCycle,
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


def _is_paid_period_active(member: Member, now: datetime) -> bool:
    """CÒN HẠN: member có mốc hết hạn CỤ THỂ còn ở tương lai (`subscription_end_at`
    không None và > now). Ân hạn = 0 (mirror rule cleanup-expired/scheduler).

    Dùng để quyết định MỜI LẠI MIỄN PHÍ: email còn hạn bị xoá → mời lại KHÔNG tính
    phí và GIỮ NGUYÊN cửa sổ hạn + chu kỳ đã thanh toán (đã trả tiền cho kỳ này rồi,
    xoá không hoàn tiền → mời lại chỉ là tiếp tục kỳ cũ, không phải chu kỳ mới).

    VÔ THỜI HẠN (`subscription_end_at` None) KHÔNG tính là "còn hạn" — 'vô hạn' là
    khái niệm khác 'còn hạn', giữ hành vi mời-lại cũ (reset cửa sổ + tính phí 1 kỳ)."""
    return member.subscription_end_at is not None and member.subscription_end_at > now


def find_movable_paid_members(
    db: Session,
    *,
    emails: list[str],
    exclude_workspace_id: UUID,
    owner_id: UUID,
    now: datetime,
) -> dict[str, "Member"]:
    """Tìm member CÓ THỂ CHUYỂN WORKSPACE miễn phí: cùng email, CÙNG CHỦ SỞ HỮU
    (`invited_by_user_id == owner_id`), đã `removed` khỏi workspace KHÁC, và CÒN HẠN
    (`subscription_end_at` > now).

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
    chọn kỳ hạn XA NHẤT (`order_by end desc`). Trả {email_lowercase: member}."""
    if not emails:
        return {}
    rows = (
        db.execute(
            select(Member)
            .where(
                Member.email.in_([e.lower() for e in emails]),
                Member.invited_by_user_id == owner_id,
                Member.workspace_id != exclude_workspace_id,
                Member.status == "removed",
                Member.subscription_end_at.isnot(None),
                Member.subscription_end_at > now,
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
) -> None:
    """Nối MỘT chu kỳ ĐÃ THANH TOÁN phủ [start_at → end_at].

    Mô hình chu kỳ (chốt user 2026-07-13): **1 LẦN MUA = 1 chu kỳ** — mua gộp N tháng
    thì gộp cả N vào 1 kỳ (`months=N`), KHÔNG tách thành N kỳ 1-tháng. Phí (ví/QR) luôn
    thu TRƯỚC nên kỳ sinh ra là 'paid' NGAY (không còn 'chưa thanh toán'/duyệt thủ công).
    `months` = số tháng lần mua (biết trước) hoặc suy từ cửa sổ. `cycle_number` nối tiếp
    max hiện có. No-op nếu khoảng rỗng. Xem [[subscription-cycle-model]]."""
    if start_at is None or end_at is None or end_at <= start_at:
        return
    next_number = (
        max((c.cycle_number for c in member.subscription_cycles), default=0) + 1
    )
    member.subscription_cycles.append(
        MemberSubscriptionCycle(
            cycle_number=next_number,
            months=months if months is not None else _months_between(start_at, end_at),
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
    member: Member, *, now: datetime, actor_id: UUID | None
) -> None:
    """Member CÓ hạn nhưng CHƯA có chu kỳ nào (mời trước khi có bảng cycles / vô thời
    hạn cũ) → vật chất hoá 1 chu kỳ ĐÃ THANH TOÁN phủ [ngày tham gia → hạn] (months suy
    từ cửa sổ). Gọi TRƯỚC khi nối kỳ mới để lịch sử liền mạch. No-op nếu đã có chu kỳ."""
    if member.subscription_cycles or member.subscription_end_at is None:
        return
    _append_paid_cycle(
        member,
        start_at=_first_cycle_anchor(member, now),
        end_at=member.subscription_end_at,
        months=None,  # suy từ cửa sổ (không biết ranh giới từng lần mua cũ)
        actor_id=actor_id,
        now=now,
    )


def _trim_cycles_to_end(member: Member, end_at: datetime | None) -> None:
    """Đổi hạn RÚT NGẮN / VÔ THỜI HẠN: bỏ các chu kỳ vượt hạn mới.

    - end_at None (vô thời hạn) → xoá HẾT chu kỳ (vô hạn không có kỳ tính tiền).
    - Ngược lại: bỏ kỳ bắt đầu từ hạn mới trở đi (start_at ≥ end_at); kỳ còn lại mà
      kết thúc sau hạn mới → cắt end_at về đúng hạn mới. (delete-orphan tự xoá row.)"""
    if end_at is None:
        member.subscription_cycles = []
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
    (`subscription_purchased_at`), nên bỏ hết kỳ cũ rồi dựng lại (months suy từ cửa
    sổ). Vô thời hạn (hạn None) → không còn kỳ."""
    _reset_cycles(db, member)
    anchor = _clamp_future(
        member.subscription_purchased_at or member.joined_at, now
    )
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

    Dựng LẠI 1 chu kỳ 'paid' phủ [ngày gia hạn → hạn] rồi đồng bộ trạng thái member.
    Bỏ hết chu kỳ cũ vì mời/mời-lại = một chu kỳ tham gia MỚI (removed→mời lại reset cả
    cửa sổ; pending mời lại cũng đặt lại hạn). Vô thời hạn (hạn None) → không có chu kỳ
    nhưng member vẫn 'paid'. Xem [[subscription-cycle-model]]."""
    _reset_cycles(db, member)
    _append_paid_cycle(
        member,
        start_at=_clamp_future(member.subscription_purchased_at, now),
        end_at=member.subscription_end_at,
        months=months,
        actor_id=actor_id,
        now=now,
    )
    _mark_member_paid(member, now=now, actor_id=actor_id)


def _reset_cycles(db: Session, member: Member) -> None:
    """Xoá HẾT chu kỳ hiện có rồi FLUSH ngay. Bắt buộc flush trước khi nối lại kỳ số 1
    (dựng lại từ đầu): nếu để delete-orphan cũ và INSERT kỳ mới cùng một flush,
    SQLAlchemy có thể chèn (member_id, cycle_number=1) TRƯỚC khi xoá dòng cũ → vi phạm
    unique `uq_member_cycle_number`. No-op nếu member chưa có kỳ nào."""
    if member.subscription_cycles:
        member.subscription_cycles = []
        db.flush()


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
    nên không bao giờ bị hoàn qua đây. Member mời-mới/mời-lại-tính-phí có ĐÚNG 1 chu
    kỳ = lời mời này (`_apply_invite_paid_cycle` reset về 1) nên xoá sạch an toàn.

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
        _reset_cycles(db, m)
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
