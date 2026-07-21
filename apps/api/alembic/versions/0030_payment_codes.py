"""payment_codes — cấu trúc mã thanh toán đa luồng trên SePay (NAP nạp / ORDER đơn)

Revision ID: 0030_payment_codes
Revises: 0029_member_removed_at
Create Date: 2026-07-12

Feature 003 (bổ sung): SePay hỗ trợ nhiều luồng mã thanh toán, mỗi luồng 1 tiền tố
riêng (Nạp tiền = NAP, Thanh toán đơn hàng = ORDER) + ràng buộc độ dài hậu tố.
Lưu dạng JSONB list trên payment_settings. Backfill từ code_prefix cũ (NAP topup).
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0030_payment_codes"
down_revision: Union[str, None] = "0029_member_removed_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_DEFAULT_CODES = [
    {"key": "topup", "label": "Nạp tiền", "prefix": "NAP", "suffix_min": 3, "suffix_max": 30, "suffix_type": "alphanumeric", "enabled": True},
    {"key": "order", "label": "Thanh toán đơn hàng", "prefix": "ORDER", "suffix_min": 6, "suffix_max": 30, "suffix_type": "alphanumeric", "enabled": False},
]


def upgrade() -> None:
    op.add_column(
        "payment_settings",
        sa.Column("payment_codes", postgresql.JSONB(), nullable=True),
    )
    # Backfill: dùng code_prefix hiện tại cho luồng topup, giữ order mặc định (tắt).
    conn = op.get_bind()
    row = conn.execute(sa.text("SELECT code_prefix FROM payment_settings WHERE id = 1")).fetchone()
    codes = [dict(c) for c in _DEFAULT_CODES]
    if row and row[0]:
        codes[0]["prefix"] = row[0]
    conn.execute(
        sa.text("UPDATE payment_settings SET payment_codes = CAST(:codes AS jsonb) WHERE id = 1"),
        {"codes": json.dumps(codes, ensure_ascii=False)},
    )


def downgrade() -> None:
    op.drop_column("payment_settings", "payment_codes")
