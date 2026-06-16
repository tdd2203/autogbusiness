"""add payment tracking to members

Revision ID: 0013_member_payment
Revises: 0012_workspace_verified_domain
Create Date: 2026-06-14

Theo dõi (Dashboard-only) việc tài khoản phụ đã trả tiền cho admin cho từng email
đã add hay chưa. KHÔNG liên quan billing workspace.

  - payment_status: 'unpaid' | 'paid' (default 'unpaid', index để filter nhanh)
  - paid_at: thời điểm duyệt thanh toán
  - paid_marked_by_id: user đã duyệt (SET NULL nếu user bị xoá)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013_member_payment"
down_revision: Union[str, None] = "0012_workspace_verified_domain"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column(
            "payment_status",
            sa.String(length=16),
            nullable=False,
            server_default="unpaid",
        ),
    )
    op.add_column(
        "members",
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "members",
        sa.Column("paid_marked_by_id", sa.UUID(), nullable=True),
    )
    op.create_index(
        "ix_members_payment_status", "members", ["payment_status"]
    )
    op.create_foreign_key(
        "fk_members_paid_marked_by",
        "members",
        "users",
        ["paid_marked_by_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_members_paid_marked_by", "members", type_="foreignkey")
    op.drop_index("ix_members_payment_status", table_name="members")
    op.drop_column("members", "paid_marked_by_id")
    op.drop_column("members", "paid_at")
    op.drop_column("members", "payment_status")
