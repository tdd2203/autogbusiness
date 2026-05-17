"""Server-Sent Events pub/sub cho real-time push tới extension.

Mỗi workspace có set subscribers (queue.Queue). Khi task được tạo từ dashboard,
publish_task_event() fan-out tới mọi subscriber của workspace đó.

Dùng queue.Queue thread-safe vì FastAPI sync handlers chạy trong threadpool,
trong khi SSE generator chạy trong asyncio event loop. Async generator await
trên `asyncio.to_thread(q.get, ...)` để bridge giữa 2 worlds.
"""

from __future__ import annotations

import queue as _queue
import threading
from typing import Any
from uuid import UUID


_subscribers: dict[UUID, set[_queue.Queue]] = {}
_lock = threading.Lock()


def subscribe(workspace_id: UUID) -> _queue.Queue:
    """Tạo queue mới, đăng ký nhận event cho workspace_id."""
    q: _queue.Queue = _queue.Queue(maxsize=100)
    with _lock:
        _subscribers.setdefault(workspace_id, set()).add(q)
    return q


def unsubscribe(workspace_id: UUID, q: _queue.Queue) -> None:
    with _lock:
        bucket = _subscribers.get(workspace_id)
        if bucket is None:
            return
        bucket.discard(q)
        if not bucket:
            _subscribers.pop(workspace_id, None)


def publish_task_event(workspace_id: UUID, event: dict[str, Any]) -> int:
    """Fan-out event tới mọi subscriber. Returns số subscriber nhận được.

    Non-blocking: nếu subscriber queue full thì DROP event đó cho subscriber đó
    (không block hệ thống). Subscriber nên reconnect/refresh state khi reconnect.
    """
    with _lock:
        bucket = list(_subscribers.get(workspace_id, set()))
    delivered = 0
    for q in bucket:
        try:
            q.put_nowait(event)
            delivered += 1
        except _queue.Full:
            pass
    return delivered


def subscriber_count(workspace_id: UUID) -> int:
    with _lock:
        return len(_subscribers.get(workspace_id, set()))
