"""câu thông báo chạm trần soạn được + ngày mở lại của từng workspace

Revision ID: 0065_invite_cap_message
Revises: 0064_workspace_invite_member_cap
Create Date: 2026-09-04

Trần thành viên (0064) mới chỉ chặn được; đại lý dán thừa email thì chỉ thấy một
câu cứng trong code. Admin muốn tự soạn lời lẽ theo từng đợt, kèm ngày sẽ mở lại.

- `invite_settings` (singleton id=1): câu thông báo DÙNG CHUNG, có chỗ thay động
  {ten} / {conlai} / {ngay}. NULL = chưa ai sửa, dùng câu mặc định trong code.
- `workspaces.invite_cap_reopen_at`: ngày mở lại RIÊNG từng workspace, chỉ để ghép
  vào {ngay}. Không có job nào tự gỡ trần khi tới ngày.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision: str = "0065_invite_cap_message"
down_revision: Union[str, None] = "0064_workspace_invite_member_cap"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces", sa.Column("invite_cap_reopen_at", sa.Date(), nullable=True)
    )
    op.create_table(
        "invite_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("cap_message", sa.Text(), nullable=True),
        sa.Column("updated_by_id", PG_UUID(as_uuid=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_invite_settings_singleton"),
        sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("invite_settings")
    op.drop_column("workspaces", "invite_cap_reopen_at")
