"""mẫu nội dung thông báo riêng theo từng tài khoản (có mẫu gốc làm nền)

Revision ID: 0050_telegram_templates
Revises: 0049_telegram_member_notify_link
Create Date: 2026-08-03

Đại lý tự soạn lời nhắc gia hạn của mình (xưng tên shop, đổi cách trình bày…) thay vì
dùng chung một câu chữ hệ thống. Không đặt gì ⇒ dùng mẫu gốc; đặt rồi ⇒ áp cho mọi tin
về email của tài khoản đó, kể cả tin gửi khách cuối.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0050_telegram_templates"
down_revision: Union[str, None] = "0049_telegram_member_notify_link"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "telegram_templates",
        sa.Column(
            "user_id",
            _UUID,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("item_line", sa.Text(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("telegram_templates")
