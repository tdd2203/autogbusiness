"""sổ nhận tiền thô từ SePay (đối soát ngân hàng)

Revision ID: 0056_sepay_webhook_events
Revises: 0055_member_removed_reason
Create Date: 2026-08-26

Trước đây webhook SePay xử lý xong là quên: chỉ `sepay_idem` giữ lại mỗi cái key
(không số tiền, không nội dung CK) và `wallet_transactions` giữ tiền ĐÃ VÀO VÍ. Khoản
khách chuyển sai nội dung hoặc lệch số tiền bị handler từ chối rồi bốc hơi — không tra
được "hôm nay ngân hàng nhận bao nhiêu, vào ví bao nhiêu, lệch ở đâu" (user 2026-08-26).

Bảng này ghi MỌI giao dịch SePay báo về, kể cả dòng bị từ chối. Khoá trùng `key` dùng
CHUNG idempotency key với `sepay_idem` nên sao kê kéo từ userapi gộp đúng vào dòng
webhook tương ứng; giao dịch chỉ có trong sao kê ⇒ webhook chưa từng tới (bank_only).

Dữ liệu TRƯỚC migration này không dựng lại được từ DB (log container đã mất) — phải
kéo sao kê từ API SePay (`POST /api/v1/wallet/admin/sepay/sync`).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0056_sepay_webhook_events"
down_revision: Union[str, None] = "0055_member_removed_reason"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sepay_webhook_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("source", sa.String(length=12), nullable=False, server_default="webhook"),
        sa.Column("provider_txn_id", sa.String(length=64), nullable=True),
        sa.Column("amount", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("transfer_type", sa.String(length=8), nullable=True),
        sa.Column("account_number", sa.String(length=40), nullable=True),
        sa.Column("bank", sa.String(length=64), nullable=True),
        sa.Column("payload_format", sa.String(length=24), nullable=True),
        sa.Column("flow", sa.String(length=16), nullable=True),
        sa.Column("code", sa.String(length=64), nullable=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("result", sa.String(length=16), nullable=False, server_default="unmatched"),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("bank_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("raw", postgresql.JSONB(), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("key", name="uq_sepay_events_key"),
    )
    op.create_index("ix_sepay_events_received_at", "sepay_webhook_events", ["received_at"])
    op.create_index("ix_sepay_events_bank_time", "sepay_webhook_events", ["bank_time"])
    op.create_index("ix_sepay_events_user_id", "sepay_webhook_events", ["user_id"])
    op.create_index("ix_sepay_events_result", "sepay_webhook_events", ["result"])
    op.create_index("ix_sepay_events_code", "sepay_webhook_events", ["code"])
    op.create_index("ix_sepay_events_provider_txn_id", "sepay_webhook_events", ["provider_txn_id"])


def downgrade() -> None:
    op.drop_table("sepay_webhook_events")
