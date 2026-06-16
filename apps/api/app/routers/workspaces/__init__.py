"""Package `workspaces` — endpoints quản lý workspace + extension API.

QUY ƯỚC: mỗi chức năng nghiệp vụ = 1 module code + 1 file docs (.md) đi kèm.
TRƯỚC KHI SỬA bất kỳ chức năng nào: ĐỌC file .md tương ứng (lịch sử lỗi +
business rule + ý tưởng cải tiến) → rồi mới đọc & sửa code.

Bản đồ chức năng (mỗi module có file `.md` cùng tên):
  - crud.py        : extension_whoami, update_extension_info, list_workspaces,
                     create_workspace, get_workspace, update_workspace
  - assignment.py  : list_workspace_assignments, assign_user_to_workspace,
                     unassign_user_from_workspace (gán/gỡ sub-admin)
  - billing.py     : push_billing_sync (extension đẩy billing scrape)
  - triggers.py    : trigger_sync, trigger_revoke_invites, trigger_harvest_labels,
                     trigger_sync_billing, trigger_purchase_seat (enqueue task)
  - apikey.py      : reveal_api_key, regenerate_api_key (X-API-KEY)
  - settings.py    : get_workspace_settings, update_workspace_settings,
                     get_extension_status (poll SSE online)

`_shared.py` giữ `router` (APIRouter dùng chung, prefix `/api/v1/workspaces`) +
helper chung (`_generate_api_key`, `_get_workspace_or_404`, `_normalize_domain`).
Mỗi sub-module import từ `_shared` và đăng ký route lên cùng `router`. Việc
`import` các module ở dưới là để CHẠY decorator `@router.*` → đăng ký endpoint.
"""

from ._shared import router  # noqa: F401  (re-export cho app.main: workspaces.router)
from . import (  # noqa: F401  (side-effect: đăng ký route lên router)
    crud,
    assignment,
    billing,
    triggers,
    apikey,
    settings,
)

__all__ = ["router"]
