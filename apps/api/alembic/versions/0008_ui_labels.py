"""add ui_labels + ui_label_history tables

Revision ID: 0008_ui_labels
Revises: 0007_workspace_billing_invoices
Create Date: 2026-05-18
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0008_ui_labels"
down_revision: Union[str, None] = "0007_workspace_billing_invoices"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ui_labels",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("locale", sa.String(8), nullable=False, index=True),
        sa.Column("page", sa.String(64), nullable=False, index=True),
        sa.Column("control_key", sa.String(64), nullable=False),
        sa.Column("label_text", sa.Text, nullable=True),
        sa.Column("aria_label", sa.Text, nullable=True),
        sa.Column("notes", JSONB, nullable=True),
        sa.Column("stale", sa.Boolean, nullable=False, server_default=sa.false(), index=True),
        sa.Column("stale_reason", sa.Text, nullable=True),
        sa.Column("stale_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column(
            "updated_by_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "locale", "page", "control_key", name="uq_ui_labels_locale_page_key"
        ),
    )
    op.create_table(
        "ui_label_history",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "label_id",
            UUID(as_uuid=True),
            sa.ForeignKey("ui_labels.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("label_text", sa.Text, nullable=True),
        sa.Column("aria_label", sa.Text, nullable=True),
        sa.Column("notes", JSONB, nullable=True),
        sa.Column(
            "created_by_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("ui_label_history")
    op.drop_table("ui_labels")
