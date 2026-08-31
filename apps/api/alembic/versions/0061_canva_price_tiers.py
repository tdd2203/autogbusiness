"""bảng giá bậc thang cho nhánh Canva

Revision ID: 0061_canva_price_tiers
Revises: 0060_platform_canva
Create Date: 2026-09-01

ChatGPT bán theo ĐƠN GIÁ/THÁNG nhân số tháng (tuyến tính). Canva bán theo BẬC — mua
càng dài càng rẻ (user 2026-09-01: 1 tháng 15.000, 3 tháng 40.000, 6 tháng 70.000,
12 tháng 100.000). Không nhét được vào `invite_fee_vnd` (một con số/tháng) nên phải
có bảng riêng.

  - payment_settings.canva_price_tiers: bảng mặc định toàn hệ thống.
  - users.canva_price_tiers: bảng riêng của đại lý; NULL = dùng mặc định.

Cả hai NULL-able và không backfill: chưa đặt thì rơi về bảng mặc định trong code
(`services/canva_price.DEFAULT_TIERS`), nên nhánh GPT không bị đụng gì.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0061_canva_price_tiers"
down_revision: Union[str, None] = "0060_platform_canva"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "payment_settings",
        sa.Column("canva_price_tiers", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("canva_price_tiers", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "canva_price_tiers")
    op.drop_column("payment_settings", "canva_price_tiers")
