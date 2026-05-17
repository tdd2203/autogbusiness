"""add chatgpt_user_email/name + last_extension_seen_at to workspaces

Revision ID: 0005_workspace_connected_user
Revises: 0004_queue_progress
Create Date: 2026-05-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_workspace_connected_user"
down_revision: Union[str, None] = "0004_queue_progress"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces", sa.Column("chatgpt_user_email", sa.String(255), nullable=True)
    )
    op.add_column(
        "workspaces", sa.Column("chatgpt_user_name", sa.String(255), nullable=True)
    )
    op.add_column(
        "workspaces",
        sa.Column("last_extension_seen_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "last_extension_seen_at")
    op.drop_column("workspaces", "chatgpt_user_name")
    op.drop_column("workspaces", "chatgpt_user_email")
