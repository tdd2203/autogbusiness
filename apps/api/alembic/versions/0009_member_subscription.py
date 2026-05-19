"""add subscription_months + subscription_end_at to members

Revision ID: 0009_member_subscription
Revises: 0008_ui_labels
Create Date: 2026-05-19
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_member_subscription"
down_revision: Union[str, None] = "0008_ui_labels"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # subscription_months: số tháng subscription mà admin invite (default 1).
    # NULL = không giới hạn (legacy rows / admin chọn vô thời hạn).
    op.add_column(
        "members",
        sa.Column("subscription_months", sa.Integer(), nullable=True),
    )
    # subscription_end_at: derived = created_at + subscription_months × 30 days.
    # Store explicitly để query/index nhanh + cho phép admin extend bằng cách
    # update riêng end_at mà không đổi months.
    op.add_column(
        "members",
        sa.Column(
            "subscription_end_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_members_subscription_end_at",
        "members",
        ["subscription_end_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_members_subscription_end_at", table_name="members")
    op.drop_column("members", "subscription_end_at")
    op.drop_column("members", "subscription_months")
