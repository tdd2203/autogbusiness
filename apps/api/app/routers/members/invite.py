"""Chức năng: INVITE MEMBER (mời thành viên — đơn & hàng loạt).

⚠️ ĐỌC `invite.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Tính hạn (anchor/end) tuân theo `EXPIRY_RULES.md` — KHÔNG tự chế công thức.

Endpoints:
  - POST /invite       → invite_member       (1 email)
  - POST /bulk-invite  → bulk_invite_members  (nhiều email, 1 task)

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
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import assert_workspace_access, get_session, require_permission
from app.models import Invite, Member, QueueItem, User, Workspace
from app.permissions import Permission
from app.routers.wallet._shared import get_payment_settings
from app.services import payment_flow, wallet_service
from app.sse import publish_task_event
from app.schemas import MemberBulkInviteIn, MemberInviteIn, MemberOut

from ._shared import (
    router,
    _apply_invite_paid_cycle,
    _end_from_purchase,
    _get_workspace_or_404,
)


# Cho phép invite vượt seat_total tối đa +50% (overcommit). Vượt ngưỡng này thì
# chặn và yêu cầu admin mở thêm seat. Đổi hệ số ở đây nếu muốn nới/siết.
SEAT_OVERCOMMIT_RATIO = 1.5


# ── Core dùng chung: tạo member/queue/invite (KHÔNG trừ phí, KHÔNG commit) ─────

def perform_invite_core(
    db: Session,
    user: User,
    workspace: Workspace,
    entries: list[tuple[str, int | None]],
    role: str,
    *,
    single: bool,
) -> tuple[QueueItem, list[Member], list[Member]]:
    """Tạo QueueItem + Member/Invite cho lệnh mời. KHÔNG trừ phí, KHÔNG commit,
    KHÔNG publish SSE — caller lo (endpoint hoặc webhook replay sau thanh toán QR).

    `entries`: list (email_lowercase, subscription_months). `single=True` (đúng 1
    entry) → payload queue dạng {"email": ...} + log MEMBER_INVITE_QUEUED (khớp luồng
    /invite cũ); ngược lại {"emails": [...]} + MEMBER_BULK_INVITE_QUEUED.

    Trả (queue_item, all_members, chargeable_members). `chargeable` = member thực sự
    tạo lời mời mới (loại email đang ACTIVE không downgrade). Xem research.md D6.
    """
    workspace_id = workspace.id
    emails_lower = [e for e, _ in entries]
    payload: dict = {"role": role, "verified_domain": workspace.verified_domain}
    if single and len(entries) == 1:
        payload["email"] = emails_lower[0]
    else:
        payload["emails"] = emails_lower

    queue_item = QueueItem(
        type="INVITE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload=payload,
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    now = datetime.now(timezone.utc)
    all_members: list[Member] = []
    chargeable: list[Member] = []
    audit_entries: list[dict] = []
    for email, months in entries:
        sub_end = _end_from_purchase(now, months)
        audit_entries.append(
            {
                "email": email,
                "subscription_months": months,
                "subscription_end_at": sub_end.isoformat() if sub_end else None,
            }
        )
        existing = db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id, Member.email == email
            )
        ).scalar_one_or_none()
        if existing:
            if existing.status == "active":
                # KHÔNG downgrade active → pending. Active member trên ChatGPT sẽ
                # reject invite này; nếu đổi status=pending record bị corrupt +
                # phantom cleanup không xoá được. Chỉ refresh subscription nếu admin
                # chủ động đổi months. Active KHÔNG tạo lời mời mới → KHÔNG tính phí.
                if months is not None and months != existing.subscription_months:
                    existing.subscription_months = months
                    existing.subscription_purchased_at = now
                    existing.subscription_end_at = sub_end
                existing.last_invited_at = now
                member = existing
            else:
                # removed/pending → cho phép re-invite. Mời lại email đã bị XOÁ =
                # chu kỳ tham gia mới → joined_at = lúc mời lại (bất biến invite-time
                # = join-date); chỉ reset khi status cũ = 'removed'. Member 'pending'
                # chưa từng tham gia → giữ joined_at để set đúng lúc tham gia thật.
                if existing.status == "removed":
                    existing.joined_at = now
                    existing.removed_at = None  # reset mốc retention 30 ngày
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

    # Phí mời thu TRƯỚC (ví/QR) → mỗi email thực sự tạo lời mời mới (chargeable) sinh
    # 1 chu kỳ ĐÃ THANH TOÁN ngay, hiển thị "Đã thanh toán" không cần duyệt tay (nhất
    # quán renew). Email đang ACTIVE không tạo lời mời mới → không đụng (giữ chu kỳ cũ).
    # `subscription_months` của member đã được set = số tháng lời mời này ở trên.
    for m in chargeable:
        _apply_invite_paid_cycle(
            db, m, months=m.subscription_months, actor_id=user.id, now=now
        )

    # Audit (commit=False). Nhãn single vs bulk giữ khớp luồng cũ.
    if single and len(entries) == 1:
        m0 = all_members[0]
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
                "email": emails_lower[0],
                "role": role,
                "queue_item_id": str(queue_item.id),
                "subscription_months": entries[0][1],
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
                "count": len(emails_lower),
            },
            commit=False,
        )
    return queue_item, all_members, chargeable


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


def plan_invite_fees(
    db: Session,
    workspace_id: UUID,
    entries: list[tuple[str, int | None]],
    user: User,
    default_fee: int,
) -> list[tuple[str, int]]:
    """Dự tính (email, fee) SẼ bị trừ nếu mời — mirror quy tắc chargeable của
    perform_invite_core (email đang ACTIVE không tạo lời mời mới → không tính phí).
    Chỉ để quyết định trừ-ví-hay-tạo-QR; trừ THẬT dùng members trả về từ core."""
    emails = [e for e, _ in entries]
    existing = {
        m.email: m
        for m in db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id, Member.email.in_(emails)
            )
        ).scalars().all()
    }
    out: list[tuple[str, int]] = []
    for email, months in entries:
        m = existing.get(email)
        if m is not None and m.status == "active":
            continue  # active không tính phí
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
) -> None:
    """Ví thiếu → tạo hoá đơn QR mời + HTTP 402. KHÔNG tạo member/queue (chờ trả tiền).

    Chưa cấu hình ngân hàng nhận → không dựng được QR → fallback 402 báo nạp thêm.
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
    order = payment_flow.create_order(
        db,
        user,
        kind="invite",
        amount=amount,
        payload={
            "role": role,
            "entries": [{"email": e, "subscription_months": m} for e, m in entries],
        },
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
    """CƠ CHẾ CHỦ SỞ HỮU (toàn hệ thống, chốt user 2026-07-13).

    Email đã được mời qua dashboard (có `Member` với `invited_by_user_id`) ở BẤT KỲ
    workspace nào thì THUỘC VỀ tài khoản đã mời đầu tiên. Tài khoản KHÁC — kể cả
    super-admin — KHÔNG được mời email đó ở đâu nữa, KỂ CẢ khi member đã `removed`
    (giữ quyền theo chủ sở hữu, không mở lại cho người khác). Chủ sở hữu cũ vẫn mời
    lại được (owner_id == user.id → bỏ qua).

    Phạm vi GLOBAL (không lọc theo workspace_id) — nên chặn cả khi tài khoản khác
    thử mời cùng email sang workspace khác. Lời mời FAILED tự xoá Member (phantom
    cleanup ở completion.py) nên giải phóng email cho người khác.

    Chỉ xét member có `invited_by_user_id` NOT NULL: member scrape thuần từ ChatGPT
    (không rõ ai mời) KHÔNG thiết lập quyền sở hữu. Xem [[invite-owner-lock]]."""
    if not emails:
        return
    conflict = db.execute(
        select(Member.email, Member.invited_by_user_id)
        .where(
            Member.email.in_(emails),
            Member.invited_by_user_id.isnot(None),
            Member.invited_by_user_id != user.id,
        )
        .limit(1)
    ).first()
    if conflict is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Email {conflict.email} đã được tài khoản khác mời "
                f"(cơ chế chủ sở hữu) — bạn không thể mời email này."
            ),
        )


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
    assert_workspace_access(db, user, workspace_id)

    email = body.email.lower()
    # Cơ chế chủ sở hữu: chặn khi email đã thuộc tài khoản KHÁC (bất kỳ workspace).
    _assert_email_ownership(db, [email], user)
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

    queue_item, members, chargeable = perform_invite_core(
        db, user, ws, entries, body.role, single=True
    )
    if mode == payment_flow.WALLET:
        email_fees = _member_fees(user, chargeable, default_fee)
        if email_fees:
            wallet_service.charge_invite(db, user, queue_item.id, email_fees)

    db.commit()
    member = members[0]
    db.refresh(member)
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "INVITE_MEMBER"},
    )
    return member


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
    assert_workspace_access(db, user, workspace_id)
    # Resolve entries (per-email subscription) — dedupe theo email lowercase.
    resolved = body.resolved_entries()
    if not resolved:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Danh sách email rỗng sau dedupe",
        )
    # Seat guard: số email mời mới (entries đã dedupe). Một số có thể là member
    # đã removed/active sẵn nhưng ta dùng count làm chặn trên an toàn (conservative).
    _assert_seat_available(db, ws, len(resolved), user)

    entries: list[tuple[str, int | None]] = [
        (str(e.email).lower(), e.subscription_months) for e in resolved
    ]
    # Cơ chế chủ sở hữu: chặn nếu BẤT KỲ email nào đã thuộc tài khoản khác (bulk
    # trước đây thiếu guard này → tài khoản khác có thể ghi đè invited_by_user_id).
    _assert_email_ownership(db, [e for e, _ in entries], user)
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)

    planned = plan_invite_fees(db, workspace_id, entries, user, default_fee)
    total = sum(f for _, f in planned)
    mode = payment_flow.decide_payment(db, user, total)
    if mode == payment_flow.DEFER:
        _create_invite_order_and_raise(db, user, ws, entries, body.role, total, settings_row)

    queue_item, members, chargeable = perform_invite_core(
        db, user, ws, entries, body.role, single=False
    )
    if mode == payment_flow.WALLET:
        email_fees = _member_fees(user, chargeable, default_fee)
        if email_fees:
            wallet_service.charge_invite(db, user, queue_item.id, email_fees)

    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "INVITE_MEMBER",
        },
    )
    return {
        "queue_item_id": str(queue_item.id),
        "count": len(entries),
        "member_ids": [str(m.id) for m in members],
    }
