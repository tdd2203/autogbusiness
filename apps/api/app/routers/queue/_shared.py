"""Shared router cho package `queue`.

Mọi sub-module (admin.py, extension_poll.py, execution.py, completion.py) import
`router` từ đây để đăng ký endpoint lên CÙNG một APIRouter
(prefix `/api/v1/queue`).

Đây KHÔNG phải nơi chứa business logic của 1 chức năng cụ thể — chỉ những thứ
dùng chung giữa nhiều chức năng. Mỗi chức năng có module + file docs (.md) riêng.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/queue", tags=["queue"])
