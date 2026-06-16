"""Chức năng: ADMIN QUEUE (dashboard) — tạo / liệt kê / huỷ task.

⚠️ ĐỌC `admin.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /                  → create_task
  - GET  /                  → list_tasks
  - POST /{item_id}/cancel  → cancel_task
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_current_user,
    get_session,
    require_permission,
)
from app.models import QueueItem, User
from app.permissions import Permission
from app.schemas import QueueCreate, QueueOut

from ._shared import router


_TYPE_TO_PERMISSION = {
    "INVITE_MEMBER": Permission.MEMBER_INVITE,
    "REMOVE_MEMBER": Permission.MEMBER_REMOVE,
    "CHANGE_ROLE": Permission.MEMBER_CHANGE_ROLE,
    "CHANGE_LICENSE_TYPE": Permission.MEMBER_CHANGE_ROLE,
    "SYNC_DATA": Permission.WORKSPACE_SYNC_TRIGGER,
    "SYNC_BILLING": Permission.WORKSPACE_SYNC_TRIGGER,
    "REVOKE_INVITES": Permission.MEMBER_REMOVE,
    "PURCHASE_SEAT": Permission.BILLING_PAY,
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
    user: User = Depends(require_permission(Permission.QUEUE_VIEW)),
    status_filter: str | None = Query(default=None, alias="status"),
    workspace_id: UUID | None = Query(default=None),
    limit: int = Query(default=50, le=200),
) -> list[QueueItem]:
    stmt = select(QueueItem).order_by(QueueItem.created_at.desc()).limit(limit)
    if status_filter:
        stmt = stmt.where(QueueItem.status == status_filter)
    if workspace_id is not None:
        stmt = stmt.where(QueueItem.workspace_id == workspace_id)
    # Sub-admin chỉ thấy task DO CHÍNH HỌ tạo; super-admin thấy toàn bộ.
    if not user.is_super_admin:
        stmt = stmt.where(QueueItem.created_by_id == user.id)
    items = list(db.execute(stmt).scalars())
    # Gắn username người tạo (transient attr) để response báo "sub-admin nào yêu cầu".
    for it in items:
        it.created_by_username = it.created_by.username if it.created_by else None
    return items


@router.post("/{item_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
def cancel_task(
    item_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Dashboard user huỷ task đang PENDING hoặc IN_PROGRESS.

    Use case: task treo lâu (extension không pick được, hoặc execution hang) →
    user bấm Huỷ thay vì chờ vô hạn.

    Quyền: super-admin huỷ mọi task; sub-admin chỉ huỷ task mình tạo
    (created_by_id = user.id). Task đã COMPLETED/FAILED → 400 (terminal).
    """
    item = db.get(QueueItem, item_id)
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task không tồn tại"
        )
    if item.status in ("COMPLETED", "FAILED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Task đã ở trạng thái terminal: {item.status}",
        )
    if not user.is_super_admin and item.created_by_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin hoặc người tạo task mới huỷ được",
        )
    item.status = "FAILED"
    item.error_code = "USER_CANCELED"
    item.error_message = f"Huỷ bởi {user.email}"
    item.completed_at = datetime.now(timezone.utc)
    db.add(item)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action=f"QUEUE_CANCELED:{item.type}",
        result="FAILED",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        commit=False,
    )
    db.commit()
    return {"id": str(item.id), "status": "FAILED"}
