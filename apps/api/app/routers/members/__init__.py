"""Package `members` — endpoints quản lý thành viên workspace.

QUY ƯỚC: mỗi chức năng nghiệp vụ = 1 module code + 1 file docs (.md) đi kèm.
TRƯỚC KHI SỬA bất kỳ chức năng nào: ĐỌC file .md tương ứng (lịch sử lỗi +
business rule + ý tưởng cải tiến) → rồi mới đọc & sửa code.

Bản đồ chức năng (mỗi module có file `.md` cùng tên):
  - stats.py         : member_stats, list_members (query thống kê + danh sách)
  - activity.py      : list_member_logs (lịch sử audit 1 member — panel chi tiết)
  - invite.py        : invite_member, bulk_invite_members (+ seat guard)
  - manual_add.py    : manual_add_members (THÊM THỦ CÔNG — bản ghi quản lý, KHÔNG mời/không phí)
  - subscription.py  : update_member_subscription (đổi thời hạn theo ngày mua + tháng — CÓ DUYỆT)
  - renew.py         : renew_member_subscription (GIA HẠN tự phục vụ — KHÔNG duyệt, tạo chu kỳ + reset chưa TT)
  - correct_add_date.py: correct_member_add_date (sửa "ngày gia hạn" ĐÚNG 1 lần — super-admin)
  - change_email.py  : change_member_email (đổi email — xoá cũ + mời mới, giữ hạn)
  - remove.py        : remove_member, bulk_remove, cleanup_expired (xoá)
  - role_license.py  : change role / change license / bulk change license
  - reconcile.py     : bulk_upsert, reconcile_after_invite (API cho EXTENSION)
  - ownership.py     : set_member_owner, bulk_assign_owner (gán chủ sở hữu)
  - lookup.py        : lookup_members (tra cứu member theo email — panel xem trước)
  - usage_limit.py   : bulk_set_usage_limit (đặt giới hạn tín dụng/tháng hàng loạt)

`_shared.py` giữ `router` (APIRouter dùng chung) + helper chung
(`_get_workspace_or_404`, `_visibility_filter`, `_member_or_404_visible`,
`_end_from_purchase`, `_extend_subscription_end`). Mỗi sub-module import từ `_shared` và đăng ký route
lên cùng `router`. Việc `import` các module ở dưới là để CHẠY decorator
`@router.*` → đăng ký endpoint.
"""

from ._shared import router  # noqa: F401  (re-export cho app.main: members.router)
from . import (  # noqa: F401  (side-effect: đăng ký route lên router)
    activity,
    change_email,
    correct_add_date,
    invite,
    lookup,
    manual_add,
    ownership,
    reconcile,
    remove,
    renew,
    role_license,
    stats,
    subscription,
    usage_limit,
)

__all__ = ["router"]
