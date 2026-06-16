"""Chức năng: EXTENSION POLLING / STREAMING — đếm pending, task đang chạy, SSE.

⚠️ ĐỌC `extension_poll.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Các endpoint này do EXTENSION gọi (auth bằng X-API-KEY → require_extension_workspace)
để popup hiển thị trạng thái + nhận real-time event đẩy task mới.

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET /pending-count  → pending_count
  - GET /active         → active_task
  - GET /stream         → stream_queue_events (SSE)
"""

import asyncio
import json
import queue as _queue
from datetime import datetime, timezone

from fastapi import Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from sqlalchemy.orm import Session

from app.deps import (
    get_session,
    require_extension_workspace,
)
from app.models import QueueItem, Workspace
from app.sse import subscribe, unsubscribe

from ._shared import router


# ---------- Extension endpoints (X-API-KEY) ----------
@router.get("/pending-count", response_model=dict)
def pending_count(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Extension popup hiển thị số task đang chờ cho workspace tương ứng."""
    from sqlalchemy import func as sa_func

    count = (
        db.execute(
            select(sa_func.count(QueueItem.id)).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "PENDING",
            )
        ).scalar()
        or 0
    )
    return {"count": int(count), "workspace_id": str(workspace.id)}


@router.get("/active", response_model=dict)
def active_task(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Popup extension lấy task đang chạy + tiến trình + đếm pending.

    Trả về:
        in_progress: 1 task IN_PROGRESS gần nhất (hoặc null) — kèm progress JSON
        pending_count: số task PENDING đang chờ pick
        recent_completed: 1 task COMPLETED/FAILED gần nhất trong 60s qua (cho
                          popup hiện "Vừa xong: …") — nullable
    """
    from datetime import timedelta
    from sqlalchemy import func as sa_func

    in_progress = (
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "IN_PROGRESS",
            )
            .order_by(QueueItem.picked_at.desc().nullslast())
            .limit(1)
        )
        .scalars()
        .first()
    )

    pending = (
        db.execute(
            select(sa_func.count(QueueItem.id)).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "PENDING",
            )
        ).scalar()
        or 0
    )

    # Recent terminal task trong 60s gần đây
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=60)
    recent = (
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status.in_(("COMPLETED", "FAILED")),
                QueueItem.completed_at >= cutoff,
            )
            .order_by(QueueItem.completed_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )

    def task_to_dict(t: QueueItem | None) -> dict | None:
        if not t:
            return None
        return {
            "id": str(t.id),
            "type": t.type,
            "status": t.status,
            "progress": t.progress,
            "result": t.result,
            "error_code": t.error_code,
            "error_message": t.error_message,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "picked_at": t.picked_at.isoformat() if t.picked_at else None,
            "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        }

    return {
        "in_progress": task_to_dict(in_progress),
        "pending_count": int(pending),
        "recent_completed": task_to_dict(recent),
        "workspace_id": str(workspace.id),
    }



@router.get("/stream")
async def stream_queue_events(
    workspace: Workspace = Depends(require_extension_workspace),
) -> StreamingResponse:
    """SSE stream: backend push real-time event tới extension khi có task mới.

    Extension fetch /queue/stream với header X-API-KEY, giữ connection mở.
    Khi dashboard tạo task → publish_task_event → SSE yield event NGAY LẬP TỨC.
    Extension nhận event → gọi runUntilIdle → drain queue trong 1-2s.

    Heartbeat 25s/lần để (a) giữ proxy/SW alive, (b) detect dead connection.
    """
    q = subscribe(workspace.id)
    workspace_id = workspace.id
    workspace_name = workspace.name

    async def generator():
        try:
            # Initial event để client biết đã connect thành công.
            hello = {
                "type": "connected",
                "workspace_id": str(workspace_id),
                "workspace_name": workspace_name,
            }
            yield f"data: {json.dumps(hello)}\n\n"

            while True:
                try:
                    event = await asyncio.wait_for(
                        asyncio.to_thread(q.get, True, 25),
                        timeout=30,
                    )
                    yield f"data: {json.dumps(event)}\n\n"
                except (asyncio.TimeoutError, _queue.Empty):
                    # Heartbeat comment — client ignore.
                    yield ": heartbeat\n\n"
        finally:
            unsubscribe(workspace_id, q)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable nginx buffering nếu reverse proxy
        },
    )
