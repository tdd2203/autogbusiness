"""add sync_member_cooldown_until to users

Revision ID: 0017_user_sync_member_cooldown
Revises: 0016_backfill_member_remove_perm
Create Date: 2026-06-17

Mốc kết thúc cooldown chống-spam của "đồng bộ 1 tài khoản lẻ" (SYNC_MEMBER).
Khi user gọi sync-member >2 lần trong 60s, endpoint set cột = now+5 phút và từ
chối mọi request cho tới khi qua mốc. NULL = không bị cooldown.

Cần cột riêng (không suy từ QueueItem.created_at) vì lần vi phạm thứ 3 bị TỪ
CHỐI nên KHÔNG tạo QueueItem → không có timestamp để suy mốc cooldown 5 phút.

  - sync_member_cooldown_until: timestamptz nullable.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0017_user_sync_member_cooldown"
down_revision: Union[str, None] = "0016_backfill_member_remove_perm"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "sync_member_cooldown_until",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "sync_member_cooldown_until")
