from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_current_user,
    get_session,
    require_extension_workspace,
    require_permission,
)
from app.models import QueueItem, User, Workspace
from app.permissions import Permission
from app.schemas import QueueCreate, QueueOut, QueueUpdate

router = APIRouter(prefix="/api/v1/queue", tags=["queue"])


_TYPE_TO_PERMISSION = {
    "INVITE_MEMBER": Permission.MEMBER_INVITE,
    "REMOVE_MEMBER": Permission.MEMBER_REMOVE,
    "CHANGE_ROLE": Permission.MEMBER_CHANGE_ROLE,
    "SYNC_DATA": Permission.WORKSPACE_SYNC_TRIGGER,
    "SYNC_BILLING": Permission.WORKSPACE_SYNC_TRIGGER,
}


@router.post("", response_model=QueueOut, status_code=status.HTTP_201_CREATED)
def create_task(
    body: QueueCreate,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> QueueItem:
    required = _TYPE_TO_PERMISSION.get(body.type)
    if required is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Loại task không hợp lệ: {body.type}",
        )
    if not user.is_super_admin and required.value not in (user.permissions or []):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Thiếu permission: {required.value}",
        )

    item = QueueItem(
        type=body.type,
        payload=body.payload,
        status="PENDING",
        workspace_id=body.workspace_id,
        created_by_id=user.id,
    )
    db.add(item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action=f"QUEUE_CREATED:{body.type}",
        result="SUCCESS",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        data={"payload": body.payload},
        commit=False,
    )
    db.commit()
    db.refresh(item)
    return item


@router.get("", response_model=list[QueueOut])
def list_tasks(
    db: Session = Depends(get_session),
    _: User = Depends(require_permission(Permission.QUEUE_VIEW)),
    status_filter: str | None = Query(default=None, alias="status"),
    workspace_id: UUID | None = Query(default=None),
    limit: int = Query(default=50, le=200),
) -> list[QueueItem]:
    stmt = select(QueueItem).order_by(QueueItem.created_at.desc()).limit(limit)
    if status_filter:
        stmt = stmt.where(QueueItem.status == status_filter)
    if workspace_id is not None:
        stmt = stmt.where(QueueItem.workspace_id == workspace_id)
    return list(db.execute(stmt).scalars())


# ---------- Extension endpoints (X-API-KEY) ----------
@router.get("/next", response_model=QueueOut | None)
def pick_next(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem | None:
    """Extension polling: lấy 1 task PENDING FIFO trong workspace của API key, đánh dấu IN_PROGRESS."""
    item = (
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.status == "PENDING",
                QueueItem.workspace_id == workspace.id,
            )
            .order_by(QueueItem.created_at.asc())
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .first()
    )
    if not item:
        return None
    item.status = "IN_PROGRESS"
    item.picked_at = datetime.now(timezone.utc)
    db.add(item)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action=f"QUEUE_PICKED:{item.type}",
        result="PENDING",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        commit=False,
    )
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{item_id}", response_model=QueueOut)
def update_task(
    item_id: UUID,
    body: QueueUpdate,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem:
    item = db.get(QueueItem, item_id)
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Queue item không tồn tại"
        )
    if item.workspace_id != workspace.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Queue item không thuộc workspace của API key này",
        )
    item.status = body.status
    if body.result is not None:
        item.result = body.result
    item.error_code = body.error_code
    item.error_message = body.error_message
    if body.status in ("COMPLETED", "FAILED"):
        item.completed_at = datetime.now(timezone.utc)
    db.add(item)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action=f"QUEUE_UPDATED:{item.type}",
        result=body.status if body.status in ("COMPLETED", "FAILED") else "PENDING",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        data={
            "status": body.status,
            "error_code": body.error_code,
            "error_message": body.error_message,
        },
        commit=False,
    )
    db.commit()
    db.refresh(item)
    return item
