"""liên kết mời duy nhất của Canva, gắn theo từng email

Revision ID: 0062_member_invite_link
Revises: 0061_canva_price_tiers
Create Date: 2026-09-01

Canva sinh cho MỖI email một liên kết mời riêng ("Sao chép liên kết duy nhất"), chỉ
dùng được cho đúng email đó. Extension bắt lại chuỗi lúc mời rồi lưu vào đây; dashboard
hiện nút sao chép để đại lý gửi cho khách.

Nullable, không backfill: member nhánh ChatGPT không có khái niệm này.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0062_member_invite_link"
down_revision: Union[str, None] = "0061_canva_price_tiers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("members", sa.Column("invite_link", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("members", "invite_link")
