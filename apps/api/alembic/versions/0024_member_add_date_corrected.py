"""add add_date_corrected_at to members

Revision ID: 0024_member_add_date_corrected
Revises: 0023_normalize_notime_expiry
Create Date: 2026-07-06

Cột khoá quyền sửa "ngày thêm" (created_at) 1 LẦN DUY NHẤT của super-admin:
  - add_date_corrected_at: NULL = chưa dùng (còn sửa được); có giá trị = đã sửa, KHOÁ.

Super-admin sửa created_at cho khớp joined_at (ngày join thật ChatGPT) qua endpoint
PATCH .../members/{id}/add-date, rồi tính lại subscription_end_at. Xem correct_add_date.py.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0024_member_add_date_corrected"
down_revision: Union[str, None] = "0023_normalize_notime_expiry"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("add_date_corrected_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("members", "add_date_corrected_at")
