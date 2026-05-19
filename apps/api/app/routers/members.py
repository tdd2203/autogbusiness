"""Member endpoints: list (visibility-filtered), invite, change role, remove."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from datetime import datetime, timedelta, timezone

# Subscription tracking: 1 tháng = 30 ngày cứng (theo spec user). Đặt const để
# tránh magic number rải rác. ChatGPT bill day 11 của tháng → admin set
# subscription_months cho từng member, end_at = created_at + months × 30 days.
SUBSCRIPTION_DAYS_PER_MONTH = 30


def _compute_subscription_end(
    start: datetime, months: int | None
) -> datetime | None:
    if months is None or months <= 0:
        return None
    return start + timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)

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
    MemberBulkInviteIn,
    MemberBulkUpsert,
    MemberChangeRoleIn,
    MemberInviteIn,
    MemberOut,
    MemberUpdateSubscriptionIn,
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

    now = datetime.now(timezone.utc)
    sub_end = _compute_subscription_end(now, body.subscription_months)
    if existing:
        existing.status = "pending"
        existing.chatgpt_role = body.role
        existing.invited_by_user_id = user.id
        existing.subscription_months = body.subscription_months
        existing.subscription_end_at = sub_end
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
    _get_workspace_or_404(db, workspace_id)
    # Resolve entries (per-email subscription) — dedupe theo email lowercase.
    entries = body.resolved_entries()
    if not entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Danh sách email rỗng sau dedupe",
        )

    emails_lower = [str(e.email).lower() for e in entries]
    # ChatGPT bulk-invite dialog chỉ chấp nhận 1 role cho cả batch. Nếu admin
    # muốn role khác, gửi nhiều bulk-invite. Subscription_months thì PER-EMAIL.
    queue_item = QueueItem(
        type="INVITE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"emails": emails_lower, "role": body.role},
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
                member = existing
            else:
                # removed/pending → cho phép re-invite, set lại status
                existing.status = "pending"
                existing.chatgpt_role = body.role
                existing.invited_by_user_id = user.id
                existing.subscription_months = months
                existing.subscription_end_at = sub_end
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


@router.patch("/{member_id}/subscription", response_model=MemberOut)
def update_member_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberUpdateSubscriptionIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Update subscription_months (extend hoặc đổi vô thời hạn).

    end_at = created_at + months × 30 days. Admin có thể giảm/tăng tự do; mỗi
    lần PATCH ghi audit log để có lịch sử thay đổi.
    """
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    old_months = member.subscription_months
    old_end = member.subscription_end_at
    member.subscription_months = body.subscription_months
    member.subscription_end_at = _compute_subscription_end(
        member.created_at, body.subscription_months
    )

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_SUBSCRIPTION_UPDATED",
        result="OK",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "old_months": old_months,
            "new_months": body.subscription_months,
            "old_end_at": old_end.isoformat() if old_end else None,
            "new_end_at": member.subscription_end_at.isoformat()
            if member.subscription_end_at
            else None,
        },
        commit=False,
    )
    db.commit()
    db.refresh(member)
    return member


@router.post("/cleanup-expired", status_code=status.HTTP_202_ACCEPTED)
def cleanup_expired_members(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    """Tìm các member có `subscription_end_at <= now` (active/pending) trong
    workspace → enqueue 1 REMOVE_MEMBER task cho mỗi email + audit log.

    Trả về list email đã enqueue. Dashboard có thể gọi endpoint này để admin
    "1 click remove tất cả expired". Cũng được scheduler ở `main.py` gọi định
    kỳ (background timer) để tự động dọn cho mọi workspace.
    """
    _get_workspace_or_404(db, workspace_id)
    now = datetime.now(timezone.utc)
    expired = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.status.in_(("active", "pending")),
                Member.subscription_end_at.isnot(None),
                Member.subscription_end_at <= now,
            )
        )
        .scalars()
        .all()
    )
    # Visibility: sub-admin chỉ thấy/cleanup member họ invite
    if not user.is_super_admin:
        expired = [m for m in expired if m.invited_by_user_id == user.id]

    enqueued: list[str] = []
    for member in expired:
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
            action="MEMBER_EXPIRED_REMOVE_QUEUED",
            result="PENDING",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "workspace_id": str(workspace_id),
                "email": member.email,
                "subscription_end_at": member.subscription_end_at.isoformat()
                if member.subscription_end_at
                else None,
                "queue_item_id": str(queue_item.id),
            },
            commit=False,
        )
        enqueued.append(member.email)
    if enqueued:
        db.commit()
        for email in enqueued:
            publish_task_event(
                workspace_id,
                {"type": "task-available", "task_type": "REMOVE_MEMBER", "email": email},
            )
    return {"workspace_id": str(workspace_id), "count": len(enqueued), "emails": enqueued}


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
    # Default subscription cho member scrape-only (chưa từng invite qua dashboard):
    # 1 tháng = 30 ngày từ thời điểm tạo row. Theo yêu cầu user 2026-05-19.
    # KHÔNG đụng tới row đã có subscription_months (admin đã chỉnh) — chỉ backfill
    # khi NULL.
    default_sub_months = 1
    default_sub_end = _compute_subscription_end(now, default_sub_months)

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
            # Backfill subscription nếu chưa có (legacy rows trước v0.4.4 hoặc
            # row mới được scrape mà chưa từng invite). Dùng created_at làm base.
            if existing.subscription_months is None:
                existing.subscription_months = default_sub_months
                existing.subscription_end_at = _compute_subscription_end(
                    existing.created_at or now, default_sub_months
                )
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
                    subscription_months=default_sub_months,
                    subscription_end_at=default_sub_end,
                )
            )
            created += 1

    workspace.last_synced_at = now

    removed_count = 0
    # Xác định scope reconcile:
    #   - Nếu body.scraped_statuses set → dùng list đó (chính xác per-sync)
    #   - Else fallback body.is_full_sync: True → ['active','pending']; False → []
    if body.scraped_statuses is not None:
        scopes = tuple(body.scraped_statuses)
    elif body.is_full_sync:
        scopes = ("active", "pending")
    else:
        scopes = ()

    if scopes and body.members:
        incoming_emails = {m.email.lower() for m in body.members}
        stale = (
            db.execute(
                select(Member).where(
                    Member.workspace_id == workspace_id,
                    Member.status.in_(scopes),
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

    # Rogue pending detection: nếu scrape "Lời mời" (pending) thấy email mà
    # KHÔNG có Member record (hoặc record status='removed') → invite này không
    # qua dashboard → trả về để extension auto-revoke trên ChatGPT.
    rogue_pending_emails: list[str] = []
    if scopes and "pending" in scopes:
        # Tất cả pending emails từ scrape
        scraped_pending = [
            m.email.lower() for m in body.members if m.status == "pending"
        ]
        if scraped_pending:
            existing_by_email = {
                row.email.lower(): row
                for row in db.execute(
                    select(Member).where(
                        Member.workspace_id == workspace_id,
                        Member.email.in_(scraped_pending),
                    )
                ).scalars()
            }
            for email in scraped_pending:
                row = existing_by_email.get(email)
                if row is None or row.status == "removed":
                    rogue_pending_emails.append(email)

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
        "rogue_pending_emails": rogue_pending_emails,
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
