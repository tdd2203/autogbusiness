"""Re-baseline Báo cáo tài chính (user 2026-07-14)

Revision ID: 0041_finance_rebaseline
Revises: 0040_user_topup_code
Create Date: 2026-07-14

Hai thay đổi cho báo cáo tài chính chính xác (bỏ lợi nhuận âm giả):

1. workspaces.finance_start_at — MỐC bắt đầu tính CHI của workspace. CHI chỉ cộng
   hoá đơn Stripe có ngày >= mốc này (hoá đơn hệ thống cũ / thanh toán ngoài trước
   mốc bị loại). Backfill = period_start của hoá đơn có chu kỳ MỚI NHẤT (= đầu chu
   kỳ hiện tại). GPT1 → 2026-07-11, CHATGPT PRO → 2026-06-25 (khớp dữ liệu thật).
   Workspace mới: null → billing sync lần đầu tự set = period_start chu kỳ hiện tại
   (report fallback created_at nếu vẫn null).

2. users.is_test — cờ tài khoản test. Báo cáo LOẠI mọi member thuộc user is_test
   (khỏi THU + bảng đại lý). Bật cho tài khoản seed wallet_tester.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0041_finance_rebaseline"
down_revision: Union[str, None] = "0040_user_topup_code"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. workspaces.finance_start_at + backfill = đầu chu kỳ hiện tại (period_start
    #    của hoá đơn có period_start MỚI NHẤT — chỉ hoá đơn chu kỳ hiện tại có field
    #    này, hoá đơn ngoài hệ thống cũ thì không). COALESCE tránh lỗi khi
    #    billing_invoices NULL.
    op.add_column(
        "workspaces",
        sa.Column("finance_start_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        """
        UPDATE workspaces w
        SET finance_start_at = sub.max_ps
        FROM (
            SELECT w2.id,
                   MAX((inv->>'period_start')::timestamptz) AS max_ps
            FROM workspaces w2,
                 jsonb_array_elements(COALESCE(w2.billing_invoices, '[]'::jsonb)) AS inv
            WHERE NULLIF(inv->>'period_start', '') IS NOT NULL
            GROUP BY w2.id
        ) sub
        WHERE w.id = sub.id
          AND w.finance_start_at IS NULL
        """
    )

    # 2. users.is_test + bật cho tài khoản test seed.
    op.add_column(
        "users",
        sa.Column(
            "is_test",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.execute(
        """
        UPDATE users
        SET is_test = true
        WHERE username = 'wallet_tester'
           OR email = 'wallet_tester@wallet-test.local'
        """
    )


def downgrade() -> None:
    op.drop_column("users", "is_test")
    op.drop_column("workspaces", "finance_start_at")
