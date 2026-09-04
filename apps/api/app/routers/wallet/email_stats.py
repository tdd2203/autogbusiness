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

ĐỔI EMAIL KHÔNG PHẢI GHẾ MỚI (chốt user 2026-08-30). Đổi email A→B là thay tên
trên đúng một chu kỳ đã bán, không bán thêm chu kỳ nào:
  - Ô của A (ngày mời/gia hạn gốc) ĐỔI TÊN thành email cuối chuỗi A→B→C, kèm cờ
    `changed` để bảng hiện nhãn ĐỔI. Ngày 20 mời A, ngày 28 đổi sang B ⇒ ngày 20
    hiện B, nhãn "ĐỔI + MỚI"; ô bị thay là gia hạn thì nhãn "ĐỔI + CŨ".
  - Lượt mời của B (do chính lần đổi sinh ra) KHÔNG đếm thành add mới ngày 28 —
    nếu đếm thì một ghế ăn hai lượt, tổng phình lên đúng kiểu bảng này sinh ra để
    tránh.
  - Chu kỳ của A nằm NGOÀI kỳ báo cáo (A mời tháng 6, đổi tháng 8) thì lần đổi
    hiện thành 1 dòng ở NGÀY ĐỔI, đếm vào GIA HẠN ✓ — không thì tháng 8 trắng
    trơn dù có thao tác thật.
Nguồn: nhật ký `MEMBER_EMAIL_CHANGED` (`data.old_member_id` → `target_id`), chỉ
nó biết email nào thay cho email nào.
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
from app.schemas import (
    EmailStatsAgent,
    EmailStatsDay,
    EmailStatsEmail,
    EmailStatsOut,
)

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
# Nhật ký của một lần CHUYỂN HẠN. Hai tên vì lịch sử: "đổi email" (cũ) và "chuyển
# hạn sử dụng đến" (nay là đường DUY NHẤT của giao diện) — bỏ tên sau ra là bảng này
# lại đếm email nhận thành một ghế bán mới, đúng cái nó sinh ra để tránh.
_EMAIL_CHANGED = ("MEMBER_EMAIL_CHANGED", "MEMBER_SUBSCRIPTION_TRANSFERRED")

# Trần bước khi lần chuỗi A→B→C: chặn dữ liệu vòng (email cũ được mời lại rồi lại
# đổi) treo vòng lặp. Cùng lý do với `_EMAIL_CHAIN_MAX_HOPS` bên added_members.
_CHAIN_MAX_HOPS = 10


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

    __slots__ = ("ok", "agent_id", "agent_ts", "member_id", "changed", "old_email")

    def __init__(self) -> None:
        self.ok = False
        self.agent_id: UUID | None = None
        # Mốc của lượt đã dùng để quy chủ — lượt sau (mới hơn) mới được ghi đè.
        self.agent_ts: datetime | None = None
        # Member đứng sau ô — khoá để lần chuỗi đổi email (email trùng nhau qua
        # nhiều lần mời lại, member id thì không).
        self.member_id: str | None = None
        # Ô này đã bị một lần đổi email thay tên chưa.
        self.changed = False
        self.old_email: str | None = None


class _Change(NamedTuple):
    """Một lần đổi email A→B lấy từ nhật ký `MEMBER_EMAIL_CHANGED`."""

    ts: datetime
    old_member_id: str
    new_member_id: str
    old_email: str
    new_email: str
    actor_id: UUID | None


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
        emails=[],
    )


def _sort_emails(row: EmailStatsAgent) -> None:
    """Ngày mới nhất lên trước, trong cùng ngày thì email HỎNG lên trước — mở dòng
    đại lý ra là thấy ngay cái cần xử lý chứ không phải lướt hết danh sách."""
    row.emails.sort(key=lambda e: (e.ok, e.email))
    row.emails.sort(key=lambda e: e.date, reverse=True)


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

    # ── 2. Lịch sử đổi email: chuỗi A→B→C và những lượt mời không được đếm ──────
    # Quét CẢ BẢNG (không chặn thời gian): lần đổi có thể xảy ra SAU kỳ báo cáo mà
    # vẫn phải thay tên ô nằm trong kỳ, và có thể xảy ra TRƯỚC kỳ mà lượt mời của
    # email mới lại rơi vào trong kỳ. Số bản ghi nhỏ, added_members cũng quét vậy.
    next_by_member: dict[str, _Change] = {}
    changes: list[_Change] = []
    changes_by_old_email: dict[str, list[_Change]] = {}
    # member mới của một lần đổi → mốc đổi. Lượt MỜI của member này từ mốc đó trở đi
    # là phần vật lý của lần đổi, không phải ghế bán thêm. Chặn theo mốc vì email
    # đang `removed` được tái dùng record: bản ghi đó có thể đã có lượt mời thật từ
    # trước, cắt trắng theo member id là xoá nhầm doanh số cũ.
    changed_invite_from: dict[str, datetime] = {}
    for ev in db.execute(
        select(AuditLog)
        .where(AuditLog.action.in_(_EMAIL_CHANGED))
        .order_by(AuditLog.timestamp)
    ).scalars():
        data = ev.data or {}
        # CHỈ ca TIẾP QUẢN (email nhận được mời vào thay chỗ email cho). Ca CỘNG DỒN
        # (`will_invite=false`) là tặng thêm ngày cho một email ĐANG dùng: nó không
        # đổi tên ô nào cả, gom vào đây là bịa một lần "đổi email" không có thật.
        if data.get("will_invite") is False:
            continue
        old_id = data.get("old_member_id") or data.get("source_member_id")
        old_em = data.get("old_email") or data.get("source_email")
        new_em = data.get("new_email") or data.get("target_email")
        if not (old_id and ev.target_id and isinstance(old_em, str) and isinstance(new_em, str)):
            continue
        ch = _Change(
            ts=_aware(ev.timestamp),
            old_member_id=str(old_id),
            new_member_id=str(ev.target_id),
            old_email=old_em.strip().lower(),
            new_email=new_em.strip().lower(),
            actor_id=ev.actor_id,
        )
        changes.append(ch)
        # Một member bị đổi đi đúng 1 lần; có bản ghi lạ thì lần gần nhất thắng.
        next_by_member[ch.old_member_id] = ch
        changes_by_old_email.setdefault(ch.old_email, []).append(ch)
        prev = changed_invite_from.get(ch.new_member_id)
        if prev is None or ch.ts < prev:
            changed_invite_from[ch.new_member_id] = ch.ts

    def _chain(member_id: str) -> list[_Change]:
        """Các chặng đổi email đi ra từ `member_id`, theo thứ tự thời gian."""
        out: list[_Change] = []
        seen = {member_id}
        cur = member_id
        for _ in range(_CHAIN_MAX_HOPS):
            nxt = next_by_member.get(cur)
            if nxt is None or nxt.new_member_id in seen:
                break
            out.append(nxt)
            cur = nxt.new_member_id
            seen.add(cur)
        return out

    # ── 3. Sự kiện kết quả trong kỳ → gộp về ô (ngày, loại, email) ──────────────
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
        mid = str(ev.target_id) if ev.target_type == "MEMBER" and ev.target_id else None

        # Lượt mời sinh ra bởi một lần ĐỔI EMAIL: bỏ qua. Ghế này đã được đếm ở ô
        # của email cũ (bước 5 thay tên ô đó), đếm thêm ở đây là một ghế hai lượt.
        if not renew and mid is not None:
            from_ts = changed_invite_from.get(mid)
            if from_ts is not None and when >= from_ts:
                continue

        key = (day, kind, email)
        slot = slots.get(key)
        if slot is None:
            slot = slots[key] = _Slot()
        if mid is not None:
            slot.member_id = mid

        # Thành công THẮNG: mời hỏng rồi mời lại được thì ngày đó là 1 email THÀNH
        # CÔNG, không phải 1 hỏng + 1 thành công.
        if ev.action != _NEW_FAILED:
            slot.ok = True

        # Gia hạn do chính đại lý bấm → actor_id là chủ, khỏi tra bản đồ.
        agent = ev.actor_id if renew else _agent_from_queue(email, when)
        if agent is not None and (slot.agent_ts is None or when >= slot.agent_ts):
            slot.agent_id = agent
            slot.agent_ts = when
        if agent is None and slot.agent_id is None and mid:
            unresolved.setdefault(mid, []).append(key)

    # ── 4. Vớt chủ còn thiếu từ Member.invited_by_user_id ───────────────────────
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

    # ── 5. Đổi email: thay tên ô cũ, dựng dòng cho lần đổi có chu kỳ ngoài kỳ ───
    # `handled` = những member đã có một ô/dòng đại diện cho chu kỳ của mình. Chuỗi
    # A→B→C chỉ được xuất hiện MỘT lần, dù có mấy chặng đi nữa.
    handled: set[str] = set()
    renamed: dict[tuple[str, str, str], _Slot] = {}

    def _merge(key: tuple[str, str, str], slot: _Slot) -> None:
        """Hai ô cùng dồn về một email sau khi đổi tên thì gộp, không nhân đôi."""
        cur = renamed.get(key)
        if cur is None:
            renamed[key] = slot
            return
        cur.ok = cur.ok or slot.ok
        cur.changed = cur.changed or slot.changed
        if cur.old_email is None:
            cur.old_email = slot.old_email
        if cur.agent_id is None:
            cur.agent_id = slot.agent_id

    for (day, kind, email), slot in slots.items():
        hops = _chain(slot.member_id) if slot.member_id else []
        if not hops and slot.member_id is None:
            # Kết quả không kèm member id (mời hàng loạt hỏng, member phantom đã bị
            # xoá) → vớt theo email: lần đổi đầu tiên kể từ ngày của ô.
            day_start = datetime.combine(date.fromisoformat(day), time.min, tzinfo=VN_TZ)
            for ch in changes_by_old_email.get(email, ()):
                if ch.ts >= day_start:
                    hops = [ch, *_chain(ch.new_member_id)]
                    break
        if hops:
            slot.changed = True
            slot.old_email = email
            email = hops[-1].new_email
            handled.add(hops[0].old_member_id)
            handled.update(h.new_member_id for h in hops)
        _merge((day, kind, email), slot)
    slots = renamed

    for ch in changes:
        if ch.old_member_id in handled:
            handled.add(ch.new_member_id)  # chặng sau của chuỗi đã có đại diện
            continue
        if not (start <= ch.ts < end_excl):
            continue
        # Chu kỳ đang mang tên email cũ nằm ngoài kỳ báo cáo (mời tháng 6, đổi tháng
        # 8) → không có ô nào để thay tên. Dựng 1 dòng ở NGÀY ĐỔI, tính vào GIA HẠN ✓
        # (chốt user 2026-08-30): ghế cũ, không phải ghế bán thêm.
        hops = _chain(ch.new_member_id)
        handled.add(ch.old_member_id)
        handled.add(ch.new_member_id)
        handled.update(h.new_member_id for h in hops)
        day = ch.ts.astimezone(VN_TZ).date().isoformat()
        key = (day, "renew", hops[-1].new_email if hops else ch.new_email)
        slot = slots.get(key)
        if slot is None:
            slot = slots[key] = _Slot()
            slot.member_id = ch.new_member_id
        slot.ok = True
        slot.changed = True
        if slot.old_email is None:
            slot.old_email = ch.old_email
        if slot.agent_id is None:
            slot.agent_id = ch.actor_id

    # ── 6. Cộng số ──────────────────────────────────────────────────────────────
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

        day_row = per_day_agent.setdefault((day, uid), _blank_agent(owner, uid))
        all_row = total_agent.setdefault(uid, _blank_agent(owner, uid))
        for target in (bucket, total, day_row, all_row):
            setattr(target, field, getattr(target, field) + 1)
            target.total += 1

        entry = EmailStatsEmail(
            email=email,
            date=day,
            kind=kind,
            ok=slot.ok,
            changed=slot.changed,
            old_email=slot.old_email,
        )
        day_row.emails.append(entry)
        all_row.emails.append(entry)

    for (day, _uid), row in per_day_agent.items():
        _sort_emails(row)
        day_index[day].by_agent.append(row)
    for d in days:
        d.by_agent.sort(key=lambda r: (-r.total, r.username or "￿"))

    for row in total_agent.values():
        _sort_emails(row)
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
