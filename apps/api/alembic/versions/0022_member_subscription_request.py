"""add subscription change-approval fields to members

Revision ID: 0022_member_subscription_request
Revises: 0021_usage_limit_approval_budget
Create Date: 2026-06-25

Đổi hạn dùng (subscription) của member PHẢI được admin duyệt:
  - subscription_request_status: 'none' | 'requested' (default 'none').
  - pending_subscription_months / pending_subscription_end_at: giá trị đề xuất chờ duyệt.
  - subscription_requested_at / subscription_requested_by_id: ai gửi, khi nào.

Super-admin tự đổi = áp dụng ngay (không qua các cột này). Sub-admin gọi PATCH
subscription → set 'requested' + pending_* → super-admin duyệt áp pending vào
subscription_months/subscription_end_at.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0022_member_subscription_request"
down_revision: Union[str, None] = "0021_usage_limit_approval_budget"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column(
            "subscription_request_status",
            sa.String(length=16),
            nullable=False,
            server_default="none",
        ),
    )
    op.add_column(
        "members",
        sa.Column("pending_subscription_months", sa.Integer(), nullable=True),
    )
    op.add_column(
        "members",
        sa.Column(
            "pending_subscription_end_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "members",
        sa.Column(
            "subscription_requested_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "members",
        sa.Column(
            "subscription_requested_by_id",
            sa.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_members_subscription_requested_by",
        "members",
        "users",
        ["subscription_requested_by_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_members_subscription_request_status",
        "members",
        ["subscription_request_status"],
    )


def downgrade() -> None:
    op.drop_index("ix_members_subscription_request_status", table_name="members")
    op.drop_constraint(
        "fk_members_subscription_requested_by", "members", type_="foreignkey"
    )
    op.drop_column("members", "subscription_requested_by_id")
    op.drop_column("members", "subscription_requested_at")
    op.drop_column("members", "pending_subscription_end_at")
    op.drop_column("members", "pending_subscription_months")
    op.drop_column("members", "subscription_request_status")
