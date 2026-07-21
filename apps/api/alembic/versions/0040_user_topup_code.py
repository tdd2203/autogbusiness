"""mã nạp tiền cố định theo user (users.topup_code)

Revision ID: 0040_user_topup_code
Revises: 0039_wallet_beta_true
Create Date: 2026-07-14

user 2026-07-14: "mã QR nạp tiền cố định theo user, không đổi". Nội dung CK trên QR
nạp = `{NAP}{topup_code}`; webhook khớp mã này → cộng đúng số tiền nhận cho user.
Thêm cột `users.topup_code` (unique), backfill mã ngẫu nhiên 12-hex cho user hiện có.
"""

import secrets
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0040_user_topup_code"
down_revision: Union[str, None] = "0039_wallet_beta_true"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("topup_code", sa.String(length=24), nullable=True))

    # Backfill: mỗi user chưa có mã → 12-hex ngẫu nhiên (nằm trong dải suffix mặc định
    # 3..30 của luồng NAP). Sinh trong Python để đảm bảo duy nhất trên tập hiện có.
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id FROM users WHERE topup_code IS NULL")).fetchall()
    used: set[str] = {
        r[0]
        for r in conn.execute(
            sa.text("SELECT topup_code FROM users WHERE topup_code IS NOT NULL")
        ).fetchall()
    }
    for (uid,) in rows:
        code = secrets.token_hex(6)
        while code in used:
            code = secrets.token_hex(6)
        used.add(code)
        conn.execute(
            sa.text("UPDATE users SET topup_code = :c WHERE id = :id"),
            {"c": code, "id": uid},
        )

    op.create_unique_constraint("uq_users_topup_code", "users", ["topup_code"])
    op.create_index("ix_users_topup_code", "users", ["topup_code"])


def downgrade() -> None:
    op.drop_index("ix_users_topup_code", table_name="users")
    op.drop_constraint("uq_users_topup_code", "users", type_="unique")
    op.drop_column("users", "topup_code")
