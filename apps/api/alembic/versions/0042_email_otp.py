"""bảng email_otps — đăng ký chờ xác thực OTP qua email

Revision ID: 0042_email_otp
Revises: 0041_finance_rebaseline
Create Date: 2026-07-14

Feature tự đăng ký bằng OTP: lưu đăng ký ĐANG CHỜ (email, username, password_hash,
code_hash) ở bảng riêng; chỉ khi OTP đúng mới INSERT vào users. Xem models.EmailOtp.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision: str = "0042_email_otp"
down_revision: Union[str, None] = "0041_finance_rebaseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "email_otps",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_email_otps_email", "email_otps", ["email"])


def downgrade() -> None:
    op.drop_index("ix_email_otps_email", table_name="email_otps")
    op.drop_table("email_otps")
