"""normalize no-time subscription_end_at to 23:59 VN

Revision ID: 0023_normalize_notime_expiry
Revises: 0022_member_subscription_request
Create Date: 2026-06-29

Email add từ trước mà `subscription_end_at` KHÔNG có giờ (đúng 00:00:00 UTC = ngày
trơn, chưa từng set giờ cụ thể) → chuẩn hoá về **23:59:59 giờ VN (UTC+7)** của
chính ngày đó, cho khớp quy tắc "không giờ → 23:59" và để scheduler tự-xoá có mốc
dễ đoán. Email đã có giờ (scrape/invite timestamp) GIỮ NGUYÊN — theo yêu cầu user.

Idempotent: chạy lại không đụng gì (giá trị 23:59 không còn là 00:00:00).
Data-only, không đổi schema.
"""

from datetime import timedelta, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0023_normalize_notime_expiry"
down_revision: Union[str, None] = "0022_member_subscription_request"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_VN_TZ = timezone(timedelta(hours=7))


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, subscription_end_at FROM members "
            "WHERE subscription_end_at IS NOT NULL"
        )
    ).fetchall()
    for row in rows:
        end = row.subscription_end_at
        end_utc = (
            end.astimezone(timezone.utc)
            if end.tzinfo is not None
            else end.replace(tzinfo=timezone.utc)
        )
        # "Không giờ" = đúng 00:00:00.000000 UTC (ngày trơn). Email có giờ → bỏ qua.
        if (end_utc.hour, end_utc.minute, end_utc.second, end_utc.microsecond) != (
            0,
            0,
            0,
            0,
        ):
            continue
        eod_vn = end_utc.astimezone(_VN_TZ).replace(
            hour=23, minute=59, second=59, microsecond=0
        )
        conn.execute(
            sa.text("UPDATE members SET subscription_end_at = :e WHERE id = :id"),
            {"e": eod_vn.astimezone(timezone.utc), "id": row.id},
        )


def downgrade() -> None:
    # Data normalization một chiều — không khôi phục giờ gốc (không lưu lại).
    pass
