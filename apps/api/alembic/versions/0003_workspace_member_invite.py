"""workspace + member + invite + workspace_settings + queue_items.workspace_id

Revision ID: 0003_workspace_member_invite
Revises: 0002_token_version
Create Date: 2026-05-15
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_workspace_member_invite"
down_revision: Union[str, None] = "0002_token_version"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("chatgpt_id", sa.String(128), nullable=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("plan", sa.String(32), nullable=True),
        sa.Column("seat_total", sa.Integer(), nullable=True),
        sa.Column("seat_used", sa.Integer(), nullable=True),
        sa.Column("extension_api_key", sa.String(128), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by_id",
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
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("chatgpt_id", name="uq_workspaces_chatgpt_id"),
        sa.UniqueConstraint("extension_api_key", name="uq_workspaces_extension_api_key"),
    )

    op.create_table(
        "workspace_settings",
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "rate_limit_invite_ms", sa.Integer(), nullable=False, server_default="5000"
        ),
        sa.Column(
            "rate_limit_role_ms", sa.Integer(), nullable=False, server_default="3000"
        ),
        sa.Column(
            "rate_limit_remove_ms", sa.Integer(), nullable=False, server_default="5000"
        ),
        sa.Column(
            "dry_run_mode", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )

    op.create_table(
        "members",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("chatgpt_role", sa.String(32), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column(
            "invited_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("workspace_id", "email", name="uq_members_workspace_email"),
    )
    op.create_index("ix_members_workspace_id", "members", ["workspace_id"])
    op.create_index("ix_members_invited_by_user_id", "members", ["invited_by_user_id"])
    op.create_index("ix_members_status", "members", ["status"])

    op.create_table(
        "invites",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("role", sa.String(32), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column(
            "queue_item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("queue_items.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "invited_by_user_id",
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
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_invites_workspace_id", "invites", ["workspace_id"])
    op.create_index("ix_invites_status", "invites", ["status"])

    op.add_column(
        "queue_items",
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_queue_items_workspace_id", "queue_items", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_queue_items_workspace_id", table_name="queue_items")
    op.drop_column("queue_items", "workspace_id")

    op.drop_index("ix_invites_status", table_name="invites")
    op.drop_index("ix_invites_workspace_id", table_name="invites")
    op.drop_table("invites")

    op.drop_index("ix_members_status", table_name="members")
    op.drop_index("ix_members_invited_by_user_id", table_name="members")
    op.drop_index("ix_members_workspace_id", table_name="members")
    op.drop_table("members")

    op.drop_table("workspace_settings")
    op.drop_table("workspaces")
