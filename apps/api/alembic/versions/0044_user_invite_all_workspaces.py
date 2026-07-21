"""cờ invite_all_workspaces cho users (cấu hình đích trang Mời thành viên)

Revision ID: 0044_user_invite_all_workspaces
Revises: 0043_wallet_txn_seq
Create Date: 2026-07-19

Trang "Mời thành viên" có nút ⚙️ (super-admin) cấu hình, theo TỪNG user, được add
email mới vào workspace nào: "Toàn bộ" (cờ này = True → mọi workspace, kể cả tạo mới
sau này) hoặc "Chỉ định" (tái dùng bảng workspace_assignments). Đích email mới chọn
NGẪU NHIÊN trong tập đã bật. Email cũ/gia hạn giữ workspace lịch sử — không đổi.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0044_user_invite_all_workspaces"
down_revision: Union[str, None] = "0043_wallet_txn_seq"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "invite_all_workspaces",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "invite_all_workspaces")
