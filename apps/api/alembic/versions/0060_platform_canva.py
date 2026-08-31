"""tách nhánh Canva: cột platform cho workspace và hoá đơn

Revision ID: 0060_platform_canva
Revises: 0059_rate_limit_settings
Create Date: 2026-09-01

Canva là nhánh thứ hai bên cạnh ChatGPT: cùng ví, cùng kỳ hạn, cùng nhật ký, nhưng
người dùng phải nhìn thấy hai thế giới tách biệt và tiền phải phân biệt được.

  - workspaces.platform: 'gpt' (mặc định, mọi dữ liệu cũ) | 'canva' (team Canva,
    50 suất có sẵn, KHÔNG mua thêm được).
  - payment_orders.platform: hoá đơn Canva mang mã kết thúc bằng 'cv' và được tách
    riêng khi đối soát.

KHÔNG thêm cột cho `queue_items`: task nào cũng có `workspace_id`, nhánh suy ra từ
đó. Sao chép thêm một bản vào 27 chỗ tạo task là mở đường cho lệch dữ liệu — sót một
chỗ thì task Canva mang nhãn 'gpt' và extension mở nhầm chatgpt.com.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0060_platform_canva"
down_revision: Union[str, None] = "0059_rate_limit_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("workspaces", "payment_orders")


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(
            table,
            sa.Column(
                "platform",
                sa.String(length=16),
                nullable=False,
                server_default="gpt",
            ),
        )
        op.create_index(f"ix_{table}_platform", table, ["platform"])


def downgrade() -> None:
    for table in _TABLES:
        op.drop_index(f"ix_{table}_platform", table_name=table)
        op.drop_column(table, "platform")
