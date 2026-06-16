"""add verified_domain to workspaces

Revision ID: 0012_workspace_verified_domain
Revises: 0011_workspace_assignments
Create Date: 2026-06-14

Tên miền đã xác minh của workspace, extension quét 1 lần từ /admin/identity rồi
lưu. Dùng để quyết định có cần bật toggle "Cho phép lời mời ngoài tên miền" khi
invite (chỉ bật khi có email ngoài domain này).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_workspace_verified_domain"
down_revision: Union[str, None] = "0011_workspace_assignments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column("verified_domain", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "verified_domain")
