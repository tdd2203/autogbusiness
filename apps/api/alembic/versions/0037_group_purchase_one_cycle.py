"""Gộp về 1 kỳ/member (1 lần mua = 1 chu kỳ, months = số tháng), thôi tách lẻ

Revision ID: 0037_group_cycle
Revises: 0036_cycles_cover_full_term
Create Date: 2026-07-13

Chốt user 2026-07-13: mua nhiều tháng = 1 CHU KỲ gộp (hiển thị "N tháng"), KHÔNG tách
thành N kỳ 1-tháng. 0035/0036 tách lẻ theo tháng → dựng lại thành ĐÚNG 1 kỳ phủ
[min(neo, now) → hạn], months = round((hạn − start)/30, tối thiểu 1). Dữ liệu cũ không
biết ranh giới từng lần mua nên gộp toàn bộ term còn hạn vào 1 kỳ là biểu diễn sạch
nhất. Member 'removed' giữ nguyên. Khớp helper `_effective_cycle_start` + `_months_between`.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0037_group_cycle"
down_revision: Union[str, None] = "0036_cycles_cover_full_term"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM member_subscription_cycles c
        USING members m
        WHERE c.member_id = m.id AND m.status <> 'removed'
        """
    )
    op.execute(
        """
        INSERT INTO member_subscription_cycles
            (id, member_id, cycle_number, months, start_at, end_at,
             payment_status, paid_at, created_at)
        SELECT
            gen_random_uuid(),
            m.id,
            1,
            GREATEST(
                1,
                ROUND(
                    EXTRACT(EPOCH FROM (m.subscription_end_at - a.start)) / (30 * 86400)
                )::int
            ),
            a.start,
            m.subscription_end_at,
            'paid',
            now(),
            now()
        FROM members m
        CROSS JOIN LATERAL (
            SELECT LEAST(
                COALESCE(m.subscription_purchased_at, m.last_invited_at, m.created_at),
                now()
            ) AS start
        ) a
        WHERE m.status <> 'removed'
          AND m.subscription_end_at IS NOT NULL
          AND a.start IS NOT NULL
          AND m.subscription_end_at > a.start
        """
    )


def downgrade() -> None:
    pass
