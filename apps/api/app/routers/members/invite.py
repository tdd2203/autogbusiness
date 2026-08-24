"""Chức năng: INVITE MEMBER (mời thành viên — đơn & hàng loạt).

⚠️ ĐỌC `invite.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Tính hạn (anchor/end) tuân theo `EXPIRY_RULES.md` — KHÔNG tự chế công thức.

Endpoints:
  - POST /invite                    → invite_member          (1 email)
  - POST /bulk-invite               → bulk_invite_members    (nhiều email, 1 task)
  - POST /{member_id}/re-invite     → reinvite_member        (mời lại 1 email)
  - POST /re-invite-batch           → reinvite_members_batch (mời lại nhiều email,
    chỉ email CÒN HẠN — miễn phí; hết hạn bị bỏ qua, không bật QR giữa chừng)

Seat guard `_assert_seat_available` sống ở đây (chỉ luồng invite cần chặn seat).

Thanh toán (feature 003, user 2026-07-13 — "ví trước, QR sau"):
  - Phí mời 2 tầng = COALESCE(member.fee_vnd, user.invite_fee_vnd, global default).
  - Ví ĐỦ → trừ ví + tạo member/queue ngay.
  - Ví THIẾU → tạo hoá đơn QR (mã ORDER) + HTTP 402 PAYMENT_QR_REQUIRED, KHÔNG tạo
    member/queue; webhook nhận đủ tiền mới thực thi (perform_invite_core dùng chung).
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    get_session,
    require_permission,
    user_can_access_workspace,
)
from app.models import Invite, Member, QueueItem, User, Workspace
from app.permissions import Permission
from app.routers.wallet._shared import get_payment_settings
from app.services import payment_flow, wallet_service
from app.sse import publish_task_event
from app.schemas import (
    MemberBulkInviteIn,
    MemberInviteIn,
    MemberOut,
    MemberReinviteBatchIn,
)

from ._shared import (
    router,
    _apply_invite_paid_cycle,
    _end_from_purchase,
    _get_workspace_or_404,
    _is_paid_period_active,
    _member_or_404_visible,
    find_movable_paid_members,
)


# Cho phép invite vượt seat_total tối đa +50% (overcommit). Vượt ngưỡng này thì
# chặn và yêu cầu admin mở thêm seat. Đổi hệ số ở đây nếu muốn nới/siết.
SEAT_OVERCOMMIT_RATIO = 1.5


# ── Core dùng chung: tạo member/queue/invite (KHÔNG trừ phí, KHÔNG commit) ─────

def _adopt_member_into_workspace(
    member: Member, *, workspace_id: UUID, role: str, owner_id: UUID, now: datetime
) -> None:
    """CHUYỂN 1 member `removed` còn hạn từ ws khác VÀO `workspace_id` (ca add nhầm
    workspace). Giữ nguyên subscription_* + chu kỳ đã thanh toán (gắn theo member_id,
    tự đi theo khi đổi workspace_id) → KHÔNG reset cửa sổ, KHÔNG tính phí. joined_at =
    now: chu kỳ THAM GIA mới ở ws này (bất biến invite-time = join-date). Caller lo
    flush + xoá record cũ trùng (workspace_id,email) TRƯỚC khi gọi nếu có."""
    member.workspace_id = workspace_id
    member.status = "pending"
    member.chatgpt_role = role
    member.invited_by_user_id = owner_id
    member.joined_at = now
    member.removed_at = None  # gỡ mốc retention 30 ngày
    member.removed_reason = None
    member.last_invited_at = now


def perform_invite_core(
    db: Session,
    user: User,
    workspace: Workspace,
    entries: list[tuple[str, int | None]],
    role: str,
    *,
    single: bool,
    reinvite: bool = False,
) -> tuple[QueueItem | None, list[Member], list[Member], list[Member]]:
    """Tạo QueueItem + Member/Invite cho lệnh mời, VÀ gia hạn email đã ACTIVE.
    KHÔNG trừ phí, KHÔNG commit, KHÔNG publish SSE — caller lo (endpoint hoặc webhook
    replay sau thanh toán QR).

    `entries`: list (email_lowercase, subscription_months). Mỗi entry phân loại:
      • email đang ACTIVE → GIA HẠN (cộng dồn hạn + chu kỳ ĐÃ THANH TOÁN,
        `perform_renew_core`). Active đã trong workspace nên KHÔNG cần task ChatGPT →
        KHÔNG vào queue payload, KHÔNG tạo Invite. Vẫn TÍNH PHÍ (mua thêm N tháng —
        user 2026-07-15: gộp gia hạn chung luồng paste mời). BỎ QUA nếu months None/≤0.
      • còn lại (mới / removed / pending) → MỜI như cũ (queue + Invite).

    CHUYỂN WORKSPACE MIỄN PHÍ (user 2026-07-16, ca "add nhầm workspace"): nếu có member
    `removed` CÒN HẠN cùng chủ sở hữu ở ws KHÁC (`find_movable_paid_members`) → CHUYỂN
    nguyên record đó sang ws này (đổi `workspace_id`, giữ `member.id` → cửa sổ hạn +
    chu kỳ đã thanh toán đi theo), đặt `pending`, KHÔNG tính phí. Hai biến thể:
      • ws này CHƯA có record cho email → dời thẳng.
      • ws này CÓ tombstone `removed` HẾT HẠN → xoá tombstone rồi dời (HỢP NHẤT về gói
        còn hạn; nếu không, nhánh existing-hết-hạn sẽ tính phí oan).
    Đã trả tiền cho email này rồi, add nhầm chỗ không phải lý do bắt trả lại. Xem
    [[cross-workspace-move-keeps-paid]].

    `single=True` (đúng 1 entry MỜI) → payload {"email": ...} + MEMBER_INVITE_QUEUED
    (khớp luồng /invite cũ); ngược lại {"emails": [...]} + MEMBER_BULK_INVITE_QUEUED.
    Nếu KHÔNG còn entry mời nào (toàn gia hạn) → queue_item = None (không task).

    `reinvite=True` (action "Mời lại" cho lời mời lỗi): (1) đặt `payload["reinvite"]`
    để extension chạy tiền tố tìm-thu-hồi trước khi mời; (2) MỞ RỘNG quy tắc miễn phí
    "còn hạn" sang cả member `pending` (không chỉ `removed`) — mời lại email CÒN HẠN
    không tính phí, giữ nguyên cửa sổ. Email HẾT HẠN vẫn tính phí + chu kỳ mới như
    mời thường. Xem [[reinvite-action-failed-invite]] / [[reinvite-still-valid-is-free]].

    Trả (queue_item | None, all_members, chargeable, renew_members):
      • all_members   = mọi member đụng tới (gia hạn TRƯỚC, rồi tới mời — theo bó).
      • chargeable    = member tạo lời mời MỚI (phí mời, ref=queue_item).
      • renew_members = member đang active được gia hạn (phí gia hạn, ref=member).
    """
    # Lazy import tránh phụ thuộc thứ tự nạp module trong package.
    from .renew import perform_renew_core

    workspace_id = workspace.id
    now = datetime.now(timezone.utc)
    emails_lower = [e for e, _ in entries]
    existing_map = {
        m.email: m
        for m in db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(emails_lower),
            )
        ).scalars().all()
    }

    # Phân loại: gia hạn (active) vs mời (còn lại). Giữ thứ tự entry cho phần mời.
    invite_entries: list[tuple[str, int | None]] = []
    renew_targets: list[tuple[Member, int]] = []
    for email, months in entries:
        m = existing_map.get(email)
        if m is not None and m.status == "active":
            if months is not None and months > 0:
                renew_targets.append((m, months))
            # months None/≤0 → không gia hạn, cũng không mời (active đã trong ws).
        else:
            invite_entries.append((email, months))

    all_members: list[Member] = []
    chargeable: list[Member] = []
    renew_members: list[Member] = []

    # ── GIA HẠN email đang active (cộng dồn hạn + chu kỳ trả tiền + audit RENEWED) ──
    for m, months in renew_targets:
        perform_renew_core(db, user, m, months)
        all_members.append(m)
        renew_members.append(m)

    # ── MỜI (queue + Invite records) — bỏ qua hẳn nếu toàn gia hạn ────────────────
    queue_item: QueueItem | None = None
    if invite_entries:
        invite_emails = [e for e, _ in invite_entries]
        # Ứng viên CHUYỂN WORKSPACE miễn phí = record `removed` còn hạn cùng chủ ở ws
        # KHÁC. Quét MỌI email (kể cả email đã có record HẾT HẠN ở ws này) — ca thật:
        # ws đích có tombstone hết hạn nhưng gói còn hạn nằm ở ws khác → phải hợp nhất
        # về gói còn hạn, không tính phí. Xem docstring.
        movable_map = find_movable_paid_members(
            db,
            emails=invite_emails,
            exclude_workspace_id=workspace_id,
            owner_id=user.id,
            now=now,
        )
        moved_from: dict[str, UUID] = {}
        payload: dict = {"role": role, "verified_domain": workspace.verified_domain}
        # Số suất MỚI mà lệnh mời này thực sự chiếm trên ChatGPT. Extension dùng
        # con số này để biết cần MUA BÙ bao nhiêu suất trước khi mời.
        #
        # KHÁC len(emails): email đang là member `active` đã giữ một suất rồi, đếm
        # cả nó là đi mua thừa (mất tiền thật). Ca "mời lại khi đồng bộ không thấy"
        # đã được `_unblock_active_if_sync_missing` hạ về `pending` TRƯỚC khi tới
        # đây nên vẫn được tính — đúng, vì người đó đã rời ChatGPT và suất đã được
        # trả lại. Còn member active mà đồng bộ VẪN THẤY thì bị chặn 409 từ đầu,
        # không bao giờ chạy tới dòng này.
        payload["new_seat_count"] = _count_new_invite_seats(
            db, workspace_id, invite_emails
        )
        # Số suất dashboard đang biết → extension dùng để BỎ QUA bước mở hộp
        # "Quản lý suất" khi thấy chắc chắn còn thừa chỗ. Xem `_seat_hint`.
        payload["seat_hint"] = _seat_hint(db, workspace, invite_emails)
        if single and len(invite_entries) == 1:
            payload["email"] = invite_emails[0]
        else:
            payload["emails"] = invite_emails
        if reinvite:
            # Cờ để extension chạy tiền tố (tìm tab Người dùng → huỷ nếu còn; thu hồi
            # lời mời cũ ở tab Lời mời) trước khi mời. Task vẫn type INVITE_MEMBER →
            # tái dùng nguyên máy móc verify/phantom-cleanup/hoàn-phí ở completion.py.
            payload["reinvite"] = True

        queue_item = QueueItem(
            type="INVITE_MEMBER",
            status="PENDING",
            workspace_id=workspace_id,
            payload=payload,
            created_by_id=user.id,
        )
        db.add(queue_item)
        db.flush()

        audit_entries: list[dict] = []
        for email, months in invite_entries:
            sub_end = _end_from_purchase(now, months)
            existing = existing_map.get(email)  # active đã lọc ở trên → chỉ removed/pending
            movable = movable_map.get(email)  # gói còn hạn cùng chủ ở ws KHÁC (nếu có)
            if existing:
                if (
                    reinvite or existing.status == "removed"
                ) and _is_paid_period_active(existing, now):
                    # CÒN HẠN → mời lại MIỄN PHÍ (user 2026-07-14): đã trả tiền cho kỳ
                    # này rồi, xoá KHÔNG hoàn tiền → mời lại chỉ TIẾP TỤC kỳ đã trả.
                    # GIỮ NGUYÊN cửa sổ hạn + chu kỳ đã thanh toán → KHÔNG chargeable
                    # và BỎ QUA `months` yêu cầu. Áp cho: (a) mời THƯỜNG email `removed`
                    # còn hạn; (b) action MỜI LẠI (`reinvite`) email `pending` còn hạn.
                    # Với (b) member chưa rời đội → GIỮ joined_at. Xem
                    # [[reinvite-still-valid-is-free]] / invite.md §phí.
                    if existing.status == "removed":
                        existing.joined_at = now  # bất biến invite-time = join-date
                        existing.removed_at = None  # gỡ mốc retention 30 ngày
                        existing.removed_reason = None
                    existing.status = "pending"
                    existing.chatgpt_role = role
                    existing.invited_by_user_id = user.id
                    existing.last_invited_at = now
                    member = existing
                elif existing.status == "removed" and movable is not None:
                    # HỢP NHẤT (add nhầm ws): ws này CÓ tombstone `removed` HẾT HẠN,
                    # nhưng gói CÒN HẠN cùng chủ nằm ở ws KHÁC → xoá tombstone hết hạn
                    # rồi CHUYỂN record còn hạn sang đây (giữ cửa sổ + chu kỳ đã trả).
                    # KHÔNG tính phí. Phải flush sau delete để giải phóng unique
                    # (workspace_id,email) trước khi donor đổi workspace_id vào.
                    moved_from[email] = movable.workspace_id
                    db.delete(existing)
                    db.flush()
                    _adopt_member_into_workspace(
                        movable, workspace_id=workspace_id, role=role,
                        owner_id=user.id, now=now,
                    )
                    member = movable
                else:
                    # HẾT HẠN / VÔ THỜI HẠN (không có gói còn hạn ở nơi khác) hoặc
                    # pending → chu kỳ tham gia MỚI: reset cửa sổ + tính phí. removed →
                    # chu kỳ mới → joined_at = lúc mời lại (bất biến invite-time =
                    # join-date). Member 'pending' chưa tham gia → giữ joined_at để set
                    # đúng lúc tham gia thật.
                    if existing.status == "removed":
                        existing.joined_at = now
                        existing.removed_at = None  # reset mốc retention 30 ngày
                        existing.removed_reason = None
                    existing.status = "pending"
                    existing.chatgpt_role = role
                    existing.invited_by_user_id = user.id
                    existing.subscription_months = months
                    existing.subscription_purchased_at = now
                    existing.subscription_end_at = sub_end
                    existing.last_invited_at = now
                    member = existing
                    chargeable.append(member)
            else:
                if movable is not None:
                    # CHUYỂN WORKSPACE miễn phí (add nhầm ws → add lại đúng chỗ, ws đích
                    # CHƯA có record nào): dời nguyên record `removed` còn hạn từ ws cũ
                    # sang. Giữ subscription_* + chu kỳ đã thanh toán → KHÔNG chargeable,
                    # BỎ QUA `months` yêu cầu.
                    moved_from[email] = movable.workspace_id
                    _adopt_member_into_workspace(
                        movable, workspace_id=workspace_id, role=role,
                        owner_id=user.id, now=now,
                    )
                    member = movable
                else:
                    member = Member(
                        workspace_id=workspace_id,
                        email=email,
                        chatgpt_role=role,
                        status="pending",
                        invited_by_user_id=user.id,
                        subscription_months=months,
                        subscription_purchased_at=now,
                        subscription_end_at=sub_end,
                        last_invited_at=now,
                    )
                    db.add(member)
                    chargeable.append(member)
            db.flush()
            all_members.append(member)
            # Audit phản ánh trạng thái THẬT của member sau xử lý (mời lại còn hạn giữ
            # nguyên cửa sổ cũ, không phải months/sub_end yêu cầu).
            entry = {
                "email": email,
                "subscription_months": member.subscription_months,
                "subscription_end_at": (
                    member.subscription_end_at.isoformat()
                    if member.subscription_end_at
                    else None
                ),
            }
            if email in moved_from:
                # Ghi lại ws nguồn để log giải thích vì sao lời mời này KHÔNG tính phí
                # (chuyển từ ws add nhầm, đã trả tiền, giữ nguyên cửa sổ hạn).
                entry["moved_from_workspace_id"] = str(moved_from[email])
            audit_entries.append(entry)
            db.add(
                Invite(
                    workspace_id=workspace_id,
                    email=email,
                    role=role,
                    status="pending",
                    queue_item_id=queue_item.id,
                    invited_by_user_id=user.id,
                )
            )

        # Phí mời thu TRƯỚC (ví/QR) → mỗi email tạo lời mời mới (chargeable) sinh 1 chu
        # kỳ ĐÃ THANH TOÁN ngay, hiển thị "Đã thanh toán" không cần duyệt tay (nhất quán
        # renew). `subscription_months` của member đã set = số tháng lời mời này ở trên.
        for m in chargeable:
            _apply_invite_paid_cycle(
                db, m, months=m.subscription_months, actor_id=user.id, now=now
            )

        # Audit (commit=False). Nhãn single vs bulk giữ khớp luồng cũ.
        if single and len(invite_entries) == 1:
            m0 = all_members[-1]  # entry mời duy nhất vừa append
            log_event(
                db,
                actor_type="ADMIN",
                actor_id=user.id,
                actor_label=user.email,
                action="MEMBER_INVITE_QUEUED",
                result="PENDING",
                target_type="MEMBER",
                target_id=str(m0.id),
                data={
                    "workspace_id": str(workspace_id),
                    "email": invite_emails[0],
                    "role": role,
                    "queue_item_id": str(queue_item.id),
                    "subscription_months": audit_entries[0]["subscription_months"],
                    "subscription_end_at": audit_entries[0]["subscription_end_at"],
                },
                commit=False,
            )
        else:
            log_event(
                db,
                actor_type="ADMIN",
                actor_id=user.id,
                actor_label=user.email,
                action="MEMBER_BULK_INVITE_QUEUED",
                result="PENDING",
                target_type="QUEUE_ITEM",
                target_id=str(queue_item.id),
                data={
                    "workspace_id": str(workspace_id),
                    "entries": audit_entries,
                    "role": role,
                    "count": len(invite_emails),
                },
                commit=False,
            )
    return queue_item, all_members, chargeable, renew_members


# ── Phí: dự tính (quyết định trừ-ví/QR) + trừ thật (theo member đã tạo) ────────

def _member_fees(user: User, members: list[Member], default_fee: int) -> list[tuple[str, int]]:
    """(email, fee) cho từng member cần tính phí, bỏ phí ≤ 0. Phí 2 tầng × số tháng
    (đơn giá/tháng × subscription_months của member)."""
    out: list[tuple[str, int]] = []
    for m in members:
        fee = payment_flow.effective_fee_for_months(
            m.fee_vnd, user, default_fee, m.subscription_months
        )
        if fee > 0:
            out.append((m.email.lower(), fee))
    return out


def _charge_renewals(
    db: Session, user: User, renew_members: list[Member], default_fee: int
) -> None:
    """Trừ phí GIA HẠN cho email đang active được gia hạn qua luồng mời (mỗi member 1
    giao dịch `renew_fee`). Phí = đơn giá/tháng × số tháng vừa gia hạn
    (`subscription_months` do perform_renew_core set). Bỏ phí ≤ 0."""
    for m in renew_members:
        fee = payment_flow.effective_fee_for_months(
            m.fee_vnd, user, default_fee, m.subscription_months
        )
        if fee > 0:
            wallet_service.charge_renew(db, user, m.id, fee, email=m.email)


def _seat_hint(db: Session, workspace: Workspace, emails: list[str]) -> dict:
    """Số suất dashboard đang biết về workspace, gửi kèm task mời.

    Extension dùng cặp số này để quyết định có được BỎ QUA bước mở hộp "Quản lý
    suất" hay không (user 2026-08-24: mở hộp đó liên tục vừa chậm vừa hay hỏng —
    hộp không mở sau 15s, hoặc bộ đếm lệch dòng tỉ lệ → chết cả task mời).

    - `total` = `seat_total` scrape từ trang thanh toán (SYNC_BILLING). Có thể CŨ.
    - `occupied` = member CHƯA bị gỡ = active + pending.

    Cộng pending vào `occupied` là ĐẾM THỪA CÓ CHỦ Ý, KHÔNG phải vì lời mời đang
    chờ giữ suất trên ChatGPT — đo trên production 24/8/2026 thì ngược lại:
    GPT1 có 148 active + 1 chờ, ChatGPT báo đúng `148/151 đã gán`; CHATGPT PRO
    thì `60/60 đã gán`, hết sạch suất trống, mà vẫn treo 1 lời mời chờ — lời mời
    chờ mà giữ suất thì ca đó không tồn tại được. Tức "đã gán" = đúng số active.

    Vẫn cộng, vì lời mời chờ BIẾN THÀNH suất thật ngay khi người ta bấm nhận, có
    thể xảy ra đúng giữa lúc extension đọc số và lúc bấm mời. Đếm thừa thì cùng
    lắm extension mở hộp đếm tận nơi (chậm); đếm thiếu là mời mù vào chỗ không
    có, kích hoạt hộp "Mua suất người dùng và gửi lời mời" — mua bằng tiền thật,
    số tiền do ChatGPT tự quyết. Đừng "sửa" chỗ này thành chỉ đếm active.

    - `pending` = RIÊNG số lời mời đang chờ, KHÔNG kể email của chính lệnh mời
      này. Đường ĐẾM TẬN NƠI cần nó: hộp "Quản lý suất" chỉ nói "đã gán" (= người
      đã tham gia), nên `còn trống = tổng − đã gán` đang bỏ quên nợ suất của lời
      mời treo. Ca thật CHATGPT PRO 24/8/2026: "60/60 đã gán" + 1 lời mời treo,
      mời thêm 1 email thì phải mua 2 suất chứ không phải 1 (user chốt).
      LOẠI email của lệnh này ra vì chúng đã được đếm một lần trong
      `new_seat_count` — để nguyên là đếm hai lần ⇒ mua thừa bằng tiền thật, đúng
      ca admin bấm "Mời lại" cho email đang chờ.

    Cả ba đều là gợi ý, không phải chân lý: extension chỉ bỏ qua hộp khi khoảng
    thừa tính từ đây còn dư so với số suất cần, còn lại vẫn mở hộp đọc tận nơi.
    """
    occupied = int(
        db.execute(
            select(func.count())
            .select_from(Member)
            .where(Member.workspace_id == workspace.id, Member.status != "removed")
        ).scalar_one()
    )
    lowered = [e.strip().lower() for e in emails if e]
    pending_stmt = (
        select(func.count())
        .select_from(Member)
        .where(Member.workspace_id == workspace.id, Member.status == "pending")
    )
    if lowered:
        pending_stmt = pending_stmt.where(Member.email.notin_(lowered))
    pending = int(db.execute(pending_stmt).scalar_one())
    return {
        "total": workspace.seat_total,
        "occupied": occupied,
        "pending": pending,
    }


def _count_new_invite_seats(
    db: Session, workspace_id: UUID, emails: list[str]
) -> int:
    """Số email SẼ chiếm seat MỚI = email chưa phải member `active`. Email đang active
    (gia hạn) đã chiếm seat rồi → không cộng thêm vào seat guard."""
    if not emails:
        return 0
    active = set(
        db.execute(
            select(Member.email).where(
                Member.workspace_id == workspace_id,
                Member.email.in_(emails),
                Member.status == "active",
            )
        ).scalars().all()
    )
    return sum(1 for e in emails if e not in active)


def plan_invite_fees(
    db: Session,
    workspace_id: UUID,
    entries: list[tuple[str, int | None]],
    user: User,
    default_fee: int,
    *,
    reinvite: bool = False,
) -> list[tuple[str, int]]:
    """Dự tính (email, fee) SẼ bị trừ nếu mời — mirror quy tắc phí của
    perform_invite_core: email MỚI/hết-hạn = phí mời; email đang ACTIVE = phí GIA HẠN
    (mua thêm N tháng, months>0); email còn-hạn = miễn phí. Tổng phí gộp cả mời lẫn
    gia hạn → quyết định trừ-ví-hay-tạo-QR; trừ THẬT dùng members trả về từ core.

    `reinvite=True` mirror perform_invite_core: email CÒN HẠN (kể cả `pending`) miễn
    phí. Nếu không mirror, mời-lại còn-hạn sẽ bị đòi QR/402 oan dù thực tế không trừ."""
    now = datetime.now(timezone.utc)
    emails = [e for e, _ in entries]
    existing = {
        m.email: m
        for m in db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id, Member.email.in_(emails)
            )
        ).scalars().all()
    }
    # Ứng viên CHUYỂN WORKSPACE miễn phí (mirror perform_invite_core) — quét MỌI email
    # (kể cả email đã có tombstone HẾT HẠN ở ws này, gói còn hạn ở ws khác). Không
    # mirror → mời chuyển-ws / hợp-nhất còn hạn bị đòi QR/402 oan.
    movable_map = find_movable_paid_members(
        db,
        emails=[e for e, _ in entries],
        exclude_workspace_id=workspace_id,
        owner_id=user.id,
        now=now,
    )
    out: list[tuple[str, int]] = []
    for email, months in entries:
        m = existing.get(email)
        if m is not None and m.status == "active":
            # ACTIVE → GIA HẠN (mua thêm N tháng): tính phí = đơn giá/tháng × số tháng
            # (mirror perform_invite_core → perform_renew_core). BỎ QUA nếu months
            # None/≤0 (không gia hạn). Xem [[subscription-cycle-model]].
            if months is not None and months > 0:
                fee = payment_flow.effective_fee_for_months(
                    m.fee_vnd, user, default_fee, months
                )
                if fee > 0:
                    out.append((email, fee))
            continue
        if (
            m is not None
            and (reinvite or m.status == "removed")
            and _is_paid_period_active(m, now)
        ):
            # còn hạn → mời lại miễn phí (mirror perform_invite_core). Mời thường chỉ
            # áp cho removed; action Mời lại (reinvite) áp cho cả pending còn hạn.
            continue
        if email in movable_map and (m is None or m.status == "removed"):
            # CHUYỂN/HỢP NHẤT WORKSPACE miễn phí (add nhầm ws → add lại): gói removed
            # còn hạn cùng chủ ở ws khác sẽ được dời sang (nếu ws này có tombstone
            # removed hết hạn thì xoá + hợp nhất), giữ cửa sổ hạn → KHÔNG tính phí.
            # `m.status == "removed"` khớp core: pending local KHÔNG hợp nhất.
            continue
        member_fee = m.fee_vnd if m is not None else None
        # Phí = đơn giá/tháng × số tháng của lời mời này (mirror _member_fees).
        fee = payment_flow.effective_fee_for_months(
            member_fee, user, default_fee, months
        )
        if fee > 0:
            out.append((email, fee))
    return out


def _create_invite_order_and_raise(
    db: Session,
    user: User,
    workspace: Workspace,
    entries: list[tuple[str, int | None]],
    role: str,
    amount: int,
    settings_row,
    *,
    reinvite: bool = False,
) -> None:
    """Ví thiếu → tạo hoá đơn QR mời + HTTP 402. KHÔNG tạo member/queue (chờ trả tiền).

    Chưa cấu hình ngân hàng nhận → không dựng được QR → fallback 402 báo nạp thêm.
    `reinvite` được lưu vào order payload để webhook replay giữ đúng hành vi mời-lại.
    """
    if not payment_flow.bank_configured(settings_row):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "INSUFFICIENT_BALANCE",
                "message": "Số dư Ví không đủ và chưa cấu hình thanh toán QR. Vui lòng nạp thêm.",
                "required": amount,
            },
        )
    order_payload: dict = {
        "role": role,
        "entries": [{"email": e, "subscription_months": m} for e, m in entries],
    }
    if reinvite:
        order_payload["reinvite"] = True
    order = payment_flow.create_order(
        db,
        user,
        kind="invite",
        amount=amount,
        payload=order_payload,
        workspace_id=workspace.id,
    )
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="PAYMENT_ORDER_CREATED",
        result="PENDING",
        target_type="PAYMENT_ORDER",
        target_id=str(order.id),
        data={
            "kind": "invite",
            "amount_vnd": amount,
            "workspace_id": str(workspace.id),
            "count": len(entries),
            "ref_code": order.ref_code,
        },
        commit=False,
    )
    db.commit()
    payment_flow.raise_payment_required(settings_row, order)


def _assert_email_ownership(db: Session, emails: list[str], user: User) -> None:
    """CƠ CHẾ CHỦ SỞ HỮU (toàn hệ thống, chốt user 2026-07-13; NỚI 2026-07-20).

    Email đã được mời qua dashboard (có `Member` với `invited_by_user_id`) THUỘC VỀ
    tài khoản đã mời — tài khoản KHÁC (kể cả super-admin) không mời được email đó nữa.
    Chủ sở hữu cũ vẫn mời lại được (owner_id == user.id → bỏ qua).

    **Chỉ khoá khi email CÒN HẠN** (chốt user 2026-07-20): quyền sở hữu chỉ tồn tại
    khi gói còn hiệu lực — `subscription_end_at` ở tương lai (còn hạn) HOẶC NULL (vô
    hạn). Khi đã HẾT HẠN (`subscription_end_at <= now`, thường kèm bị gỡ khỏi
    workspace) email thành "email cũ vô chủ" → ai cũng mời lại được. Đây là mặt nới
    của [[invite-owner-lock]] (khách ngừng trả tiền cho chủ cũ → email được giải
    phóng cho người khác).

    Phạm vi GLOBAL (không lọc theo workspace_id). Lời mời FAILED tự xoá Member
    (phantom cleanup ở completion.py). Chỉ xét member có `invited_by_user_id` NOT
    NULL: member scrape thuần từ ChatGPT (không rõ ai mời) KHÔNG thiết lập sở hữu."""
    if not emails:
        return
    now = datetime.now(timezone.utc)
    conflict = db.execute(
        select(Member.email, Member.invited_by_user_id)
        .where(
            Member.email.in_(emails),
            Member.invited_by_user_id.isnot(None),
            Member.invited_by_user_id != user.id,
            # Chỉ email CÒN HẠN (end tương lai) hoặc VÔ HẠN (end NULL) mới còn chủ.
            # Hết hạn (end <= now) → vô chủ, không khoá nữa.
            or_(
                Member.subscription_end_at.is_(None),
                Member.subscription_end_at > now,
            ),
        )
        .limit(1)
    ).first()
    if conflict is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Email {conflict.email} thuộc chủ sở hữu khác — "
                f"bạn không thể mời email này."
            ),
        )


def _assert_single_workspace(
    db: Session, emails: list[str], workspace_id: UUID
) -> None:
    """1 email chỉ được là thành viên ở DUY NHẤT 1 workspace tại một thời điểm
    (chốt user 2026-07-20). Chặn mời email đang `active`/`pending` ở workspace KHÁC —
    muốn chuyển sang workspace mới thì phải GỠ khỏi workspace cũ trước.

    Không xét member `removed` (đã rời workspace cũ → được add sang ws mới; luồng
    chuyển/hợp nhất giữ hạn ở perform_invite_core vẫn chạy, xem
    [[cross-workspace-move-keeps-paid]]). Áp cho MỌI tài khoản (kể cả super-admin),
    độc lập cơ chế chủ sở hữu."""
    if not emails:
        return
    conflict = db.execute(
        select(Member.email, Workspace.name)
        .join(Workspace, Workspace.id == Member.workspace_id)
        .where(
            Member.email.in_(emails),
            Member.workspace_id != workspace_id,
            Member.status.in_(["active", "pending"]),
        )
        .limit(1)
    ).first()
    if conflict is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Email {conflict.email} đang ở không gian khác "
                f"({conflict.name}) — 1 email chỉ được ở 1 không gian. Gỡ khỏi "
                f"không gian cũ trước khi mời vào không gian mới."
            ),
        )


def _assert_invite_workspace_access(
    db: Session, user: User, workspace_id: UUID, emails: list[str]
) -> None:
    """Như `assert_workspace_access` nhưng NỚI cho EMAIL CŨ MÌNH SỞ HỮU
    (chốt user 2026-07-20).

    Bối cảnh: gán workspace chỉ giới hạn việc MỜI (xem [[workspace-assignment-
    limits-add-only]]). Nhưng nếu email đã từng do CHÍNH user này add
    (`invited_by_user_id == user.id`) và giờ `removed`, họ phải mời lại được vào
    ĐÚNG workspace cũ của email đó — dù không còn được gán workspace ấy.

    Quy tắc nới: bỏ qua guard workspace CHỈ KHI mọi email trong lô đều là email
    user đang sở hữu sẵn trong workspace đích. Còn dính 1 email mới/không sở hữu →
    vẫn đòi quyền workspace như cũ (tránh lợi dụng để mời email mới vào ws lạ).
    Cơ chế chủ sở hữu toàn cục (`_assert_email_ownership`) vẫn chạy riêng."""
    if user_can_access_workspace(db, user, workspace_id):
        return
    if emails:
        owned = set(
            db.execute(
                select(Member.email).where(
                    Member.workspace_id == workspace_id,
                    Member.email.in_(emails),
                    Member.invited_by_user_id == user.id,
                )
            )
            .scalars()
            .all()
        )
        if owned and all(e in owned for e in emails):
            return
    # Không đủ điều kiện nới → raise 404 chuẩn (giấu sự tồn tại của workspace).
    assert_workspace_access(db, user, workspace_id)


def _assert_seat_available(
    db: Session, workspace: Workspace, additional: int, user: User
) -> None:
    """Chặn invite khi vượt ngưỡng overcommit. Super-admin bỏ qua (họ quản billing/mua seat).

    effective_used = số Member ACTIVE THẬT trong DB — KHÔNG blend với
    `workspace.seat_used` (scrape billing, có thể cũ/lệch cả 2 chiều, xem
    stats.py). Chỉ đếm member đang hoạt động (active) — member `pending` (chờ
    tham gia) CHƯA được tính vào tổng. Chỉ enforce khi seat_total đã set (workspace
    đã sync billing).

    Cho phép overcommit tới `seat_total * SEAT_OVERCOMMIT_RATIO` (vượt +50%). Chỉ
    khi vượt mốc này mới chặn và báo admin mở thêm seat.
    """
    if user.is_super_admin or workspace.seat_total is None:
        return
    effective_used = (
        db.execute(
            select(func.count(Member.id)).where(
                Member.workspace_id == workspace.id,
                Member.status == "active",
            )
        ).scalar_one()
        or 0
    )
    seat_cap = int(workspace.seat_total * SEAT_OVERCOMMIT_RATIO)
    if effective_used + additional > seat_cap:
        free = max(seat_cap - effective_used, 0)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Chờ admin mở thêm seat: đang dùng {effective_used}/{workspace.seat_total} "
                f"(giới hạn cho phép {seat_cap} = +50%), còn {free} seat "
                f"nhưng yêu cầu mời {additional}"
            ),
        )


@router.post("/invite", response_model=MemberOut, status_code=status.HTTP_201_CREATED)
def invite_member(
    workspace_id: UUID,
    body: MemberInviteIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    ws = _get_workspace_or_404(db, workspace_id)
    email = body.email.lower()
    # Quyền workspace — nới cho email cũ user tự sở hữu (xem _assert_invite_workspace_access).
    _assert_invite_workspace_access(db, user, workspace_id, [email])
    # Cơ chế chủ sở hữu: chặn khi email đã thuộc tài khoản KHÁC (bất kỳ workspace).
    _assert_email_ownership(db, [email], user)
    # 1 email chỉ ở 1 workspace: chặn nếu đang active/pending ở workspace khác.
    _assert_single_workspace(db, [email], workspace_id)
    existing = db.execute(
        select(Member).where(
            Member.workspace_id == workspace_id, Member.email == email
        )
    ).scalar_one_or_none()
    if existing and existing.status != "removed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Member với email này đã tồn tại trong workspace",
        )
    # Seat chỉ tính theo member ACTIVE. Invite mới tạo record `pending` (chưa tính
    # vào tổng); guard chặn theo active hiện tại + số yêu cầu mời so với cap +50%.
    _assert_seat_available(db, ws, 1, user)

    entries: list[tuple[str, int | None]] = [(email, body.subscription_months)]
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)

    # Ví trước, QR sau: dự tính phí → quyết định trừ ví / tạo QR.
    planned = plan_invite_fees(db, workspace_id, entries, user, default_fee)
    total = sum(f for _, f in planned)
    mode = payment_flow.decide_payment(db, user, total)
    if mode == payment_flow.DEFER:
        _create_invite_order_and_raise(db, user, ws, entries, body.role, total, settings_row)

    queue_item, members, chargeable, renew_members = perform_invite_core(
        db, user, ws, entries, body.role, single=True
    )
    if mode == payment_flow.WALLET:
        email_fees = _member_fees(user, chargeable, default_fee)
        if email_fees and queue_item is not None:
            wallet_service.charge_invite(db, user, queue_item.id, email_fees)
        _charge_renewals(db, user, renew_members, default_fee)

    db.commit()
    member = members[0]
    db.refresh(member)
    if queue_item is not None:
        publish_task_event(
            workspace_id,
            {"type": "task-available", "task_id": str(queue_item.id), "task_type": "INVITE_MEMBER"},
        )
    return member


def _unblock_active_if_sync_missing(member: Member) -> None:
    """Cho phép MỜI LẠI member đang ghi `active` khi lần ĐỒNG BỘ gần nhất KHÔNG thấy
    email trong workspace (`sync_missing_at` — extension trả `found_in='none'`).

    Trước đây mọi member `active` đều bị 409 "đang hoạt động, không cần mời lại". Ca
    thật (user 2026-08-22): DB ghi active nhưng người đó đã rời/không còn trong đội,
    đồng bộ lại cũng không thấy → vẫn không mời lại được. Nay hạ về `pending` để
    `perform_invite_core` xếp vào nhánh MỜI (active đi nhánh GIA HẠN, không tạo lời
    mời). Còn hạn → vẫn miễn phí. Member `active` mà sync VẪN THẤY thì giữ nguyên
    chặn 409 (đang trong workspace thật, mời lại vô nghĩa)."""
    if member.status != "active":
        # pending/removed — không đụng, nhưng lệnh mời lại coi như xoá nghi ngờ cũ.
        member.sync_missing_at = None
        return
    if member.sync_missing_at is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Thành viên đang hoạt động trong workspace, không cần mời lại. "
                "Bấm Đồng bộ trước — nếu đồng bộ không thấy email này thì mới mời lại được."
            ),
        )
    member.status = "pending"
    member.sync_missing_at = None


@router.post(
    "/{member_id}/re-invite",
    response_model=MemberOut,
    status_code=status.HTTP_201_CREATED,
)
def reinvite_member(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Action "Mời lại" cho lời mời LỖI (tỉ lệ cực nhỏ nhưng có thật: email đã trừ phí
    + tạo member pending nhưng lời mời không tới nơi/kẹt). Gửi LẠI cho email của member.

    Extension chạy tiền tố (cờ `payload.reinvite`): thu hồi lời mời cũ ở tab Lời mời
    rồi mời như thường. KHÔNG còn bước quét tab Người dùng để huỷ lệnh (user
    2026-08-22: "mời lại là mời lại 1 lần nữa, không cần check").

    Phí (yêu cầu user 2026-07-14): email CÒN HẠN → MIỄN PHÍ, giữ nguyên cửa sổ hạn (đã
    trả rồi). HẾT HẠN → tính phí + chu kỳ mới như mời thường ("ví trước, QR sau"). Chủ
    sở hữu / super-admin (visibility filter). Xem [[reinvite-action-failed-invite]].
    """
    ws = _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)
    _unblock_active_if_sync_missing(member)

    email = member.email.lower()
    role = member.chatgpt_role or "member"
    # Hết hạn → chu kỳ mới dùng lại số tháng lần mua gần nhất của member.
    entries: list[tuple[str, int | None]] = [(email, member.subscription_months)]
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)

    # Ví trước, QR sau — CÒN HẠN thì planned rỗng (miễn phí), total=0 → FREE/WALLET no-op.
    planned = plan_invite_fees(
        db, workspace_id, entries, user, default_fee, reinvite=True
    )
    total = sum(f for _, f in planned)
    mode = payment_flow.decide_payment(db, user, total)
    if mode == payment_flow.DEFER:
        _create_invite_order_and_raise(
            db, user, ws, entries, role, total, settings_row, reinvite=True
        )

    # Đánh dấu lời mời PENDING cũ của email này là superseded (extension sẽ thu hồi bản
    # thật trên ChatGPT). Làm TRƯỚC khi core tạo Invite mới cho lệnh mời lại.
    db.execute(
        update(Invite)
        .where(
            Invite.workspace_id == workspace_id,
            Invite.email == email,
            Invite.status == "pending",
        )
        .values(status="superseded")
    )

    queue_item, members, chargeable, renew_members = perform_invite_core(
        db, user, ws, entries, role, single=True, reinvite=True
    )
    if mode == payment_flow.WALLET:
        email_fees = _member_fees(user, chargeable, default_fee)
        if email_fees and queue_item is not None:
            wallet_service.charge_invite(db, user, queue_item.id, email_fees)
        _charge_renewals(db, user, renew_members, default_fee)

    db.commit()
    member = members[0]
    db.refresh(member)
    if queue_item is not None:
        publish_task_event(
            workspace_id,
            {"type": "task-available", "task_id": str(queue_item.id), "task_type": "INVITE_MEMBER"},
        )
    return member


@router.post(
    "/re-invite-batch", status_code=status.HTTP_202_ACCEPTED, response_model=dict
)
def reinvite_members_batch(
    workspace_id: UUID,
    body: MemberReinviteBatchIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """MỜI LẠI HÀNG LOẠT các dòng đã tick ở tab "Chờ tham gia" (user 2026-08-22).

    Chỉ nhận email CÒN HẠN → mời lại MIỄN PHÍ (mirror `reinvite=True` của
    perform_invite_core). Email HẾT HẠN / VÔ THỜI HẠN bị BỎ QUA và trả về
    `skipped_expired` để web báo "bỏ qua N email hết hạn" — lệnh hàng loạt KHÔNG bao
    giờ trừ ví hay bật modal QR giữa chừng (muốn mời lại email hết hạn thì dùng menu
    ⋯ từng dòng, ở đó có luồng "ví trước, QR sau").

    Member `active` bị bỏ qua (`skipped_active`), TRỪ khi lần đồng bộ gần nhất không
    thấy email trong workspace (`sync_missing_at`) → hạ về `pending` rồi mời lại (xem
    `_unblock_active_if_sync_missing`).

    ChatGPT chỉ cho 1 vai trò / dialog → gom theo `chatgpt_role`, mỗi nhóm 1 task
    INVITE_MEMBER (`payload.reinvite=true`, extension thu hồi lời mời cũ rồi mời lại).
    """
    ws = _get_workspace_or_404(db, workspace_id)
    now = datetime.now(timezone.utc)

    # Visibility filter y hệt re-invite lẻ: sub-admin chỉ thấy member họ mời.
    stmt = select(Member).where(
        Member.workspace_id == workspace_id, Member.id.in_(body.member_ids)
    )
    if not user.is_super_admin:
        stmt = stmt.where(Member.invited_by_user_id == user.id)
    members_in = db.execute(stmt).scalars().all()

    targets: list[Member] = []
    skipped_active = 0
    skipped_expired = 0
    for m in members_in:
        if m.status == "active":
            if m.sync_missing_at is None:
                skipped_active += 1
                continue
            # Đồng bộ không thấy → thực tế đã rời workspace, cho mời lại.
            m.status = "pending"
        m.sync_missing_at = None
        if not _is_paid_period_active(m, now):
            skipped_expired += 1
            continue
        targets.append(m)

    if not targets:
        return {
            "queue_item_ids": [],
            "count": 0,
            "skipped_expired": skipped_expired,
            "skipped_active": skipped_active,
            "skipped_missing": len(body.member_ids) - len(members_in),
        }

    # Thu hồi (đánh dấu superseded) MỌI lời mời pending cũ của các email này — extension
    # thu hồi bản thật trên ChatGPT ở tiền tố. Làm TRƯỚC khi core tạo Invite mới.
    emails = [m.email.lower() for m in targets]
    db.execute(
        update(Invite)
        .where(
            Invite.workspace_id == workspace_id,
            Invite.email.in_(emails),
            Invite.status == "pending",
        )
        .values(status="superseded")
    )

    # ChatGPT: 1 vai trò / dialog → 1 task cho MỖI nhóm vai trò.
    by_role: dict[str, list[Member]] = {}
    for m in targets:
        by_role.setdefault(m.chatgpt_role or "member", []).append(m)

    queue_item_ids: list[str] = []
    for role, group in by_role.items():
        # months bỏ qua ở nhánh còn-hạn (giữ nguyên cửa sổ đã trả) — truyền để mirror
        # chữ ký core, KHÔNG dùng tới vì mọi target đều còn hạn ⇒ miễn phí.
        entries = [(m.email.lower(), m.subscription_months) for m in group]
        queue_item, _members, _chargeable, _renew = perform_invite_core(
            db, user, ws, entries, role, single=len(entries) == 1, reinvite=True
        )
        if queue_item is not None:
            queue_item_ids.append(str(queue_item.id))

    db.commit()
    for qid in queue_item_ids:
        publish_task_event(
            workspace_id,
            {"type": "task-available", "task_id": qid, "task_type": "INVITE_MEMBER"},
        )
    return {
        "queue_item_ids": queue_item_ids,
        "count": len(targets),
        "skipped_expired": skipped_expired,
        "skipped_active": skipped_active,
        "skipped_missing": len(body.member_ids) - len(members_in),
    }


@router.post("/bulk-invite", status_code=status.HTTP_202_ACCEPTED, response_model=dict)
def bulk_invite_members(
    workspace_id: UUID,
    body: MemberBulkInviteIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Mời nhiều email cùng lúc — 1 queue task → extension paste all vào 1 dialog
    ChatGPT (click 'Thêm nhiều hơn' → textarea).

    Tạo:
      - 1 QueueItem type=INVITE_MEMBER với payload.emails = list (KHÔNG single email)
      - N Member records status=pending (1 per email)
      - N Invite records
      - 1 task-available event tới extension

    Ví thiếu → tạo hoá đơn QR cho TỔNG phí + 402 (không tạo gì).
    """
    ws = _get_workspace_or_404(db, workspace_id)
    # Resolve entries (per-email subscription) — dedupe theo email lowercase.
    resolved = body.resolved_entries()
    if not resolved:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Danh sách email rỗng sau dedupe",
        )
    entries: list[tuple[str, int | None]] = [
        (str(e.email).lower(), e.subscription_months) for e in resolved
    ]
    # Quyền workspace — nới cho email cũ user tự sở hữu (xem _assert_invite_workspace_access).
    _assert_invite_workspace_access(db, user, workspace_id, [e for e, _ in entries])
    # Seat guard: chỉ đếm email chiếm seat MỚI (email đang active = gia hạn, đã chiếm
    # seat rồi → không cộng). Tránh chặn oan khi paste toàn email gia hạn.
    _assert_seat_available(
        db, ws, _count_new_invite_seats(db, ws.id, [e for e, _ in entries]), user
    )
    # Cơ chế chủ sở hữu: chặn nếu BẤT KỲ email nào đã thuộc tài khoản khác (bulk
    # trước đây thiếu guard này → tài khoản khác có thể ghi đè invited_by_user_id).
    _assert_email_ownership(db, [e for e, _ in entries], user)
    # 1 email chỉ ở 1 workspace: chặn nếu email nào đang active/pending ở ws khác.
    _assert_single_workspace(db, [e for e, _ in entries], workspace_id)
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)

    planned = plan_invite_fees(db, workspace_id, entries, user, default_fee)
    total = sum(f for _, f in planned)
    mode = payment_flow.decide_payment(db, user, total)
    if mode == payment_flow.DEFER:
        _create_invite_order_and_raise(db, user, ws, entries, body.role, total, settings_row)

    queue_item, members, chargeable, renew_members = perform_invite_core(
        db, user, ws, entries, body.role, single=False
    )
    if mode == payment_flow.WALLET:
        email_fees = _member_fees(user, chargeable, default_fee)
        if email_fees and queue_item is not None:
            wallet_service.charge_invite(db, user, queue_item.id, email_fees)
        _charge_renewals(db, user, renew_members, default_fee)

    db.commit()
    # Task ChatGPT chỉ có khi thực sự có email mời (không phải toàn gia hạn).
    if queue_item is not None:
        publish_task_event(
            workspace_id,
            {
                "type": "task-available",
                "task_id": str(queue_item.id),
                "task_type": "INVITE_MEMBER",
            },
        )
    renewed_count = len(renew_members)
    return {
        "queue_item_id": str(queue_item.id) if queue_item is not None else None,
        "count": len(entries),
        "invited_count": len(members) - renewed_count,
        "renewed_count": renewed_count,
        "member_ids": [str(m.id) for m in members],
    }


@router.post("/invite-preview", response_model=dict)
def preview_invite_fees(
    workspace_id: UUID,
    body: MemberBulkInviteIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Dự tính phí mời cho danh sách email — KHÔNG tạo/không trừ gì, chỉ cho modal hiện
    phí THẬT trước khi bấm Mời.

    Vì sao cần: email CÒN HẠN mời-lại / CHUYỂN workspace / HỢP NHẤT là MIỄN PHÍ, nhưng
    frontend không tự suy được (gói còn hạn có thể nằm ở workspace KHÁC — donor). Endpoint
    này chạy đúng `plan_invite_fees` (mirror lúc mời thật) và trả `free_emails` để UI
    đánh dấu 'Miễn phí' + `total_fee` chính xác (0đ khi tất cả miễn phí). Xem
    [[cross-workspace-move-keeps-paid]]."""
    _get_workspace_or_404(db, workspace_id)
    resolved = body.resolved_entries()
    entries: list[tuple[str, int | None]] = [
        (str(e.email).lower(), e.subscription_months) for e in resolved
    ]
    # Quyền workspace — nới cho email cũ user tự sở hữu (mirror lúc mời thật).
    _assert_invite_workspace_access(db, user, workspace_id, [e for e, _ in entries])
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)
    planned = plan_invite_fees(db, workspace_id, entries, user, default_fee)
    planned_map = dict(planned)
    return {
        "total_fee": sum(planned_map.values()),
        "chargeable": [{"email": e, "fee": f} for e, f in planned],
        "free_emails": [e for e, _ in entries if e not in planned_map],
    }
