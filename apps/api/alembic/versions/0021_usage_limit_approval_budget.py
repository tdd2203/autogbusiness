"""usage-limit approval workflow + per-assignment credit budget

Revision ID: 0021_usage_limit_approval_budget
Revises: 0020_member_usage_limit
Create Date: 2026-06-24

Hai phần cho tính năng "đặt giới hạn tín dụng có phê duyệt + ngân sách":

1. queue_items: cột duyệt lệnh
   - approval_status: NULL (không cần duyệt) | 'pending' (chờ admin) | 'approved' |
     'rejected'. Extension chỉ pick task PENDING có approval_status NULL hoặc
     'approved'.
   - approved_by_id / approved_at: super-admin nào duyệt, lúc nào.

2. workspace_assignments.credit_budget: ngân sách tín dụng/tháng admin cấp cho
   sub-admin trong workspace đó (mặc định 0 = chưa cấp).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0021_usage_limit_approval_budget"
down_revision: Union[str, None] = "0020_member_usage_limit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "queue_items",
        sa.Column("approval_status", sa.String(16), nullable=True),
    )
    op.create_index(
        "ix_queue_items_approval_status", "queue_items", ["approval_status"]
    )
    op.add_column(
        "queue_items",
        sa.Column("approved_by_id", sa.UUID(), nullable=True),
    )
    op.add_column(
        "queue_items",
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_queue_items_approved_by",
        "queue_items",
        "users",
        ["approved_by_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.add_column(
        "workspace_assignments",
        sa.Column(
            "credit_budget",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("workspace_assignments", "credit_budget")
    op.drop_constraint(
        "fk_queue_items_approved_by", "queue_items", type_="foreignkey"
    )
    op.drop_column("queue_items", "approved_at")
    op.drop_column("queue_items", "approved_by_id")
    op.drop_index("ix_queue_items_approval_status", table_name="queue_items")
    op.drop_column("queue_items", "approval_status")
