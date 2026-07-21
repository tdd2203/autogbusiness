"""Dựng lại chu kỳ từ NHẬT KÝ theo quy tắc: 1 lần mua = 1 kỳ, vô hạn = reset

Revision ID: 0038_replay_cycles
Revises: 0037_group_cycle
Create Date: 2026-07-13

Chốt user 2026-07-13 (phân tích lịch sử DB trước khi sửa):
  - 1 LẦN MUA N tháng = 1 CHU KỲ (months=N, N≥1); sub-admin luôn mua tối thiểu 1 tháng.
  - Chuyển sang VÔ THỜI HẠN = XOÁ các kỳ trước đó (không tính); mua lại → kỳ mới.
  - Kỳ 1 (khi chưa từng reset) NEO từ NGÀY THAM GIA (joined_at) — bất biến.
  - joined_at / subscription_purchased_at TUYỆT ĐỐI KHÔNG đụng (migration này chỉ ghi
    bảng member_subscription_cycles).

Cách làm: replay các sự kiện đổi hạn trong audit_logs theo thứ tự thời gian để tái
tạo đúng ranh giới từng lần mua. Kiểm tra hợp lệ (liền mạch + kỳ cuối == hạn hiện tại);
nếu audit thiếu dữ liệu (renew không log old_months, add-date không tháng, member chỉ
có gói mời...) → FALLBACK 1 kỳ gộp neo từ ngày tham gia. Member 'removed' giữ nguyên.
"""

from datetime import datetime, timedelta, timezone
from typing import Sequence, Union
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision: str = "0038_replay_cycles"
down_revision: Union[str, None] = "0037_group_cycle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DAY30 = timedelta(days=30)
_SUB_ACTIONS = (
    "MEMBER_SUBSCRIPTION_UPDATED",
    "MEMBER_SUBSCRIPTION_RENEWED",
    "MEMBER_ADD_DATE_CORRECTED",
)


def _parse(v):
    if not v:
        return None
    if isinstance(v, datetime):
        return v
    return datetime.fromisoformat(v)


def _months_between(s: datetime, e: datetime) -> int:
    return max(1, round((e - s).total_seconds() / (30 * 86400)))


def _clamp(dt, now):
    return now if (dt is not None and dt > now) else dt


def _trim(cycles, new_end):
    kept = []
    for s, e, m in cycles:
        if s >= new_end:
            continue
        if e > new_end:
            e = new_end
            m = _months_between(s, e)
        kept.append([s, e, m])
    return kept


def _replay(events, joined_at, now):
    """Trả về list [start, end, months] hoặc None nếu không dựng được."""
    cur_end = None
    cycles: list = []
    saw_reset = False
    for ev in events:
        d = ev["data"] or {}
        ne = _parse(d.get("new_end_at"))
        oe = _parse(d.get("old_end_at"))
        m = d.get("new_months")
        if m is None:
            m = d.get("months")
        if ne is None:
            # → vô thời hạn: xoá hết kỳ trước đó (reset).
            cycles = []
            cur_end = None
            saw_reset = True
            continue
        if cur_end is None:
            if not saw_reset and not cycles and oe is not None and oe < ne:
                # Sự kiện đầu KÉO DÀI gói mời có sẵn → seed kỳ mời từ ngày tham gia.
                seed = _clamp(joined_at, now)
                if seed is None or seed >= oe:
                    return None
                cycles.append([seed, oe, _months_between(seed, oe)])
                cur_end = oe
                # rơi xuống nhánh so sánh ne bên dưới để nối phần kéo dài.
            else:
                # Thiết lập cửa sổ mua mới kết thúc tại ne (neo = ne − tháng×30).
                if m is None:
                    return None
                start = ne - m * DAY30
                cycles.append([start, ne, m])
                cur_end = ne
                continue
        if ne > cur_end:
            mm = m if m is not None else _months_between(cur_end, ne)
            cycles.append([cur_end, ne, mm])
            cur_end = ne
        elif ne < cur_end:
            cycles = _trim(cycles, ne)
            cur_end = ne
        # ne == cur_end: không đổi hạn (chỉ dời neo) → bỏ qua.
    return cycles


def _valid(cycles, member_end, now):
    """Chỉ chấp nhận replay khi mọi kỳ là 1 LẦN MUA SẠCH: liền mạch, số ngày ≈ tháng×30
    (±2 ngày → 'mua đủ 30 ngày mới là kỳ'), kỳ 1 ≤ hôm nay, kỳ cuối == hạn hiện tại.
    Lịch sử lộn xộn (sửa ngày gia hạn / đổi ngày lẻ) sẽ trượt → fallback 1 kỳ gộp."""
    if not cycles:
        return False
    for i in range(1, len(cycles)):
        if cycles[i][0] != cycles[i - 1][1]:
            return False
    for s, e, m in cycles:
        if not (s < e) or m < 1:
            return False
        days = (e - s).total_seconds() / 86400.0
        if abs(days - m * 30) > 2:  # kỳ không phải bội số tháng sạch
            return False
    if cycles[0][0] > now + timedelta(seconds=1):
        return False
    # Kỳ cuối phải kết thúc đúng bằng hạn hiện tại (chênh <1s do làm tròn ISO).
    if abs((cycles[-1][1] - member_end).total_seconds()) >= 1:
        return False
    return True


def _fallback(joined_at, member_end, now):
    start = _clamp(joined_at, now)
    if start is None or start >= member_end:
        return []
    return [[start, member_end, _months_between(start, member_end)]]


def upgrade() -> None:
    conn = op.get_bind()
    now = datetime.now(timezone.utc)

    conn.execute(
        sa.text(
            """
            DELETE FROM member_subscription_cycles c
            USING members m
            WHERE c.member_id = m.id AND m.status <> 'removed'
            """
        )
    )

    members = conn.execute(
        sa.text(
            """
            SELECT id, joined_at, subscription_purchased_at, last_invited_at,
                   created_at, subscription_end_at
            FROM members
            WHERE status <> 'removed' AND subscription_end_at IS NOT NULL
            """
        )
    ).mappings().all()

    ins = sa.text(
        """
        INSERT INTO member_subscription_cycles
            (id, member_id, cycle_number, months, start_at, end_at,
             payment_status, paid_at, created_at)
        VALUES (:id, :mid, :num, :months, :start_at, :end_at, 'paid', :now, :now)
        """
    )

    for m in members:
        member_end = m["subscription_end_at"]
        joined = (
            m["joined_at"]
            or m["subscription_purchased_at"]
            or m["last_invited_at"]
            or m["created_at"]
        )
        events = conn.execute(
            sa.text(
                """
                SELECT data FROM audit_logs
                WHERE target_id = :mid AND action = ANY(:acts)
                ORDER BY timestamp
                """
            ),
            {"mid": str(m["id"]), "acts": list(_SUB_ACTIONS)},
        ).mappings().all()

        cycles = _replay(events, joined, now)
        if not _valid(cycles, member_end, now):
            cycles = _fallback(joined, member_end, now)
        if cycles:
            # Snap kỳ cuối về đúng hạn hiện tại (khử lệch <1s).
            cycles[-1][1] = member_end

        for i, (s, e, mm) in enumerate(cycles, start=1):
            conn.execute(
                ins,
                {
                    "id": uuid4(),
                    "mid": m["id"],
                    "num": i,
                    "months": mm,
                    "start_at": s,
                    "end_at": e,
                    "now": now,
                },
            )


def downgrade() -> None:
    # Không khôi phục được cửa sổ cũ đã dựng lại — no-op.
    pass
