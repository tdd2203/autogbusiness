"""Chức năng: INVITE MEMBER (mời thành viên — đơn & hàng loạt).

⚠️ ĐỌC `invite.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoints:
  - POST /invite       → invite_member       (1 email)
  - POST /bulk-invite  → bulk_invite_members  (nhiều email, 1 task)

Seat guard `_assert_seat_available` sống ở đây (chỉ luồng invite cần chặn seat).
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
from app.sse import publish_task_event
from app.schemas import MemberBulkInviteIn, MemberInviteIn, MemberOut

from ._shared import router, _compute_subscription_end, _get_workspace_or_404


# Cho phép invite vượt seat_total tối đa +50% (overcommit). Vượt ngưỡng này thì
# chặn và yêu cầu admin mở thêm seat. Đổi hệ số ở đây nếu muốn nới/siết.
SEAT_OVERCOMMIT_RATIO = 1.5


def _assert_seat_available(
    db: Session, workspace: Workspace, additional: int, user: User
) -> None:
    """Chặn invite khi vượt ngưỡng overcommit. Super-admin bỏ qua (họ quản billing/mua seat).

    effective_used = max(seat_used báo từ billing, số Member ACTIVE trong DB).
    Chỉ đếm member đang hoạt động (active) — member `pending` (chờ tham gia) CHƯA
    được tính vào tổng. Chỉ enforce khi seat_total đã set (workspace đã sync billing).

    Cho phép overcommit tới `seat_total * SEAT_OVERCOMMIT_RATIO` (vượt +50%). Chỉ
    khi vượt mốc này mới chặn và báo admin mở thêm seat.
    """
    if user.is_super_admin or workspace.seat_total is None:
        return
    db_used = (
        db.execute(
            select(func.count(Member.id)).where(
                Member.workspace_id == workspace.id,
                Member.status == "active",
            )
        ).scalar_one()
        or 0
    )
    effective_used = max(workspace.seat_used or 0, db_used)
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

    existing = db.execute(
        select(Member).where(
            Member.workspace_id == workspace_id, Member.email == body.email.lower()
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

    queue_item = QueueItem(
        type="INVITE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={
            "email": body.email.lower(),
            "role": body.role,
            "verified_domain": ws.verified_domain,
        },
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    now = datetime.now(timezone.utc)
    sub_end = _compute_subscription_end(now, body.subscription_months)
    if existing:
        existing.status = "pending"
        existing.chatgpt_role = body.role
        existing.invited_by_user_id = user.id
        existing.subscription_months = body.subscription_months
        existing.subscription_end_at = sub_end
        existing.last_invited_at = now
        member = existing
    else:
        member = Member(
            workspace_id=workspace_id,
            email=body.email.lower(),
            chatgpt_role=body.role,
            status="pending",
            invited_by_user_id=user.id,
            subscription_months=body.subscription_months,
            subscription_end_at=sub_end,
            last_invited_at=now,
        )
        db.add(member)

    invite_row = Invite(
        workspace_id=workspace_id,
        email=body.email.lower(),
        role=body.role,
        status="pending",
        queue_item_id=queue_item.id,
        invited_by_user_id=user.id,
    )
    db.add(invite_row)
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_INVITE_QUEUED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "role": body.role,
            "queue_item_id": str(queue_item.id),
            "subscription_months": body.subscription_months,
            "subscription_end_at": sub_end.isoformat() if sub_end else None,
        },
        commit=False,
    )
    db.commit()
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
    """
    ws = _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    # Resolve entries (per-email subscription) — dedupe theo email lowercase.
    entries = body.resolved_entries()
    if not entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Danh sách email rỗng sau dedupe",
        )
    # Seat guard: số email mời mới (entries đã dedupe). Một số có thể là member
    # đã removed/active sẵn nhưng ta dùng count làm chặn trên an toàn (conservative).
    _assert_seat_available(db, ws, len(entries), user)

    emails_lower = [str(e.email).lower() for e in entries]
    # ChatGPT bulk-invite dialog chỉ chấp nhận 1 role cho cả batch. Nếu admin
    # muốn role khác, gửi nhiều bulk-invite. Subscription_months thì PER-EMAIL.
    queue_item = QueueItem(
        type="INVITE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={
            "emails": emails_lower,
            "role": body.role,
            "verified_domain": ws.verified_domain,
        },
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    # Tạo Member + Invite cho mỗi email với subscription_months riêng.
    now = datetime.now(timezone.utc)
    created_member_ids: list[str] = []
    audit_emails: list[dict] = []
    for entry in entries:
        email = str(entry.email).lower()
        months = entry.subscription_months
        sub_end = _compute_subscription_end(now, months)
        audit_emails.append(
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
            # KHÔNG downgrade active → pending khi admin lỡ invite lại email
            # đã active. Active member trên ChatGPT sẽ reject invite này; nếu
            # ta đã đổi status=pending thì record bị corrupt + extension verify
            # FAIL → phantom cleanup không xoá được vì joined_at SET → record
            # mãi mãi sai. Giữ nguyên active, chỉ refresh subscription nếu
            # admin chủ động đổi months.
            if existing.status == "active":
                if (
                    months is not None
                    and months != existing.subscription_months
                ):
                    existing.subscription_months = months
                    existing.subscription_end_at = sub_end
                existing.last_invited_at = now
                member = existing
            else:
                # removed/pending → cho phép re-invite, set lại status
                existing.status = "pending"
                existing.chatgpt_role = body.role
                existing.invited_by_user_id = user.id
                existing.subscription_months = months
                existing.subscription_end_at = sub_end
                existing.last_invited_at = now
                member = existing
        else:
            member = Member(
                workspace_id=workspace_id,
                email=email,
                chatgpt_role=body.role,
                status="pending",
                invited_by_user_id=user.id,
                subscription_months=months,
                subscription_end_at=sub_end,
                last_invited_at=now,
            )
            db.add(member)
        db.flush()
        created_member_ids.append(str(member.id))

        db.add(
            Invite(
                workspace_id=workspace_id,
                email=email,
                role=body.role,
                status="pending",
                queue_item_id=queue_item.id,
                invited_by_user_id=user.id,
            )
        )

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
            "entries": audit_emails,
            "role": body.role,
            "count": len(emails_lower),
        },
        commit=False,
    )
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
        "count": len(emails_lower),
        "member_ids": created_member_ids,
    }
