"""đánh dấu ĐỔI EMAIL CHƯA XONG (lệnh gỡ email cũ hỏng)

Revision ID: 0057_member_email_change_stuck
Revises: 0056_sepay_webhook_events
Create Date: 2026-08-27

Đổi email đánh dấu email cũ `removed` NGAY trong DB rồi mới nhờ extension gỡ nó khỏi
ChatGPT. Lệnh gỡ hỏng thì không có đường quay lại: không thử lại, không cảnh báo, và
lần đồng bộ sau thấy email vẫn nằm trên ChatGPT nên HỒI SINH nó về `active`. Kết quả là
một ghế thành hai — cái cũ không ai trả tiền, cái mới bị thu tiền lần nữa vì hệ thống
không còn nhận ra nó là email kế thừa.

Ca thật 22/8/2026 (`hdh2102`): lampesdafret22 → minalqureshi221 → saghan876. Lệnh thu
hồi lúc 18:03 hỏng (FAILED_UI_CHANGED), minalqureshi221 ở lại active tới 21/09 bên cạnh
saghan876, và saghan876 bị thu thêm 330.000đ.

  - email_change_stuck_at: đặt trên bản ghi email CŨ khi lệnh gỡ của nó hỏng; xoá về
    NULL khi email đó thực sự rời ChatGPT. Có index vì dashboard lọc "còn ca nào chưa
    xong không".
  - email_change_stuck_to: email mới lẽ ra đã thay nó — để cảnh báo nói được thành câu.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0057_member_email_change_stuck"
down_revision: Union[str, None] = "0056_sepay_webhook_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "members", sa.Column("email_change_stuck_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "members", sa.Column("email_change_stuck_to", sa.String(length=255), nullable=True)
    )
    op.create_index(
        "ix_members_email_change_stuck_at", "members", ["email_change_stuck_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_members_email_change_stuck_at", table_name="members")
    op.drop_column("members", "email_change_stuck_to")
    op.drop_column("members", "email_change_stuck_at")
