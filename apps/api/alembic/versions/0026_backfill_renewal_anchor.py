"""backfill renewal anchor + recompute expiry = anchor + months*30 exact

Revision ID: 0026_backfill_renewal_anchor
Revises: 0025_member_sub_purchased_at
Create Date: 2026-07-06

Yêu cầu user 2026-07-06: **Ngày hết hạn = Ngày gia hạn + 30×tháng** (CHÍNH XÁC tới
giây, KHÔNG chốt cuối ngày). Mốc neo "Ngày gia hạn" (= ngày add đầu tiên) lưu ở
`subscription_purchased_at`.

Dữ liệu cũ (invite/sync trước fix) có `subscription_purchased_at IS NULL` và
`subscription_end_at` tính theo mô hình cũ (+months×30 − 1 rồi chốt 23:59:59 VN) →
LỆCH 1 ngày + sai giờ. Backfill cho các row còn gói tháng:
  - subscription_purchased_at = COALESCE(last_invited_at, created_at)  (= "ngày gia hạn")
  - subscription_end_at       = subscription_purchased_at + months × 30 ngày (exact)

CHỈ đụng row: subscription_purchased_at IS NULL AND subscription_months IS NOT NULL
AND subscription_end_at IS NOT NULL. KHÔNG đụng:
  - Row đã set qua modal (subscription_purchased_at có sẵn) — vốn đã đúng (+30 exact).
  - Row vô thời hạn (subscription_months NULL hoặc end_at NULL) — không có gì để tính.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0026_backfill_renewal_anchor"
down_revision: Union[str, None] = "0025_member_sub_purchased_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE members
        SET subscription_purchased_at = COALESCE(last_invited_at, created_at),
            subscription_end_at = COALESCE(last_invited_at, created_at)
                + (subscription_months * 30) * INTERVAL '1 day'
        WHERE subscription_purchased_at IS NULL
          AND subscription_months IS NOT NULL
          AND subscription_end_at IS NOT NULL
        """
    )


def downgrade() -> None:
    # Không thể khôi phục chính xác giá trị cũ (đã đè). Backfill là 1 chiều — no-op.
    pass
