"""add removed_reason to members

Revision ID: 0055_member_removed_reason
Revises: 0054_member_sync_missing_at
Create Date: 2026-08-24

Tab "Đã xoá" ở trang Email đã thêm cần trả lời VÌ SAO email rời team (hết hạn, admin
xoá tay, thu hồi lời mời, đổi email…). Trước đây thông tin này chỉ nằm rải rác trong
audit log — nhiều đường xoá lại ghi log ở cấp WORKSPACE nên không tra ngược được về
từng email. Cột này ghi lý do NGAY tại thời điểm xoá.

  - removed_reason: varchar(32) nullable. Đặt cùng lúc với removed_at; xoá về NULL khi
    member hồi sinh. NULL = email bị xoá TRƯỚC migration này → UI hiện "Không rõ".
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0055_member_removed_reason"
down_revision: Union[str, None] = "0054_member_sync_missing_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("removed_reason", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("members", "removed_reason")
