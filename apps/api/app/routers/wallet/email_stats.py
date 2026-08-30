"""Ví — Thống kê EMAIL add mới / gia hạn theo NGÀY (super-admin only).

Khác hẳn `report.py`: ở đó đếm TIỀN, ở đây đếm ĐẦU EMAIL — một ngày phục vụ bao
nhiêu email, bao nhiêu là add mới bao nhiêu là gia hạn, của đại lý nào, và trong
đó bao nhiêu email hỏng.

ĐƠN VỊ ĐẾM = 1 EMAIL TRONG 1 NGÀY (giờ VN), KHÔNG phải 1 lượt thao tác (chốt user
2026-08-29). Một email mời đi mời lại 5 lượt trong cùng ngày vẫn chỉ là 1 email;
có lượt nào thành công thì cả ngày đó tính THÀNH CÔNG. Vì sao phải chốt như vậy:
nhật ký ghi TỪNG LƯỢT, mà mời lỗi thì luôn có lượt mời lại — đếm lượt thì một
email hỏng rồi mời lại được sẽ vừa cộng vào "thất bại" vừa cộng vào "thành công",
tổng phình lên và không khớp với số ghế thật đang bán.

NGUỒN: nhật ký (`audit_logs`), vì chỉ ở đó mới có trạng thái HỎNG. Bảng `members`
không dùng được: lời mời hỏng bị xoá phantom nên đếm ra 0 email thất bại.
  - add mới    : MEMBER_INVITE_VERIFIED (thành công) / MEMBER_INVITE_FAILED (hỏng)
  - gia hạn    : MEMBER_SUBSCRIPTION_RENEWED (thành công)
MEMBER_INVITE_UNVERIFIABLE (lời mời treo, hệ thống chưa dám phán) KHÔNG vào bảng —
nó chưa phải thành công cũng chưa phải thất bại.

QUY CHỦ ("của ai"): sự kiện VERIFIED/FAILED do EXTENSION ghi nên KHÔNG mang
`actor_id`. Chủ lấy theo thứ tự:
  1. sự kiện MỜI (MEMBER_INVITE_QUEUED / MEMBER_BULK_INVITE_QUEUED) gần nhất TRƯỚC
     mốc kết quả của chính email đó — người thực sự bấm mời;
  2. `Member.invited_by_user_id` (chỉ còn cho email thành công — email hỏng đã bị xoá).
Không ra được thì gom vào nhóm "Chưa rõ chủ" (`user_id=None`).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import NamedTuple
from uuid import UUID

from fastapi import Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_super_admin
from app.models import AuditLog, Member, User
from app.schemas import EmailStatsAgent, EmailStatsDay, EmailStatsOut

from ._shared import router

VN_TZ = timezone(timedelta(hours=7))

# Số ngày lùi thêm khi nạp sự kiện MỜI để quy chủ. Lời mời bấm hôm trước mà mãi hôm
# sau extension mới chốt kết quả là chuyện thường (mời treo, đồng bộ muộn); không
# lùi thì những email đó rơi hết vào "Chưa rõ chủ".
_ATTR_LOOKBACK_DAYS = 30

# Trần số ngày một lần gọi được phép trả — chặn khoảng vô lý (vài năm) làm nặng DB.
_MAX_DAYS = 400

_NEW_OK = "MEMBER_INVITE_VERIFIED"
_NEW_FAILED = "MEMBER_INVITE_FAILED"
_RENEW_OK = "MEMBER_SUBSCRIPTION_RENEWED"
_QUEUED = ("MEMBER_INVITE_QUEUED", "MEMBER_BULK_INVITE_QUEUED")


def _aware(dt: datetime) -> datetime:
    """Mốc nhật ký luôn là UTC; vá tzinfo cho driver nào trả naive."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _emails_of_queued(ev: AuditLog) -> list[str]:
    """Danh sách email của 1 sự kiện MỜI. Mời lẻ ghi `data.email`, mời hàng loạt ghi
    `data.entries[].email` (xem members/invite.py)."""
    data = ev.data or {}
    single = data.get("email")
    if isinstance(single, str) and single:
        return [single.strip().lower()]
    out: list[str] = []
    for entry in data.get("entries") or []:
        if isinstance(entry, dict):
            em = entry.get("email")
            if isinstance(em, str) and em:
                out.append(em.strip().lower())
    return out


class _Slot:
    """Ô (ngày, loại, email) — gộp mọi lượt của cùng email trong cùng ngày về 1."""

    __slots__ = ("ok", "agent_id", "agent_ts")

    def __init__(self) -> None:
        self.ok = False
        self.agent_id: UUID | None = None
        # Mốc của lượt đã dùng để quy chủ — lượt sau (mới hơn) mới được ghi đè.
        self.agent_ts: datetime | None = None


class _Owner(NamedTuple):
    """Vài cột của `User` mà bảng này cần — khỏi nạp nguyên ORM của mọi tài khoản
    vào identity map (cùng lý do với `_OwnerInfo` trong report.py)."""

    username: str
    email: str | None
    is_test: bool


def _blank_agent(owner: _Owner | None, uid: UUID | None) -> EmailStatsAgent:
    return EmailStatsAgent(
        user_id=uid,
        username=owner.username if owner else None,
        email=owner.email if owner else None,
    )


@router.get("/admin/report/emails", response_model=EmailStatsOut)
def email_stats(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
) -> EmailStatsOut:
    """Thống kê email add mới / gia hạn theo ngày trong [from, to] (ISO date, bao
    gồm 2 đầu, giờ VN). Mặc định 30 ngày gần nhất. Chỉ đọc."""
    today = datetime.now(VN_TZ).date()
    from_date = date.fromisoformat(from_) if from_ else today - timedelta(days=29)
    to_date = date.fromisoformat(to) if to else today
    if to_date < from_date:
        from_date, to_date = to_date, from_date
    if (to_date - from_date).days > _MAX_DAYS:
        from_date = to_date - timedelta(days=_MAX_DAYS)

    start = datetime.combine(from_date, time.min, tzinfo=VN_TZ)
    end_excl = datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=VN_TZ)

    # ── 1. Bản đồ quy chủ: email → [(mốc, người bấm mời)] theo thứ tự thời gian ──
    attr: dict[str, list[tuple[datetime, UUID]]] = {}
    queued_rows = db.execute(
        select(AuditLog)
        .where(
            AuditLog.action.in_(_QUEUED),
            AuditLog.timestamp >= start - timedelta(days=_ATTR_LOOKBACK_DAYS),
            AuditLog.timestamp < end_excl,
        )
        .order_by(AuditLog.timestamp)
    ).scalars()
    for ev in queued_rows:
        if ev.actor_id is None:
            continue
        for em in _emails_of_queued(ev):
            attr.setdefault(em, []).append((_aware(ev.timestamp), ev.actor_id))

    def _agent_from_queue(email: str, when: datetime) -> UUID | None:
        """Người bấm mời gần nhất TRƯỚC `when`; không có thì lượt mời đầu tiên thấy
        được (kết quả về trước cả sự kiện mời là chuyện lệch đồng hồ, vẫn quy chủ
        được chứ không nên vứt vào 'chưa rõ')."""
        hits = attr.get(email)
        if not hits:
            return None
        best: UUID | None = None
        for ts, uid in hits:
            if ts <= when:
                best = uid
            else:
                break
        return best if best is not None else hits[0][1]

    # ── 2. Sự kiện kết quả trong kỳ → gộp về ô (ngày, loại, email) ──────────────
    # kind: "new" | "renew"
    slots: dict[tuple[str, str, str], _Slot] = {}
    # Email chưa quy được chủ từ sự kiện mời → tra `Member` ở bước 3.
    unresolved: dict[str, list[tuple[str, str, str]]] = {}

    result_rows = db.execute(
        select(AuditLog)
        .where(
            AuditLog.action.in_((_NEW_OK, _NEW_FAILED, _RENEW_OK)),
            AuditLog.timestamp >= start,
            AuditLog.timestamp < end_excl,
        )
        .order_by(AuditLog.timestamp)
    ).scalars()

    for ev in result_rows:
        data = ev.data or {}
        email = data.get("email")
        if not isinstance(email, str) or not email:
            continue
        email = email.strip().lower()
        when = _aware(ev.timestamp)
        day = when.astimezone(VN_TZ).date().isoformat()
        renew = ev.action == _RENEW_OK
        kind = "renew" if renew else "new"
        key = (day, kind, email)
        slot = slots.get(key)
        if slot is None:
            slot = slots[key] = _Slot()

        # Thành công THẮNG: mời hỏng rồi mời lại được thì ngày đó là 1 email THÀNH
        # CÔNG, không phải 1 hỏng + 1 thành công.
        if ev.action != _NEW_FAILED:
            slot.ok = True

        # Gia hạn do chính đại lý bấm → actor_id là chủ, khỏi tra bản đồ.
        agent = ev.actor_id if renew else _agent_from_queue(email, when)
        if agent is not None and (slot.agent_ts is None or when >= slot.agent_ts):
            slot.agent_id = agent
            slot.agent_ts = when
        if agent is None and slot.agent_id is None:
            mid = ev.target_id if ev.target_type == "MEMBER" else None
            if mid:
                unresolved.setdefault(mid, []).append(key)

    # ── 3. Vớt chủ còn thiếu từ Member.invited_by_user_id ───────────────────────
    if unresolved:
        member_ids: list[UUID] = []
        for mid in unresolved:
            try:
                member_ids.append(UUID(mid))
            except ValueError:
                continue
        for chunk_start in range(0, len(member_ids), 500):
            chunk = member_ids[chunk_start : chunk_start + 500]
            for row in db.execute(
                select(Member.id, Member.invited_by_user_id).where(Member.id.in_(chunk))
            ):
                if row.invited_by_user_id is None:
                    continue
                for key in unresolved.get(str(row.id), ()):
                    slot = slots.get(key)
                    if slot is not None and slot.agent_id is None:
                        slot.agent_id = row.invited_by_user_id

    # ── 4. Cộng số ──────────────────────────────────────────────────────────────
    users: dict[UUID, _Owner] = {
        row.id: _Owner(row.username, row.email, row.is_test)
        for row in db.execute(
            select(User.id, User.username, User.email, User.is_test)
        )
    }

    days: list[EmailStatsDay] = []
    day_index: dict[str, EmailStatsDay] = {}
    cur = from_date
    while cur <= to_date:
        d = EmailStatsDay(date=cur.isoformat(), by_agent=[])
        days.append(d)
        day_index[d.date] = d
        cur += timedelta(days=1)

    # (ngày, chủ) → dòng đại lý của ngày đó; (chủ,) → dòng gộp cả kỳ.
    per_day_agent: dict[tuple[str, UUID | None], EmailStatsAgent] = {}
    total_agent: dict[UUID | None, EmailStatsAgent] = {}
    unique_emails: set[str] = set()

    total = EmailStatsDay(date="", by_agent=[])

    for (day, kind, email), slot in slots.items():
        owner = users.get(slot.agent_id) if slot.agent_id else None
        # Đại lý test không phải doanh số thật — loại y như báo cáo tài chính.
        if owner is not None and owner.is_test:
            continue
        uid = slot.agent_id if owner is not None else None
        field = f"{'renew' if kind == 'renew' else 'new'}_{'ok' if slot.ok else 'failed'}"

        bucket = day_index.get(day)
        if bucket is None:
            continue  # ngoài kỳ (không xảy ra, giữ cho chắc)
        unique_emails.add(email)

        for target in (
            bucket,
            total,
            per_day_agent.setdefault((day, uid), _blank_agent(owner, uid)),
            total_agent.setdefault(uid, _blank_agent(owner, uid)),
        ):
            setattr(target, field, getattr(target, field) + 1)
            target.total += 1

    for (day, _uid), row in per_day_agent.items():
        day_index[day].by_agent.append(row)
    for d in days:
        d.by_agent.sort(key=lambda r: (-r.total, r.username or "￿"))

    by_agent = sorted(
        total_agent.values(), key=lambda r: (-r.total, r.username or "￿")
    )

    return EmailStatsOut(
        from_date=from_date.isoformat(),
        to_date=to_date.isoformat(),
        new_ok=total.new_ok,
        new_failed=total.new_failed,
        renew_ok=total.renew_ok,
        renew_failed=total.renew_failed,
        total=total.total,
        unique_emails=len(unique_emails),
        days=days,
        by_agent=by_agent,
    )
