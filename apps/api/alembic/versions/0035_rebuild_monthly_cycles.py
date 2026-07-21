"""Dựng lại chu kỳ 1-tháng đã thanh toán từ [neo → hạn] cho dữ liệu hiện có

Revision ID: 0035_rebuild_monthly_cycles
Revises: 0034_cycle_paid_normalize
Create Date: 2026-07-13

Mô hình mới (user 2026-07-13): 1 tháng = 1 chu kỳ, tất cả ĐÃ THANH TOÁN. Dữ liệu cũ
có cửa sổ chu kỳ LỆCH so với hạn thực (vd đổi hạn dùng trước đây không đụng cycles →
kỳ kẹt ở cửa sổ cũ trong khi member đã được kéo hạn xa hơn). Migration này DỰNG LẠI
cycles cho member CÒN HOẠT ĐỘNG (status<>'removed') theo đúng [neo → hạn] hiện tại:
  - Có hạn (end > neo) → xoá cycles cũ, tạo ceil((end-neo)/30) kỳ 1-tháng 'paid'.
  - Vô thời hạn (end NULL) → xoá hết cycles (không có kỳ tính tiền).
Member 'removed' GIỮ NGUYÊN cycles (phục vụ lịch sử). neo = subscription_purchased_at
?? last_invited_at ?? created_at.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0035_rebuild_monthly_cycles"
down_revision: Union[str, None] = "0034_cycle_paid_normalize"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) Xoá cycles cũ của mọi member CÒN HOẠT ĐỘNG (sẽ dựng lại / để trống nếu vô hạn).
    op.execute(
        """
        DELETE FROM member_subscription_cycles c
        USING members m
        WHERE c.member_id = m.id AND m.status <> 'removed'
        """
    )
    # 2) Dựng lại kỳ 1-tháng 'paid' cho member CÒN HOẠT ĐỘNG & CÓ hạn (end > neo).
    op.execute(
        """
        INSERT INTO member_subscription_cycles
            (id, member_id, cycle_number, months, start_at, end_at,
             payment_status, paid_at, created_at)
        SELECT
            gen_random_uuid(),
            m.id,
            g.k + 1,
            1,
            a.neo + (g.k * interval '30 days'),
            LEAST(a.neo + ((g.k + 1) * interval '30 days'), m.subscription_end_at),
            'paid',
            now(),
            now()
        FROM members m
        CROSS JOIN LATERAL (
            SELECT COALESCE(
                m.subscription_purchased_at, m.last_invited_at, m.created_at
            ) AS neo
        ) a
        CROSS JOIN LATERAL generate_series(
            0,
            CEIL(
                EXTRACT(EPOCH FROM (m.subscription_end_at - a.neo)) / (30 * 86400)
            )::int - 1
        ) AS g(k)
        WHERE m.status <> 'removed'
          AND m.subscription_end_at IS NOT NULL
          AND a.neo IS NOT NULL
          AND m.subscription_end_at > a.neo
        """
    )


def downgrade() -> None:
    # Không khôi phục được cửa sổ cũ đã bị dựng lại — no-op.
    pass
