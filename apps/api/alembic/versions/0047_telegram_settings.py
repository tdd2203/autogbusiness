"""cấu hình bot Telegram nhập từ giao diện (token mã hoá + nhóm digest)

Revision ID: 0047_telegram_settings
Revises: 0046_telegram_renewal_reminder
Create Date: 2026-08-03

Trước đây token bot CHỈ đọc được từ .env → muốn đổi phải SSH vào VPS + restart
container. Bảng singleton này cho super-admin nhập token ngay trong Dashboard:
token được xác thực bằng getMe rồi MÃ HOÁ (Fernet, khoá suy từ JWT_SECRET) mới cất.
Secret webhook sinh tự động lúc lưu. .env vẫn được ưu tiên nếu có đặt.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0047_telegram_settings"
down_revision: Union[str, None] = "0046_telegram_renewal_reminder"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "telegram_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("bot_token_encrypted", sa.Text(), nullable=True),
        sa.Column("bot_username", sa.String(length=64), nullable=True),
        sa.Column("webhook_secret", sa.String(length=128), nullable=True),
        sa.Column("admin_chat_id", sa.String(length=255), nullable=True),
        sa.Column(
            "updated_by_id", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("id = 1", name="ck_telegram_settings_singleton"),
    )


def downgrade() -> None:
    op.drop_table("telegram_settings")
