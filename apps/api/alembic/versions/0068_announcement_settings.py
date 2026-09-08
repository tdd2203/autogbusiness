"""thông báo hệ thống ép đọc: cấu hình đợt + lượt đã đọc theo tài khoản

Revision ID: 0068_announcement_settings
Revises: 0063_workspace_invite_block
Create Date: 2026-09-08

⚠️ `Revises` là 0063 chứ KHÔNG phải 0067: số hiệu file không phải thứ tự chạy. Chuỗi
thật hiện là ...0066 → 0067 → 0063, nên head lúc viết bản này là 0063. Nối vào 0067
cho "đúng số" là đẻ ra hai head và `alembic upgrade head` dừng giữa deploy — xem
`tests/test_alembic_single_head.py`.

Popup hướng dẫn đầu ngày vốn đóng lúc nào cũng được, nên lúc vừa đổi cách tính
tiền/hạn thì thông báo không tới được người cần đọc: đại lý bấm tắt theo phản xạ
rồi hôm sau hỏi lại đúng thứ vừa thông báo.

Hai bảng ở đây mở một ĐỢT ép đọc có hạn:

  announcement_settings  singleton id=1 — bài nào, chạy từ ngày nào, mấy ngày, giữ
                         popup mấy giây. `enabled` mặc định FALSE: deploy xong
                         không tự nhiên ép ai đọc gì, phải có người vào bật đợt.
  announcement_views     ai đã đọc xong ngày nào, theo TÀI KHOẢN chứ không theo
                         trình duyệt — xoá cache hay đổi máy vẫn tính là đã đọc.
                         `campaign` = "<guide_id>:<start_day>" nên đổi bài hoặc
                         dời ngày là sang đợt khác, không phải dọn bảng.

Migration này chỉ thêm bảng, không đổi hành vi nào đang chạy: dòng cấu hình được
mồi sẵn (bài "ngày chốt", 5 ngày, giữ 15 giây) nhưng `enabled=false`, nên tới khi có
người vào bật thì popup vẫn y như cũ.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0068_announcement_settings"
down_revision: Union[str, None] = "0063_workspace_invite_block"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "announcement_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("guide_id", sa.String(length=64), nullable=True),
        sa.Column("start_day", sa.Date(), nullable=True),
        sa.Column("days", sa.Integer(), nullable=False, server_default=sa.text("5")),
        sa.Column(
            "lock_seconds", sa.Integer(), nullable=False, server_default=sa.text("15")
        ),
        sa.Column("updated_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("id = 1", name="ck_announcement_settings_singleton"),
        sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], ondelete="SET NULL"),
    )

    op.create_table(
        "announcement_views",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("campaign", sa.String(length=96), nullable=False),
        sa.Column("day", sa.String(length=10), nullable=False),
        sa.Column(
            "seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "user_id", "campaign", "day", name="uq_announcement_view_day"
        ),
    )
    op.create_index(
        "ix_announcement_views_campaign_day",
        "announcement_views",
        ["campaign", "day"],
    )

    # Mồi sẵn đợt nhưng ĐỂ TẮT: người bật chỉ phải gạt một công tắc chứ không phải
    # gõ lại từng ô. Bài "ngày chốt" là thứ vừa đổi cách tính nên cần thông báo
    # nhất; đổi sang bài khác ngay trên giao diện được, không phải sửa migration.
    op.execute(
        "INSERT INTO announcement_settings (id, enabled, guide_id, days, lock_seconds) "
        "VALUES (1, false, 'cycle-billing', 5, 15)"
    )


def downgrade() -> None:
    op.drop_index("ix_announcement_views_campaign_day", table_name="announcement_views")
    op.drop_table("announcement_views")
    op.drop_table("announcement_settings")
