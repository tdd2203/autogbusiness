"""nhắc gia hạn qua Telegram: liên kết tài khoản + chỉ định người nhận + log gửi

Revision ID: 0046_telegram_renewal_reminder
Revises: 0045_workspace_chatgpt_locale
Create Date: 2026-08-03

Feature 004-telegram-renewal-reminder. Ba nhóm thay đổi:

1. `users.telegram_*`  — kênh nhắc RIÊNG của mỗi đại lý (có sau khi bấm deep-link
   t.me/<bot>?start=<token>). `telegram_notify_enabled` cho phép tạm ngưng mà không
   mất liên kết.
2. `members.notify_telegram_*` — CHỈ ĐỊNH người nhận riêng cho từng email (khách cuối).
   `target` giữ nguyên văn admin nhập ('@username' hoặc ID số); `chat_id` là giá trị
   đã resolve — nhập ID thì có ngay, nhập @username thì điền khi người đó /start bot.
3. Ba bảng mới: `telegram_contacts` (sổ username→chat_id học từ /start),
   `telegram_link_tokens` (mã liên kết dùng-1-lần), `telegram_notifications`
   (nhật ký + khoá chống trùng theo `dedupe_key`).

An toàn với dữ liệu cũ: mọi cột thêm đều nullable hoặc có server_default.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0046_telegram_renewal_reminder"
down_revision: Union[str, None] = "0045_workspace_chatgpt_locale"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    # 1) Liên kết Telegram theo user (đại lý).
    op.add_column("users", sa.Column("telegram_chat_id", sa.BigInteger(), nullable=True))
    op.add_column("users", sa.Column("telegram_username", sa.String(length=64), nullable=True))
    op.add_column(
        "users", sa.Column("telegram_linked_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users",
        sa.Column(
            "telegram_notify_enabled",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )
    op.create_index("ix_users_telegram_chat_id", "users", ["telegram_chat_id"])

    # 2) Người nhận nhắc RIÊNG cho từng email.
    op.add_column(
        "members", sa.Column("notify_telegram_target", sa.String(length=64), nullable=True)
    )
    op.add_column(
        "members", sa.Column("notify_telegram_chat_id", sa.BigInteger(), nullable=True)
    )
    op.create_index(
        "ix_members_notify_telegram_chat_id", "members", ["notify_telegram_chat_id"]
    )

    # 3) Sổ địa chỉ học từ /start — nền tảng cho việc chỉ định bằng @username.
    op.create_table(
        "telegram_contacts",
        sa.Column("chat_id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("display_name", sa.String(length=128), nullable=True),
        sa.Column(
            "started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("blocked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_telegram_contacts_username", "telegram_contacts", ["username"])

    # 4) Mã liên kết dùng-một-lần cho deep-link.
    op.create_table(
        "telegram_link_tokens",
        sa.Column("token", sa.String(length=48), primary_key=True),
        sa.Column(
            "user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_telegram_link_tokens_user_id", "telegram_link_tokens", ["user_id"])

    # 5) Nhật ký gửi + khoá chống trùng.
    op.create_table(
        "telegram_notifications",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("event_type", sa.String(length=48), nullable=False),
        sa.Column("dedupe_key", sa.String(length=200), nullable=False, unique=True),
        sa.Column(
            "member_id", _UUID, sa.ForeignKey("members.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column(
            "user_id", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("recipient_kind", sa.String(length=16), nullable=False),
        sa.Column("days_bucket", sa.Integer(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="pending"
        ),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("telegram_message_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_telegram_notifications_event_type", "telegram_notifications", ["event_type"])
    op.create_index("ix_telegram_notifications_member_id", "telegram_notifications", ["member_id"])
    op.create_index("ix_telegram_notifications_chat_id", "telegram_notifications", ["chat_id"])
    op.create_index("ix_telegram_notifications_status", "telegram_notifications", ["status"])
    op.create_index("ix_telegram_notifications_created_at", "telegram_notifications", ["created_at"])


def downgrade() -> None:
    op.drop_table("telegram_notifications")
    op.drop_table("telegram_link_tokens")
    op.drop_index("ix_telegram_contacts_username", table_name="telegram_contacts")
    op.drop_table("telegram_contacts")
    op.drop_index("ix_members_notify_telegram_chat_id", table_name="members")
    op.drop_column("members", "notify_telegram_chat_id")
    op.drop_column("members", "notify_telegram_target")
    op.drop_index("ix_users_telegram_chat_id", table_name="users")
    op.drop_column("users", "telegram_notify_enabled")
    op.drop_column("users", "telegram_linked_at")
    op.drop_column("users", "telegram_username")
    op.drop_column("users", "telegram_chat_id")
