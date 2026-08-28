"""phí ngân hàng theo % cho cả workspace

Revision ID: 0058_workspace_bank_fee_percent
Revises: 0057_member_email_change_stuck
Create Date: 2026-08-27

Phí ngân hàng là tỉ lệ % cố định trên số tiền chuyển (ca thật GPT1: 475.960 /
43.269.050 và 578.045 / 52.549.578 đều = 1,1%), nhưng trước đây phải gõ SỐ TIỀN
cho từng hoá đơn. Sót một hoá đơn là "tổng thực trả" và báo cáo CHI hụt đúng phần
phí đó mà không có gì báo.

  - bank_fee_percent: % phí (vd 1.1), nhập một lần, áp cho mọi hoá đơn của
    workspace. NULL = chưa đặt → vẫn dùng phí nhập tay từng dòng như cũ.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0058_workspace_bank_fee_percent"
down_revision: Union[str, None] = "0057_member_email_change_stuck"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("bank_fee_percent", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("workspaces", "bank_fee_percent")
