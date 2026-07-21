"""Dựng lại chu kỳ phủ TOÀN BỘ thời gian còn hạn (kẹp mốc bắt đầu về hôm nay)

Revision ID: 0036_cycles_cover_full_term
Revises: 0035_rebuild_monthly_cycles
Create Date: 2026-07-13

Chốt user 2026-07-13: chu kỳ phải phủ toàn bộ thời gian member CÒN HẠN — không được
có khoảng còn-hạn nào không có kỳ. Mốc gia hạn (subscription_purchased_at) bị tính
lại = hạn − số_tháng×30 nên có thể rơi vào TƯƠNG LAI (chỉnh tay) → 0035 tile từ neo
để lại lỗ hổng (member còn hạn từ hôm nay nhưng kỳ chỉ bắt đầu ở neo tương lai).

Migration này tile lại từ mốc HIỆU LỰC = LEAST(neo, now()) → hạn cho member còn hoạt
động: neo ở quá khứ → giữ nguyên; neo ở tương lai → bắt đầu từ hôm nay. Member 'removed'
giữ nguyên. Khớp helper `_effective_cycle_start`.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0036_cycles_cover_full_term"
down_revision: Union[str, None] = "0035_rebuild_monthly_cycles"
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
            g.k + 1,
            1,
            a.start + (g.k * interval '30 days'),
            LEAST(a.start + ((g.k + 1) * interval '30 days'), m.subscription_end_at),
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
        CROSS JOIN LATERAL generate_series(
            0,
            CEIL(
                EXTRACT(EPOCH FROM (m.subscription_end_at - a.start)) / (30 * 86400)
            )::int - 1
        ) AS g(k)
        WHERE m.status <> 'removed'
          AND m.subscription_end_at IS NOT NULL
          AND a.start IS NOT NULL
          AND m.subscription_end_at > a.start
        """
    )


def downgrade() -> None:
    pass
