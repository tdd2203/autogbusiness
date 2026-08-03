"""link thông báo cho TỪNG email (nút "Thông báo" sau khi mời thành công)

Revision ID: 0049_telegram_member_notify_link
Revises: 0048_telegram_subscriptions
Create Date: 2026-08-03

Đại lý mời xong 1 email → bấm "Thông báo" trên dòng email đó → ra link
`t.me/<bot>?start=<token>` gắn sẵn email. Khách bấm Start là thành người nhận nhắc gia
hạn của riêng email đó, khỏi phải gõ `/email <địa chỉ>` (và khỏi lo gõ sai chính tả).

`telegram_link_tokens.member_id` chỉ có giá trị khi `purpose='invite_member'`.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0049_telegram_member_notify_link"
down_revision: Union[str, None] = "0048_telegram_subscriptions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column("telegram_link_tokens", sa.Column("member_id", _UUID, nullable=True))
    op.create_foreign_key(
        "fk_telegram_link_tokens_member",
        "telegram_link_tokens",
        "members",
        ["member_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_telegram_link_tokens_member", "telegram_link_tokens", type_="foreignkey"
    )
    op.drop_column("telegram_link_tokens", "member_id")
