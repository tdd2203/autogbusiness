"""backfill subscription_months=1 + end_at=created_at+30days cho member NULL

Revision ID: 0010_backfill_member_subscription
Revises: 0009_member_subscription
Create Date: 2026-05-19

User request: "hiện tại các email hiện tại sẽ có ngày hạn dùng + 30 ngày kể từ
ngày thêm" — mọi member đang tồn tại (chưa có subscription) sẽ default 1
tháng = 30 ngày kể từ `created_at`. Áp dụng cho TẤT CẢ status (active /
pending / removed) để dashboard tracking nhất quán.

Idempotent: chỉ update rows có `subscription_months IS NULL`.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010_backfill_sub"
down_revision: Union[str, None] = "0009_member_subscription"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Backfill: subscription_months=1, subscription_end_at = created_at + 30 days.
    # Cross-dialect SQL: INTERVAL works trên Postgres; SQLite cần datetime() func.
    # Detect dialect để dùng đúng cú pháp.
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == "postgresql":
        op.execute(
            sa.text(
                """
                UPDATE members
                SET subscription_months = 1,
                    subscription_end_at = created_at + INTERVAL '30 days'
                WHERE subscription_months IS NULL
                """
            )
        )
    elif dialect == "sqlite":
        op.execute(
            sa.text(
                """
                UPDATE members
                SET subscription_months = 1,
                    subscription_end_at = datetime(created_at, '+30 days')
                WHERE subscription_months IS NULL
                """
            )
        )
    else:
        # MySQL / others: fall back to generic ANSI (may need adjustment)
        op.execute(
            sa.text(
                """
                UPDATE members
                SET subscription_months = 1,
                    subscription_end_at = DATE_ADD(created_at, INTERVAL 30 DAY)
                WHERE subscription_months IS NULL
                """
            )
        )


def downgrade() -> None:
    # Reset chỉ những row có months=1 + end_at = created_at+30 (tốt nhất an toàn:
    # set lại NULL, mất 1 phần data nhưng không khác cấu trúc).
    op.execute(
        sa.text(
            """
            UPDATE members
            SET subscription_months = NULL,
                subscription_end_at = NULL
            WHERE subscription_months = 1
            """
        )
    )
