"""ngưng mời tạm thời khi ChatGPT lỗi công tắc mời ngoài miền

Revision ID: 0063_workspace_invite_block
Revises: 0067_workspace_cycle_billing
Create Date: 2026-09-03

ChatGPT thỉnh thoảng hỏng ngay cú bấm công tắc "Cho phép lời mời từ miền bên ngoài":
in băng-rôn đỏ "Something went wrong...", tải lại trang thì công tắc VẪN TẮT, và nó
gửi thông báo về tài khoản admin của workspace. Bấm lại lúc đó chỉ khiến bị khoá thêm.

Hai cột này cho hệ thống tự lùi 1 tiếng thay vì để đại lý bấm mời lại liên tục.
Nullable, không backfill: workspace đang chạy bình thường thì để trống.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0063_workspace_invite_block"
down_revision: Union[str, None] = "0067_workspace_cycle_billing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column("invite_blocked_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("workspaces", sa.Column("invite_block_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("workspaces", "invite_block_reason")
    op.drop_column("workspaces", "invite_blocked_until")
