"""add license_type to members

Revision ID: 0014_member_license_type
Revises: 0013_member_payment
Create Date: 2026-06-15

Loại suất cấp phép trên ChatGPT admin (cột "Loại suất cấp phép"): ChatGPT | Codex.
Extension scrape giá trị này từ /admin/members; dashboard đổi qua dropdown (super-admin)
→ QueueItem CHANGE_LICENSE_TYPE → extension thao tác menu '...' → 'Thay đổi loại giấy phép'.

  - license_type: 'ChatGPT' | 'Codex' (nullable — NULL nếu chưa scrape được)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014_member_license_type"
down_revision: Union[str, None] = "0013_member_payment"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("license_type", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("members", "license_type")
