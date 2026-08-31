"""Package `canva` — endpoint riêng của nhánh Canva.

Bản đồ chức năng:
  - pricing.py : bảng giá bậc thang (xem, đặt mặc định hệ thống, đặt hàng loạt cho
                 đại lý). Công thức tính tiền nằm ở `services/canva_price.py`.
  - links.py   : lưu liên kết mời duy nhất của từng email (extension gọi sau khi mời).

`_shared.py` giữ `router` (prefix `/api/v1/canva`); import submodule ở đây để
decorator `@router.*` chạy và đăng ký endpoint.
"""

from ._shared import router  # noqa: F401  (re-export cho app.main: canva.router)
from . import links, pricing  # noqa: F401,E402  (side-effect: đăng ký route)

__all__ = ["router"]
