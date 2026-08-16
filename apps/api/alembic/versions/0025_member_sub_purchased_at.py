"""add subscription_purchased_at to members

Revision ID: 0025_member_sub_purchased_at
Revises: 0024_member_add_date_corrected
Create Date: 2026-07-06

ĐỔI TÊN 2026-08-16: id cũ ("0025_member_subscription_purchased_at") dài 37 ký tự,
trong khi alembic tạo bảng `alembic_version` với cột `version_num VARCHAR(32)`.
DB đang chạy không sao (bảng của nó dựng từ đời alembic cũ, rộng 128) nhưng DB
MỚI TINH thì `alembic upgrade head` chết ngay ở bước này — mà DDL trong postgres
nằm trong transaction nên rollback sạch, để lại DB rỗng và API sập lúc seed
("relation users does not exist"). Giữ mọi id revision ≤32 ký tự; test
tests/test_alembic_revisions.py canh không cho tái phạm.

"Ngày mua" (mốc neo tính hạn) do admin đặt trong modal Đổi hạn dùng:
  - subscription_purchased_at: NULL = chưa đặt (modal mặc định về COALESCE(
    last_invited_at, created_at) = "ngày thêm" log). Có giá trị = ngày mua đã set;
    subscription_end_at = subscription_purchased_at + subscription_months × 30 ngày
    (CHÍNH XÁC tới giây, không chốt cuối ngày). Xem routers/members/subscription.py.

Nullable, không backfill: chỉ modal ghi field này; đọc thì fallback last_invited_at
/created_at nên legacy rows không cần giá trị.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0025_member_sub_purchased_at"
down_revision: Union[str, None] = "0024_member_add_date_corrected"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column(
            "subscription_purchased_at", sa.DateTime(timezone=True), nullable=True
        ),
    )


def downgrade() -> None:
    op.drop_column("members", "subscription_purchased_at")
