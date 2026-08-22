"""add sync_missing_at to members

Revision ID: 0054_member_sync_missing_at
Revises: 0053_telegram_template_renew_url
Create Date: 2026-08-22

Mốc lần ĐỒNG BỘ gần nhất KHÔNG thấy email ở cả tab "Người dùng" lẫn tab "Lời mời"
(extension trả `found_in='none'`). Trước đây kết quả 'none' chỉ được hiển thị rồi
bỏ, nên member DB ghi `active` mà thực tế đã rời workspace vẫn bị chặn 409 khi bấm
"Mời lại" ("Thành viên đang hoạt động, không cần mời lại") — user báo 2026-08-22.

  - sync_missing_at: timestamptz nullable. Set khi sync trả 'none'; XOÁ về NULL khi
    sync thấy lại ('active'/'pending') hoặc khi mời lại. NULL = lần sync gần nhất có
    thấy, hoặc chưa sync bao giờ.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0054_member_sync_missing_at"
down_revision: Union[str, None] = "0053_telegram_template_renew_url"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("sync_missing_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("members", "sync_missing_at")
