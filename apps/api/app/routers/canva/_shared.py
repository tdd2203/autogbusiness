"""Router dùng chung của nhánh CANVA (prefix `/api/v1/canva`).

Nhánh Canva để RIÊNG một package (user 2026-09-01: "làm riêng folder canva riêng để
nó không lẫn"). Những gì dùng chung được với ChatGPT thì GỌI LẠI chứ không chép:
member/kỳ hạn/ví/nhật ký vẫn là bộ máy cũ ở `routers/members` và `services/`.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/canva", tags=["canva"])
