"""danh sách người nhận thông báo theo tài khoản + link mời nhận thông báo

Revision ID: 0048_telegram_subscriptions
Revises: 0047_telegram_settings
Create Date: 2026-08-03

Trước đây thông báo của một tài khoản chỉ về ĐÚNG chat của chính chủ. Nay chủ tài
khoản tạo được **link mời** để gắn thông báo cho bất kỳ tài khoản Telegram nào
(nhân viên/đối tác), và **tuỳ chỉnh phạm vi**: nhận toàn bộ email của mình, hoặc chỉ
vài email được chọn.

- `telegram_link_tokens.purpose`: 'link_self' (kết nối chính chủ, dùng-một-lần) hoặc
  'invite_sub' (link mời người khác nhận thông báo, dùng nhiều lần tới khi hết hạn).
- `telegram_subscriptions`: mỗi hàng = 1 người nhận của 1 tài khoản + phạm vi nhận.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0048_telegram_subscriptions"
down_revision: Union[str, None] = "0047_telegram_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column(
        "telegram_link_tokens",
        sa.Column(
            "purpose", sa.String(length=16), nullable=False, server_default="link_self"
        ),
    )

    op.create_table(
        "telegram_subscriptions",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column(
            "user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("display_name", sa.String(length=128), nullable=True),
        sa.Column("scope", sa.String(length=16), nullable=False, server_default="all"),
        sa.Column(
            "member_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("user_id", "chat_id", name="uq_tele_sub_user_chat"),
    )
    op.create_index("ix_telegram_subscriptions_user_id", "telegram_subscriptions", ["user_id"])
    op.create_index("ix_telegram_subscriptions_chat_id", "telegram_subscriptions", ["chat_id"])


def downgrade() -> None:
    op.drop_table("telegram_subscriptions")
    op.drop_column("telegram_link_tokens", "purpose")
