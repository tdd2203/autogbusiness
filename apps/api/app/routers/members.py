"""Member endpoints: list (visibility-filtered), invite, change role, remove."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from datetime import datetime, timezone

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
    require_permission,
    require_super_admin,
)
from app.models import Invite, Member, QueueItem, User, Workspace
from app.permissions import Permission
from app.sse import publish_task_event
from app.schemas import (
    MemberBulkUpsert,
    MemberChangeRoleIn,
    MemberInviteIn,
    MemberOut,
)

router = APIRouter(prefix="/api/v1/workspaces/{workspace_id}/members", tags=["members"])


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


@router.get("", response_model=list[MemberOut])
def list_members(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
    include_removed: bool = False,
) -> list[Member]:
    _get_workspace_or_404(db, workspace_id)
    stmt = (
        select(Member)
        .where(Member.workspace_id == workspace_id)
        .order_by(Member.created_at.desc())
    )
    if not include_removed:
        stmt = stmt.where(Member.status != "removed")
    stmt = _visibility_filter(stmt, user)
    return list(db.execute(stmt).scalars())


@router.post("/invite", response_model=MemberOut, status_code=status.HTTP_201_CREATED)
def invite_member(
    workspace_id: UUID,
    body: MemberInviteIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    _get_workspace_or_404(db, workspace_id)

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

    queue_item = QueueItem(
        type="INVITE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"email": body.email.lower(), "role": body.role},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    if existing:
        existing.status = "pending"
        existing.chatgpt_role = body.role
        existing.invited_by_user_id = user.id
        member = existing
    else:
        member = Member(
            workspace_id=workspace_id,
            email=body.email.lower(),
            chatgpt_role=body.role,
            status="pending",
            invited_by_user_id=user.id,
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


@router.delete("/{member_id}", status_code=status.HTTP_202_ACCEPTED)
def remove_member(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    queue_item = QueueItem(
        type="REMOVE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"member_id": str(member.id), "email": member.email},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_REMOVE_QUEUED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "queue_item_id": str(queue_item.id),
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "REMOVE_MEMBER"},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}


@router.post("/bulk-upsert", response_model=dict)
def bulk_upsert_members(
    workspace_id: UUID,
    body: MemberBulkUpsert,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Extension gọi sau khi scrape workspace member list.

    Upsert theo (workspace_id, email). KHÔNG đụng `invited_by_user_id` của row đã có.
    Row mới (chưa từng invite qua dashboard) sẽ có `invited_by_user_id = NULL`.
    """
    if workspace.id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key không khớp với workspace trong URL",
        )

    now = datetime.now(timezone.utc)
    created = 0
    updated = 0

    for m in body.members:
        email = m.email.lower()
        existing = db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id, Member.email == email
            )
        ).scalar_one_or_none()

        if existing:
            existing.name = m.name if m.name is not None else existing.name
            existing.chatgpt_role = (
                m.chatgpt_role if m.chatgpt_role is not None else existing.chatgpt_role
            )
            existing.status = m.status
            if m.joined_at:
                existing.joined_at = m.joined_at
            existing.last_synced_at = now
            updated += 1
        else:
            db.add(
                Member(
                    workspace_id=workspace_id,
                    email=email,
                    name=m.name,
                    chatgpt_role=m.chatgpt_role,
                    status=m.status,
                    joined_at=m.joined_at,
                    last_synced_at=now,
                )
            )
            created += 1

    workspace.last_synced_at = now

    removed_count = 0
    if body.is_full_sync and body.members:
        incoming_emails = {m.email.lower() for m in body.members}
        stale = (
            db.execute(
                select(Member).where(
                    Member.workspace_id == workspace_id,
                    Member.status == "active",
                    Member.email.notin_(incoming_emails),
                )
            )
            .scalars()
            .all()
        )
        for m in stale:
            m.status = "removed"
            m.last_synced_at = now
            removed_count += 1

    db.add(workspace)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action="MEMBER_BULK_UPSERT",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={
            "created": created,
            "updated": updated,
            "removed_missing": removed_count,
            "total": len(body.members),
            "is_full_sync": body.is_full_sync,
        },
        commit=False,
    )
    db.commit()
    return {
        "created": created,
        "updated": updated,
        "removed_missing": removed_count,
        "total": len(body.members),
    }


@router.patch("/{member_id}/role", status_code=status.HTTP_202_ACCEPTED)
def change_member_role(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberChangeRoleIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    queue_item = QueueItem(
        type="CHANGE_ROLE",
        status="PENDING",
        workspace_id=workspace_id,
        payload={
            "member_id": str(member.id),
            "email": member.email,
            "new_role": body.new_role,
            "old_role": member.chatgpt_role,
        },
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_CHANGE_ROLE_QUEUED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "old_role": member.chatgpt_role,
            "new_role": body.new_role,
            "queue_item_id": str(queue_item.id),
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "CHANGE_ROLE"},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}
