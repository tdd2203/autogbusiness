"""workspace_assignments — gán quyền sở hữu workspace cho sub-admin

Revision ID: 0011_workspace_assignments
Revises: 0010_backfill_sub
Create Date: 2026-06-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011_workspace_assignments"
down_revision: Union[str, None] = "0010_backfill_sub"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workspace_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "assigned_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "workspace_id", "user_id", name="uq_workspace_assignments_ws_user"
        ),
    )
    op.create_index(
        "ix_workspace_assignments_workspace_id",
        "workspace_assignments",
        ["workspace_id"],
    )
    op.create_index(
        "ix_workspace_assignments_user_id",
        "workspace_assignments",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workspace_assignments_user_id", table_name="workspace_assignments"
    )
    op.drop_index(
        "ix_workspace_assignments_workspace_id", table_name="workspace_assignments"
    )
    op.drop_table("workspace_assignments")
