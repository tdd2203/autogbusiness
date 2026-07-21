"""wallet_beta mặc định TRUE cho tài khoản mới (cố định — user 2026-07-14)

Revision ID: 0039_wallet_beta_true
Revises: 0038_replay_cycles
Create Date: 2026-07-14

Từ nay tạo tài khoản mặc định MỞ VÍ (wallet_beta=true). Chỉ đổi DEFAULT cấp cột để
row mới bật ví; KHÔNG cập nhật user hiện có (giữ nguyên trạng thái ai đã set).
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0039_wallet_beta_true"
down_revision: Union[str, None] = "0038_replay_cycles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ALTER COLUMN wallet_beta SET DEFAULT true")


def downgrade() -> None:
    op.execute("ALTER TABLE users ALTER COLUMN wallet_beta SET DEFAULT false")
