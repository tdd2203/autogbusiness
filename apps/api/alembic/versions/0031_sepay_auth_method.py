"""sepay_auth_method — chọn phương thức xác thực webhook (none/apikey/hmac)

Revision ID: 0031_sepay_auth_method
Revises: 0030_payment_codes
Create Date: 2026-07-12

Feature 003 (bổ sung): cho super-admin chọn cách SePay xác thực webhook —
Không xác thực / API Key (header Apikey) / HMAC-SHA256 (chữ ký X-Sepay-Signature).
Bỏ OAuth 2.0. Secret để ở env (SEPAY_APIKEY / SEPAY_WEBHOOK_SECRET).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0031_sepay_auth_method"
down_revision: Union[str, None] = "0030_payment_codes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "payment_settings",
        sa.Column("sepay_auth_method", sa.String(16), nullable=False, server_default="apikey"),
    )


def downgrade() -> None:
    op.drop_column("payment_settings", "sepay_auth_method")
