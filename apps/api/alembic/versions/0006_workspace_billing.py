"""add billing_status, renewal_date, last_billing_synced_at to workspaces

Revision ID: 0006_workspace_billing
Revises: 0005_workspace_connected_user
Create Date: 2026-05-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006_workspace_billing"
down_revision: Union[str, None] = "0005_workspace_connected_user"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces", sa.Column("billing_status", sa.String(16), nullable=True)
    )
    op.add_column(
        "workspaces",
        sa.Column("renewal_date", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "workspaces",
        sa.Column("last_billing_synced_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "last_billing_synced_at")
    op.drop_column("workspaces", "renewal_date")
    op.drop_column("workspaces", "billing_status")
