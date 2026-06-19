"""replace sync_member_cooldown_until with command_ban_until

Revision ID: 0018_user_command_ban
Revises: 0017_user_sync_member_cooldown
Create Date: 2026-06-17

Đổi mô hình chống-spam: bỏ cooldown 2 task/60s (sync_member_cooldown_until) →
lệnh-cấm theo "cùng (loại lệnh, email) lặp lại liên tiếp >3 lần → cấm 10 phút"
(command_ban_until). Khi bị cấm: token_version bump (đá session) + login chặn.

  - DROP users.sync_member_cooldown_until
  - ADD  users.command_ban_until : timestamptz nullable
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0018_user_command_ban"
down_revision: Union[str, None] = "0017_user_sync_member_cooldown"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("command_ban_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.drop_column("users", "sync_member_cooldown_until")


def downgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "sync_member_cooldown_until",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.drop_column("users", "command_ban_until")
