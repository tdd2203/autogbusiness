"""Chức năng: EXTENSION EXECUTION — pick task kế tiếp + báo tiến độ.

⚠️ ĐỌC `execution.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Các endpoint này do EXTENSION gọi (auth bằng X-API-KEY → require_extension_workspace)
để lấy task PENDING kế tiếp (FIFO) và đẩy progress real-time trong lúc chạy.
Việc báo COMPLETED/FAILED + reconcile DB nằm ở `completion.py`.

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET   /next               → pick_next
  - PATCH /{item_id}/progress → update_progress
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import QueueItem, Workspace
from app.schemas import QueueOut, QueueProgressUpdate

from ._shared import router


@router.get("/next", response_model=QueueOut | None)
def pick_next(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem | None:
    """Extension polling: lấy 1 task PENDING FIFO trong workspace của API key, đánh dấu IN_PROGRESS.

    Trước khi pick task mới, AUTO-FAIL task IN_PROGRESS bị treo > 5 phút trong
    cùng workspace — extension picked nhưng không trả kết quả (content script
    crash, tab close, DOM treo, …). Lazy cleanup tránh popup hiển thị 'ĐANG
    CHẠY' mãi mãi + cho phép task tiếp theo chạy.
    """
    from datetime import timedelta

    STUCK_THRESHOLD = timedelta(minutes=5)
    now = datetime.now(timezone.utc)
    cutoff = now - STUCK_THRESHOLD
    stuck_tasks = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "IN_PROGRESS",
                QueueItem.picked_at < cutoff,
            )
        )
        .scalars()
        .all()
    )
    for stuck in stuck_tasks:
        age_sec = int((now - stuck.picked_at).total_seconds()) if stuck.picked_at else None
        stuck.status = "FAILED"
        stuck.error_code = "TIMEOUT"
        stuck.error_message = (
            f"Task IN_PROGRESS quá 5 phút ({age_sec}s) — extension không trả "
            f"kết quả. Auto-cleanup lúc pick task tiếp theo."
        )
        stuck.completed_at = now
        db.add(stuck)
        log_event(
            db,
            actor_type="SYSTEM",
            actor_label="lazy-cleanup",
            action=f"QUEUE_TIMEOUT:{stuck.type}",
            result="FAILED",
            target_type="QUEUE_ITEM",
            target_id=str(stuck.id),
            data={"age_sec": age_sec, "workspace_id": str(workspace.id)},
            commit=False,
        )
    if stuck_tasks:
        db.commit()

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


@router.patch("/{item_id}/progress", response_model=QueueOut)
def update_progress(
    item_id: UUID,
    body: QueueProgressUpdate,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem:
    """Extension báo progress real-time, KHÔNG audit log từng tick (tránh spam)."""
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
    item.progress = body.progress
    db.add(item)
    db.commit()
    db.refresh(item)
    return item
