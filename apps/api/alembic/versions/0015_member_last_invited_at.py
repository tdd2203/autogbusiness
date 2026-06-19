"""add last_invited_at to members

Revision ID: 0015_member_last_invited_at
Revises: 0014_member_license_type
Create Date: 2026-06-17

Mốc thời gian lần CUỐI member được invite/re-invite qua dashboard. Cần riêng vì
`created_at` bất biến từ lần invite ĐẦU → member re-invite (created_at cũ) không
được vùng-bảo-vệ 10 phút của reconcile (bulk-upsert) che → bị mark 'removed' oan
khi ChatGPT index pending invite chậm. Reconcile cutoff nay dùng
COALESCE(last_invited_at, created_at).

  - last_invited_at: timestamptz nullable (NULL = chưa từng invite qua dashboard,
    fallback về created_at).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015_member_last_invited_at"
down_revision: Union[str, None] = "0014_member_license_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("last_invited_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("members", "last_invited_at")
