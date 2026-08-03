"""mẫu nội dung thông báo theo PHẠM VI: tất cả / một người nhận Telegram / một email

Revision ID: 0052_telegram_template_scope
Revises: 0051_telegram_invite_scope
Create Date: 2026-08-03

Trước đây mỗi tài khoản chỉ có ĐÚNG MỘT mẫu (khoá chính là user_id) và nó áp cho mọi
tin. Thực tế đại lý cần nói khác nhau tuỳ nơi: tin gửi cho khách lẻ của một email cụ
thể khác tin gửi cho nhân viên trực, khác tin gửi cho chính mình.

Nay bảng thành nhiều dòng/tài khoản, mỗi dòng một phạm vi:
  - scope='all'    → mẫu chung, dùng khi không có mẫu cụ thể hơn (chính là mẫu cũ).
  - scope='chat'   → áp cho MỌI tin gửi tới một chat Telegram cụ thể.
  - scope='member' → áp cho tin nói về ĐÚNG một email.
Mẫu cụ thể hơn thắng: member > chat > all (xem renewal_reminder._pick_template).

Dòng cũ được giữ nguyên nội dung và chuyển thành scope='all' — không ai mất mẫu đã soạn.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0052_telegram_template_scope"
down_revision: Union[str, None] = "0051_telegram_invite_scope"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column(
        "telegram_templates",
        sa.Column("id", _UUID, nullable=False, server_default=sa.text("gen_random_uuid()")),
    )
    op.add_column(
        "telegram_templates",
        sa.Column("scope", sa.String(length=16), nullable=False, server_default="all"),
    )
    op.add_column("telegram_templates", sa.Column("chat_id", sa.BigInteger(), nullable=True))
    op.add_column(
        "telegram_templates",
        sa.Column(
            "member_id",
            _UUID,
            sa.ForeignKey("members.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )

    # user_id thôi làm khoá chính (giờ một tài khoản có nhiều mẫu) nhưng vẫn là khoá
    # ngoại + cột lọc chính, nên phải có index riêng thay cho index cũ của PK.
    op.drop_constraint("telegram_templates_pkey", "telegram_templates", type_="primary")
    op.create_primary_key("telegram_templates_pkey", "telegram_templates", ["id"])
    op.create_index("ix_telegram_templates_user_id", "telegram_templates", ["user_id"])

    # Mỗi phạm vi chỉ một mẫu — chặn ở DB vì hai request lưu song song thì kiểm tra ở
    # tầng API không đủ, và mẫu trùng thì lúc gửi không biết lấy cái nào.
    op.create_index(
        "ux_telegram_templates_all",
        "telegram_templates",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("scope = 'all'"),
    )
    op.create_index(
        "ux_telegram_templates_chat",
        "telegram_templates",
        ["user_id", "chat_id"],
        unique=True,
        postgresql_where=sa.text("scope = 'chat'"),
    )
    op.create_index(
        "ux_telegram_templates_member",
        "telegram_templates",
        ["user_id", "member_id"],
        unique=True,
        postgresql_where=sa.text("scope = 'member'"),
    )
    op.create_check_constraint(
        "ck_telegram_templates_scope_target",
        "telegram_templates",
        "(scope = 'all' AND chat_id IS NULL AND member_id IS NULL)"
        " OR (scope = 'chat' AND chat_id IS NOT NULL AND member_id IS NULL)"
        " OR (scope = 'member' AND member_id IS NOT NULL AND chat_id IS NULL)",
    )


def downgrade() -> None:
    # Chỉ mẫu chung sống sót được ở cấu trúc cũ (một dòng/tài khoản).
    op.execute("DELETE FROM telegram_templates WHERE scope <> 'all'")
    op.drop_constraint("ck_telegram_templates_scope_target", "telegram_templates", type_="check")
    op.drop_index("ux_telegram_templates_member", table_name="telegram_templates")
    op.drop_index("ux_telegram_templates_chat", table_name="telegram_templates")
    op.drop_index("ux_telegram_templates_all", table_name="telegram_templates")
    op.drop_index("ix_telegram_templates_user_id", table_name="telegram_templates")
    op.drop_constraint("telegram_templates_pkey", "telegram_templates", type_="primary")
    op.create_primary_key("telegram_templates_pkey", "telegram_templates", ["user_id"])
    op.drop_column("telegram_templates", "member_id")
    op.drop_column("telegram_templates", "chat_id")
    op.drop_column("telegram_templates", "scope")
    op.drop_column("telegram_templates", "id")
