"""member_subscription_cycles — lịch sử chu kỳ gia hạn + thanh toán theo kỳ

Revision ID: 0027_member_subscription_cycle
Revises: 0026_backfill_renewal_anchor
Create Date: 2026-07-08

Yêu cầu user 2026-07-08: cho phép người dùng TỰ gia hạn (không cần duyệt); mỗi lần
gia hạn = 1 CHU KỲ mới với trạng thái thanh toán RIÊNG. Gia hạn luôn set chu kỳ mới
= 'unpaid' (chưa thanh toán), kể cả trước đó đã 'paid'. Admin xác nhận thanh toán
theo TỪNG chu kỳ.

Backfill: mỗi member đang có hạn (subscription_end_at IS NOT NULL) → tạo chu kỳ số 1
lấy nguyên trạng thái thanh toán hiện tại của member (giữ liền mạch dữ liệu cũ).
Dùng gen_random_uuid() (Postgres core ≥ 13).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0027_member_subscription_cycle"
down_revision: Union[str, None] = "0026_backfill_renewal_anchor"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "member_subscription_cycles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "member_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("members.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("cycle_number", sa.Integer(), nullable=False),
        sa.Column("months", sa.Integer(), nullable=True),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "payment_status",
            sa.String(16),
            nullable=False,
            server_default="unpaid",
        ),
        sa.Column("payment_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "payment_requested_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "paid_marked_by_id",
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
        sa.UniqueConstraint(
            "member_id", "cycle_number", name="uq_member_cycle_number"
        ),
    )
    op.create_index(
        "ix_member_subscription_cycles_member_id",
        "member_subscription_cycles",
        ["member_id"],
    )
    op.create_index(
        "ix_member_subscription_cycles_payment_status",
        "member_subscription_cycles",
        ["payment_status"],
    )

    # Backfill chu kỳ 1 cho member đang có hạn — giữ nguyên trạng thái thanh toán.
    op.execute(
        """
        INSERT INTO member_subscription_cycles
            (id, member_id, cycle_number, months, start_at, end_at,
             payment_status, payment_requested_at, payment_requested_by_id,
             paid_at, paid_marked_by_id, created_at)
        SELECT
            gen_random_uuid(),
            m.id,
            1,
            m.subscription_months,
            COALESCE(m.subscription_purchased_at, m.last_invited_at, m.created_at),
            m.subscription_end_at,
            m.payment_status,
            m.payment_requested_at,
            m.payment_requested_by_id,
            m.paid_at,
            m.paid_marked_by_id,
            m.created_at
        FROM members m
        WHERE m.subscription_end_at IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_member_subscription_cycles_payment_status",
        table_name="member_subscription_cycles",
    )
    op.drop_index(
        "ix_member_subscription_cycles_member_id",
        table_name="member_subscription_cycles",
    )
    op.drop_table("member_subscription_cycles")
