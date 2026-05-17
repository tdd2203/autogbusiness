"""add billing_invoices JSONB to workspaces

Revision ID: 0007_workspace_billing_invoices
Revises: 0006_workspace_billing
Create Date: 2026-05-17
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0007_workspace_billing_invoices"
down_revision: Union[str, None] = "0006_workspace_billing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column("billing_invoices", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "billing_invoices")
