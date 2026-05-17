"""add progress JSONB column to queue_items for real-time progress reporting

Revision ID: 0004_queue_progress
Revises: 0003_workspace_member_invite
Create Date: 2026-05-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004_queue_progress"
down_revision: Union[str, None] = "0003_workspace_member_invite"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "queue_items",
        sa.Column(
            "progress",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("queue_items", "progress")
