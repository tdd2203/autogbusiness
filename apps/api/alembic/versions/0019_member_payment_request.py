"""add payment-request (step 1) tracking to members

Revision ID: 0019_member_payment_request
Revises: 0018_user_command_ban
Create Date: 2026-06-20

Duyệt thanh toán 2 bước cho email đã add (Dashboard-only):
  - Bước 1: sub-admin GỬI yêu cầu duyệt → payment_status 'unpaid' -> 'requested'
  - Bước 2: super-admin XÁC NHẬN đã thanh toán → 'requested' -> 'paid'

Cột payment_status cũ (String(16)) đủ chứa 'requested' nên không đổi. Thêm 2 cột
ghi bước 1:
  - payment_requested_at: thời điểm gửi yêu cầu
  - payment_requested_by_id: user đã gửi yêu cầu (SET NULL nếu user bị xoá)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0019_member_payment_request"
down_revision: Union[str, None] = "0018_user_command_ban"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("payment_requested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "members",
        sa.Column("payment_requested_by_id", sa.UUID(), nullable=True),
    )
    op.create_foreign_key(
        "fk_members_payment_requested_by",
        "members",
        "users",
        ["payment_requested_by_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_members_payment_requested_by", "members", type_="foreignkey"
    )
    op.drop_column("members", "payment_requested_by_id")
    op.drop_column("members", "payment_requested_at")
