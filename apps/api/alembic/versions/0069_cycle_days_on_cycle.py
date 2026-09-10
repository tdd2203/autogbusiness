"""ghi độ dài chu kỳ hoá đơn vào từng dòng kỳ, thôi suy ngược từ hạn

Revision ID: 0069_cycle_days_on_cycle
Revises: 0068_announcement_settings
Create Date: 2026-09-10

Công thức tiền của phần lẻ (EXPIRY_RULES §3.6.5) là

    đơn_giá_tháng × số_nửa_ngày / (2 × SỐ_NGÀY_CHU_KỲ)

Ba số đầu đều nằm sẵn trên dòng kỳ. Số cuối thì không: báo cáo suy ngược nó bằng
cách lùi `months` tháng dương lịch từ `end_at`, dựa trên giả định `end_at` là một
MỐC CHỐT. Giả định đó đúng cho tới khi ai đó rút ngắn hạn — lúc ấy `end_at` thành
một ngày bất kỳ, mẫu số nhảy 28/29/30/31, và tiền của một kỳ ĐÃ BÁN XONG tự đổi
theo. Đo trên dữ liệu giả lập: có ca cắt bớt 7 tiếng mà số tiền kỳ đó tăng 10.000đ.

Cột này cất thẳng con số ấy lúc BÁN (hệ thống vốn đã tính ra nó trong báo giá, chỉ
là không lưu), nên về sau không còn chỗ nào phải đoán.

CỐ Ý KHÔNG ĐIỀN NGƯỢC cho dòng cũ. NULL nghĩa là "chưa lưu, cứ suy như cũ", nên mọi
con số doanh thu đã báo giữ nguyên từng đồng — điền ngược là tự tay làm đổi sổ đã
chốt. Dòng cũ chỉ được đóng băng giá trị vào đây đúng lúc sắp bị cắt kỳ, khi `end_at`
hãy còn nguyên vẹn và phép suy ngược còn đúng (xem `members/_shared._trim_cycles_to_end`).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0069_cycle_days_on_cycle"
down_revision: Union[str, None] = "0068_announcement_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "member_subscription_cycles",
        sa.Column("cycle_days", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("member_subscription_cycles", "cycle_days")
