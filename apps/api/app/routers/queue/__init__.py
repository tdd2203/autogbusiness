"""Package `queue` — endpoints quản lý hàng đợi task (queue).

QUY ƯỚC: mỗi chức năng nghiệp vụ = 1 module code + 1 file docs (.md) đi kèm.
TRƯỚC KHI SỬA bất kỳ chức năng nào: ĐỌC file .md tương ứng (lịch sử lỗi +
business rule + ý tưởng cải tiến) → rồi mới đọc & sửa code.

Bản đồ chức năng (mỗi module có file `.md` cùng tên):
  - admin.py          : create_task, list_tasks, cancel_task (API cho dashboard)
  - extension_poll.py : pending_count, active_task, stream_queue_events (SSE) —
                        extension polling/streaming
  - execution.py      : pick_next, update_progress (extension pick & báo tiến độ)
  - completion.py     : update_task (extension báo COMPLETED/FAILED + reconcile
                        DB) — hàm phức tạp nhất, mọi side-effect dễ bug nằm ở đây

`_shared.py` giữ `router` (APIRouter dùng chung, prefix `/api/v1/queue`). Mỗi
sub-module import từ `_shared` và đăng ký route lên cùng `router`. Việc `import`
các module ở dưới là để CHẠY decorator `@router.*` → đăng ký endpoint.
"""

from ._shared import router  # noqa: F401  (re-export cho app.main: queue.router)
from . import (  # noqa: F401  (side-effect: đăng ký route lên router)
    admin,
    completion,
    execution,
    extension_poll,
)

__all__ = ["router"]
