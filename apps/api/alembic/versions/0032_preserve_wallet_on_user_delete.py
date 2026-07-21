"""Giữ lịch sử nạp/thanh toán/rút khi xoá user (ON DELETE CASCADE → SET NULL)

Revision ID: 0032_preserve_wallet_history
Revises: 0031_sepay_auth_method
Create Date: 2026-07-12

Nguyên tắc user (2026-07-12): tài khoản phụ chỉ VÔ HIỆU HOÁ, không xoá; nhưng DÙ
CÓ xoá thì phải GIỮ TOÀN BỘ lịch sử nạp tiền + thao tác. Trước đây wallets/
topup_orders/withdrawal_requests dùng ON DELETE CASCADE → xoá user sẽ mất sạch
lịch sử tài chính. Đổi sang SET NULL (cột user_id cho phép NULL) → user bị xoá thì
bản ghi thành 'mồ côi' nhưng CÒN NGUYÊN. (members + wallet_transactions đã SET NULL
sẵn nên thao tác thành viên + sổ cái vốn đã được giữ.)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0032_preserve_wallet_history"
down_revision: Union[str, None] = "0031_sepay_auth_method"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("wallets", "topup_orders", "withdrawal_requests")
_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    for tbl in _TABLES:
        # Cho phép NULL để SET NULL hoạt động (user bị xoá → user_id=NULL, record còn).
        op.alter_column(tbl, "user_id", existing_type=_UUID, nullable=True)
        op.drop_constraint(f"{tbl}_user_id_fkey", tbl, type_="foreignkey")
        op.create_foreign_key(
            f"{tbl}_user_id_fkey", tbl, "users", ["user_id"], ["id"], ondelete="SET NULL"
        )


def downgrade() -> None:
    for tbl in _TABLES:
        op.drop_constraint(f"{tbl}_user_id_fkey", tbl, type_="foreignkey")
        op.create_foreign_key(
            f"{tbl}_user_id_fkey", tbl, "users", ["user_id"], ["id"], ondelete="CASCADE"
        )
        op.alter_column(tbl, "user_id", existing_type=_UUID, nullable=False)
