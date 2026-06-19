"""backfill MEMBER_REMOVE permission cho mọi sub-admin hiện có

Revision ID: 0016_backfill_member_remove_perm
Revises: 0015_member_last_invited_at
Create Date: 2026-06-17

Trước đây MEMBER_REMOVE không nằm trong quyền mặc định của tài khoản phụ nên
admin phụ tạo trước đây không thấy nút thu hồi/xoá thành viên. Theo yêu cầu "mọi
admin phụ đều có chức năng thu hồi/xoá", migration này cấp MEMBER_REMOVE cho mọi
user không phải super-admin mà chưa có quyền này (idempotent). Super-admin vốn đã
có toàn bộ quyền nên bỏ qua.

Backend vẫn áp `_visibility_filter`: sub-admin chỉ xoá được member do chính họ
mời — quyền này KHÔNG mở rộng phạm vi member họ thấy.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0016_backfill_member_remove_perm"
down_revision: Union[str, None] = "0015_member_last_invited_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE users
        SET permissions = permissions || '["MEMBER_REMOVE"]'::jsonb
        WHERE is_super_admin = false
          AND NOT (permissions @> '["MEMBER_REMOVE"]'::jsonb)
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE users
        SET permissions = permissions - 'MEMBER_REMOVE'
        WHERE is_super_admin = false
        """
    )
