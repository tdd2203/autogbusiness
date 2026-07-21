"""ngôn ngữ ChatGPT (chatgpt_locale) theo từng workspace

Revision ID: 0045_workspace_chatgpt_locale
Revises: 0044_user_invite_all_workspaces
Create Date: 2026-07-20

"Ngôn ngữ hệ thống" (locale giao diện ChatGPT admin mà extension dựa vào khi
sync/thao tác) TÁCH khỏi ngôn ngữ HIỂN THỊ dashboard (per-user). Trước đây
expected_locale bị suy ra từ ngôn ngữ hiển thị của mỗi user → sai. Nay là cấu
hình HỆ THỐNG theo TỪNG workspace, chỉ super-admin sửa (trang Cài đặt). Mặc định
'vi' cho mọi workspace hiện có.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0045_workspace_chatgpt_locale"
down_revision: Union[str, None] = "0044_user_invite_all_workspaces"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column(
            "chatgpt_locale",
            sa.String(length=8),
            nullable=False,
            server_default="vi",
        ),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "chatgpt_locale")
