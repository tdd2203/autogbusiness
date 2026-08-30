"""hạn mức thao tác chỉnh được từ giao diện super-admin

Revision ID: 0059_rate_limit_settings
Revises: 0058_workspace_bank_fee_percent
Create Date: 2026-08-30

Trước đây mọi khoảng cách giữa hai lần bấm cùng một nút đều là hằng số trong code
(cooldown đồng bộ toàn bộ 5 tiếng), còn các nút nặng khác thì không có gì chặn.
Bảng singleton này cho super-admin nới/siết từng nút ngay trên giao diện.

  - enabled: tắt toàn bộ hạn mức thao tác khi nghi chặn nhầm.
  - exempt_super_admin: admin chính có bị áp hay không (mặc định không).
  - cooldowns: {action_key: giây}; thiếu key nào thì lấy mặc định trong code.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0059_rate_limit_settings"
down_revision: Union[str, None] = "0058_workspace_bank_fee_percent"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "rate_limit_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "exempt_super_admin",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("cooldowns", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("updated_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("id = 1", name="ck_rate_limit_settings_singleton"),
        sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], ondelete="SET NULL"),
    )


def downgrade() -> None:
    op.drop_table("rate_limit_settings")
