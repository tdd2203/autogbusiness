"""add usage_limit_credits to members

Revision ID: 0020_member_usage_limit
Revises: 0019_member_payment_request
Create Date: 2026-06-23

Giới hạn tín dụng/tháng cho từng member (trang ChatGPT
/admin/billing/manage_member_usage_limit — "Ghi đè mỗi người dùng"):
  - usage_limit_credits: số tín dụng/tháng (NULL = chưa đặt override; 0 = chặn).

Extension đặt giá trị qua action SET_USAGE_LIMIT; backend sync cột này khi task
COMPLETED (queue/completion.py).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0020_member_usage_limit"
down_revision: Union[str, None] = "0019_member_payment_request"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("usage_limit_credits", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("members", "usage_limit_credits")
