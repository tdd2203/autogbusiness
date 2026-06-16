"""Package `ui_labels` — UI Label calibration cho 3 locale × 4 page ChatGPT admin.

UI Label calibration — labels ChatGPT đã harvest cho 3 locale × 4 page.

Flow:
  - Super-admin harvest qua trang Settings → POST /bulk lưu label vào DB.
  - Extension fetch /bundle khi khởi động → cache local, dùng khi automation.
  - Khi extension không match được → POST /report-mismatch → label stale=true.
  - Dashboard hiện banner stale + nút "Mở harvest" để re-calibrate đúng cell.

QUY ƯỚC: mỗi chức năng nghiệp vụ = 1 module code + 1 file docs (.md) đi kèm.
TRƯỚC KHI SỬA bất kỳ chức năng nào: ĐỌC file .md tương ứng (lịch sử lỗi +
business rule + ý tưởng cải tiến) → rồi mới đọc & sửa code.

Bản đồ chức năng (mỗi module có file `.md` cùng tên):
  - manage.py   : list_labels, coverage, bulk_upsert, update_label, clear_stale,
                  label_history, rollback_label
                  (admin calibration + versioning + view — Permission.UI_LABEL_MANAGE)
  - harvest.py  : extension_bundle, auto_harvest, report_mismatch
                  (API cho EXTENSION qua require_extension_workspace)

`_shared.py` giữ `router` (APIRouter dùng chung, prefix `/api/v1/ui-labels`) +
const chung (`LOCALES`, `PAGES`, `CONTROL_KEYS_BY_PAGE`) + helper `_push_history`.
Mỗi sub-module import từ `_shared` và đăng ký route lên cùng `router`. Việc
`import` các module ở dưới là để CHẠY decorator `@router.*` → đăng ký endpoint.
"""

from ._shared import router  # noqa: F401  (re-export cho app.main: ui_labels.router)
from . import (  # noqa: F401  (side-effect: đăng ký route lên router)
    harvest,
    manage,
)

__all__ = ["router"]
