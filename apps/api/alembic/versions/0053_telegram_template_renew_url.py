"""trang gia hạn riêng của đại lý — link gửi cho người KHÔNG có tài khoản web

Revision ID: 0053_telegram_template_renew_url
Revises: 0052_telegram_template_scope
Create Date: 2026-08-22

`{link}` trong tin nhắc gia hạn trước đây LUÔN là `FRONTEND_ORIGIN/renewals` — trang
dashboard cần đăng nhập. Mẫu gốc chỉ dùng biến đó cho đại lý và nhóm admin nên ban đầu
không sao, nhưng `{link}` là biến hợp lệ trong MỌI mẫu tự soạn: đại lý mở "mẫu chung"
(ô soạn mở sẵn mẫu gốc của chính họ, có sẵn dòng "Gia hạn tại: {link}") rồi bấm Lưu là
khách cuối bắt đầu nhận link đăng nhập mà họ không có tài khoản.

Nay `{link}` được quyết định theo NGƯỜI NHẬN (`renewal_reminder.link_text`): ai đăng
nhập được thì thấy dashboard, còn lại thấy cột này — trang gia hạn riêng của đại lý —
hoặc câu "liên hệ người bán để gia hạn" khi chưa đặt.

Đặt theo TỪNG PHẠM VI mẫu (all / chat / member) chứ không phải một link/tài khoản: đại
lý bán nhiều kênh thì khách của mỗi kênh cần về đúng trang của kênh đó, và phạm vi cụ
thể hơn thắng đúng như với thân tin.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0053_telegram_template_renew_url"
down_revision: Union[str, None] = "0052_telegram_template_scope"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "telegram_templates",
        sa.Column("renew_url", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("telegram_templates", "renew_url")
