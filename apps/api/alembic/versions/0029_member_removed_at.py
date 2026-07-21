"""add removed_at to members (30-day retention anchor)

Revision ID: 0029_member_removed_at
Revises: 0028_wallet
Create Date: 2026-07-12

Mốc đếm retention cho member đã 'removed'. Job nền hard-delete record + lịch sử
audit riêng của email khi removed_at <= now - 30 ngày (xem main.py
_purge_old_removed_members_once). Set ở mọi đường chuyển status='removed'; clear
về NULL khi mời lại (invite.py).

Backfill: các row đang 'removed' (không biết chính xác lúc bị xoá) được gán
removed_at = now() → nhận mốc 30 ngày MỚI kể từ lần deploy này. Có chủ đích: KHÔNG
xoá ồ ạt lịch sử cũ ngay tick đầu; retention chỉ áp dụng đi tới.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0029_member_removed_at"
down_revision: Union[str, None] = "0028_wallet"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_members_removed_at", "members", ["removed_at"], unique=False
    )
    # Backfill: mốc retention mới cho row 'removed' hiện có (tránh xoá ngay).
    op.execute(
        "UPDATE members SET removed_at = now() "
        "WHERE status = 'removed' AND removed_at IS NULL"
    )


def downgrade() -> None:
    op.drop_index("ix_members_removed_at", table_name="members")
    op.drop_column("members", "removed_at")
