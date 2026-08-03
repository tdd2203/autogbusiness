"""link mời nhận thông báo GẮN SẴN phạm vi email + ghi lại link tạo ra người nhận

Revision ID: 0051_telegram_invite_scope
Revises: 0050_telegram_templates
Create Date: 2026-08-03

Trước đây link mời chỉ có một kiểu: ai bấm cũng nhận TOÀN BỘ email của chủ tài khoản,
rồi chủ tài khoản phải vào sửa phạm vi sau — mà chỉ sửa được KHI người ta đã bấm.
Nay chọn email NGAY LÚC TẠO LINK: gửi link nào thì người bấm link đó nhận đúng những
email đã chọn cho họ, không có khoảng thời gian "lỡ nhận hết".

- `telegram_link_tokens.label`: tên gợi nhớ để phân biệt nhiều link đang phát.
- `telegram_link_tokens.scope` / `.member_ids`: phạm vi gắn sẵn (NULL = 'all', giữ
  nguyên hành vi cho link đã phát trước bản này).
- `telegram_subscriptions.invite_token`: link GẦN NHẤT đã đưa người nhận này vào — để
  bấm LẠI đúng link đó thì giữ phạm vi chủ tài khoản đã tinh chỉnh, còn bấm link KHÁC
  thì CỘNG THÊM phạm vi của link mới (bấm link chỉ thêm email, không bao giờ bớt).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0051_telegram_invite_scope"
down_revision: Union[str, None] = "0050_telegram_templates"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("telegram_link_tokens", sa.Column("label", sa.String(length=64), nullable=True))
    op.add_column("telegram_link_tokens", sa.Column("scope", sa.String(length=16), nullable=True))
    op.add_column(
        "telegram_link_tokens",
        sa.Column("member_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "telegram_subscriptions", sa.Column("invite_token", sa.String(length=48), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("telegram_subscriptions", "invite_token")
    op.drop_column("telegram_link_tokens", "member_ids")
    op.drop_column("telegram_link_tokens", "scope")
    op.drop_column("telegram_link_tokens", "label")
