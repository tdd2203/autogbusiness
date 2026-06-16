"""Chức năng: REMOVE MEMBER (xoá thành viên) — đơn / hàng loạt / cleanup hết hạn.

⚠️ ĐỌC `remove.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST   /cleanup-expired   → cleanup_expired_members
  - POST   /bulk-remove       → bulk_remove_members
  - DELETE /{member_id}       → remove_member
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    get_session,
    require_permission,
)
from app.models import Member, QueueItem, User
from app.permissions import Permission
from app.schemas import MemberBulkRemoveIn
from app.sse import publish_task_event

from ._shared import (
    router,
    _get_workspace_or_404,
    _member_or_404_visible,
    _visibility_filter,
)


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
    assert_workspace_access(db, user, workspace_id)
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


@router.post("/bulk-remove", status_code=status.HTTP_202_ACCEPTED)
def bulk_remove_members(
    workspace_id: UUID,
    body: MemberBulkRemoveIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    """Xoá hàng loạt member → enqueue 1 REMOVE_MEMBER task cho MỖI member.

    Khác bulk-invite (gộp 1 task vì ChatGPT cho paste nhiều email vào 1 dialog):
    extension chỉ remove được 1 member / dialog nên mỗi member = 1 task riêng
    (giống cleanup-expired + DELETE đơn).

    Chọn member bằng `member_ids` (checkbox trong bảng) và/hoặc `emails` (dán
    tay). Backend gộp & dedupe theo member.id, áp visibility (sub-admin chỉ xoá
    member mình mời) và chỉ lấy member status active/pending. id/email không khớp
    → bỏ qua; emails không match trả về trong `skipped` để UI cảnh báo.
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)

    emails_lower = {e.strip().lower() for e in body.emails if e.strip()}
    if not body.member_ids and not emails_lower:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cần ít nhất 1 member_id hoặc email để xoá",
        )

    conds = []
    if body.member_ids:
        conds.append(Member.id.in_(body.member_ids))
    if emails_lower:
        conds.append(func.lower(Member.email).in_(emails_lower))

    stmt = select(Member).where(
        Member.workspace_id == workspace_id,
        Member.status.in_(("active", "pending")),
        or_(*conds),
    )
    stmt = _visibility_filter(stmt, user)
    # Dedupe theo id (member có thể khớp cả member_ids lẫn emails).
    targets = {m.id: m for m in db.execute(stmt).scalars()}

    enqueued: list[str] = []
    for member in targets.values():
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
            action="MEMBER_BULK_REMOVE_QUEUED",
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
        enqueued.append(member.email)

    if enqueued:
        db.commit()
        for email in enqueued:
            publish_task_event(
                workspace_id,
                {
                    "type": "task-available",
                    "task_type": "REMOVE_MEMBER",
                    "email": email,
                },
            )

    matched_lower = {m.email.lower() for m in targets.values()}
    skipped = sorted(emails_lower - matched_lower)
    return {
        "workspace_id": str(workspace_id),
        "count": len(enqueued),
        "emails": enqueued,
        "skipped": skipped,
    }


@router.delete("/{member_id}", status_code=status.HTTP_202_ACCEPTED)
def remove_member(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
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
