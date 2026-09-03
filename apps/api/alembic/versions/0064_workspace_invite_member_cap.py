"""trần thành viên mỗi workspace do super-admin đặt

Revision ID: 0064_workspace_invite_member_cap
Revises: 0062_member_invite_link
Create Date: 2026-09-03

Admin gõ số suất đã mua thật vào đây; chạm trần thì mọi lệnh mời vào workspace đó
dừng lại. Không suy ra được từ `seat_total` (số scrape từ ChatGPT, có thể cũ).

Nullable, không backfill: workspace để trống thì mời như trước.

Số 0063 đã bị một nhánh đang làm dở giữ chỗ (`0063_workspace_invite_block`) nhưng
nhánh đó chưa lên git lẫn production, nên bản này nối thẳng vào 0062 để chuỗi
migration trên nhánh chính không hở. Nhánh kia lên sau thì trỏ `down_revision` của
nó vào `0064_workspace_invite_member_cap`, đừng để cả hai cùng nối vào 0062 (hai
head, `alembic upgrade head` sẽ báo lỗi).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0064_workspace_invite_member_cap"
down_revision: Union[str, None] = "0062_member_invite_link"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces", sa.Column("invite_member_cap", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("workspaces", "invite_member_cap")
