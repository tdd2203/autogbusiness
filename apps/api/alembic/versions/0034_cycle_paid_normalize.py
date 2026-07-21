"""Chuẩn hoá chu kỳ + member về ĐÃ THANH TOÁN (mô hình mới, không còn chưa TT)

Revision ID: 0034_cycle_paid_normalize
Revises: 0033_invite_fee_and_orders
Create Date: 2026-07-13

Chốt user 2026-07-13: phí (ví/QR) LUÔN thu TRƯỚC khi mời/gia hạn/đổi hạn nên mọi
chu kỳ đã tồn tại đều coi như ĐÃ THANH TOÁN — bỏ hẳn trạng thái 'chưa thanh toán' /
'chờ duyệt' và bước xác nhận thủ công. Các kỳ 'unpaid'/'requested' còn sót là DI SẢN
của hành vi reset-khi-gia-hạn cũ, không phải nợ thật → gán 'paid' để không kẹt ở
trạng thái không còn cách xử lý (nút thủ công đã gỡ). Đồng bộ luôn payment_status
tổng hợp cấp member.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0034_cycle_paid_normalize"
down_revision: Union[str, None] = "0033_invite_fee_and_orders"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) Mọi chu kỳ chưa 'paid' → 'paid' (paid_at giữ nếu có, else now); dọn requested.
    op.execute(
        """
        UPDATE member_subscription_cycles
        SET payment_status = 'paid',
            paid_at = COALESCE(paid_at, now()),
            payment_requested_at = NULL,
            payment_requested_by_id = NULL
        WHERE payment_status <> 'paid'
        """
    )
    # 2) Member có chu kỳ nhưng chưa 'paid' → tổng hợp lại thành 'paid'; dọn requested.
    op.execute(
        """
        UPDATE members m
        SET payment_status = 'paid',
            paid_at = COALESCE(m.paid_at, now()),
            payment_requested_at = NULL,
            payment_requested_by_id = NULL
        WHERE m.payment_status <> 'paid'
          AND EXISTS (
              SELECT 1 FROM member_subscription_cycles c WHERE c.member_id = m.id
          )
        """
    )


def downgrade() -> None:
    # Không thể khôi phục trạng thái 'unpaid'/'requested' đã mất — no-op.
    pass
