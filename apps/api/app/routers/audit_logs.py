from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import AuditLog, Member, QueueItem, User, Workspace
from app.permissions import Permission
from app.schemas import AuditLogOut

router = APIRouter(prefix="/api/v1/audit-logs", tags=["audit"])


def _workspace_id_of(log: AuditLog) -> str | None:
    """workspace_id gắn với 1 audit log: ưu tiên data.workspace_id, fallback target
    khi target_type=WORKSPACE."""
    wid = (log.data or {}).get("workspace_id")
    if isinstance(wid, str) and wid:
        return wid
    if log.target_type == "WORKSPACE" and log.target_id:
        return log.target_id
    return None


def _owned_member_sets(db: Session, user_id: UUID) -> tuple[set[str], set[str]]:
    """member.id (str) + email (lowercase) do user mời — dùng lọc nhật ký sub-admin."""
    rows = db.execute(
        select(Member.id, func.lower(Member.email).label("email")).where(
            Member.invited_by_user_id == user_id
        )
    ).all()
    return {str(r.id) for r in rows}, {r.email for r in rows if r.email}


def _emails_in_log_data(data: dict | None) -> set[str]:
    if not data:
        return set()
    out: set[str] = set()
    email = data.get("email")
    if isinstance(email, str) and email.strip():
        out.add(email.strip().lower())
    for item in data.get("emails") or []:
        if isinstance(item, str) and item.strip():
            out.add(item.strip().lower())
    for entry in data.get("entries") or []:
        if isinstance(entry, dict):
            em = entry.get("email")
            if isinstance(em, str) and em.strip():
                out.add(em.strip().lower())
    return out


def _member_ids_in_log_data(data: dict | None) -> set[str]:
    if not data:
        return set()
    return {str(m) for m in data.get("member_ids") or []}


def _queue_payload_emails(payload: dict | None) -> list[str]:
    """Email trong payload task hàng đợi (REVOKE_INVITES.emails, REMOVE_MEMBER.email…)."""
    if not payload:
        return []
    out: list[str] = []
    raw = payload.get("emails")
    if isinstance(raw, list):
        for e in raw:
            if isinstance(e, str) and "@" in e:
                em = e.strip().lower()
                if em and em not in out:
                    out.append(em)
    email = payload.get("email")
    if isinstance(email, str) and "@" in email:
        em = email.strip().lower()
        if em and em not in out:
            out.append(em)
    return out


def _queue_item_id_of(log: AuditLog) -> str | None:
    d = log.data or {}
    qid = d.get("queue_item_id")
    if isinstance(qid, str) and qid:
        return qid
    if log.target_type == "QUEUE_ITEM" and log.target_id:
        return log.target_id
    return None


def _audit_log_visible(
    log: AuditLog,
    user: User,
    owned_ids: set[str],
    owned_emails: set[str],
) -> bool:
    """Sub-admin chỉ thấy nhật ký về email họ sở hữu + thao tác/thông tin của họ."""
    uid = user.id
    uid_s = str(uid)
    data = log.data or {}
    emails_in_log = _emails_in_log_data(data)
    member_ids = _member_ids_in_log_data(data)

    if log.actor_id == uid:
        if emails_in_log and not emails_in_log.issubset(owned_emails):
            return False
        if member_ids and not member_ids.issubset(owned_ids):
            return False
        return True

    if log.target_type == "USER" and log.target_id == uid_s:
        return True

    if log.target_type == "MEMBER" and log.target_id in owned_ids:
        return True

    if data.get("user_id") == uid_s:
        return True

    # Gán/chuyển chủ hàng loạt (MEMBER_BULK_OWNER_ASSIGN, MEMBER_OWNER_TRANSFERRED…).
    if data.get("target_user_id") == uid_s:
        return True

    # Đổi chủ đơn lẻ: user là chủ mới.
    if data.get("after") == uid_s:
        return True

    if emails_in_log and emails_in_log.issubset(owned_emails):
        return True

    if member_ids and member_ids.issubset(owned_ids):
        return True

    return False


# Quét tối đa N dòng gần nhất rồi post-filter — tránh SQL prefilter bỏ sót log
# hàng loạt (member_ids JSONB), extension (actor_id NULL), gán chủ cũ, v.v.
_SUB_ADMIN_AUDIT_SCAN = 3000


@router.get("", response_model=list[AuditLogOut])
def list_audit_logs(
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.AUDIT_LOG_VIEW)),
    limit: int = Query(default=100, le=500),
    action: str | None = Query(default=None),
    actor_type: str | None = Query(default=None),
) -> list[AuditLogOut]:
    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc())
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if actor_type:
        stmt = stmt.where(AuditLog.actor_type == actor_type)

    if user.is_super_admin:
        rows = list(db.execute(stmt.limit(limit)).scalars())
    else:
        owned_ids, owned_emails = _owned_member_sets(db, user.id)
        raw = list(db.execute(stmt.limit(_SUB_ADMIN_AUDIT_SCAN)).scalars())
        rows = [
            r
            for r in raw
            if _audit_log_visible(r, user, owned_ids, owned_emails)
        ][:limit]

    # Suy tên workspace cho các log gắn workspace (mời/xoá thành viên, workspace…).
    ids: set[UUID] = set()
    for r in rows:
        wid = _workspace_id_of(r)
        if wid:
            try:
                ids.add(UUID(wid))
            except ValueError:
                pass
    names: dict[str, str] = {}
    if ids:
        for wid, wname in db.execute(
            select(Workspace.id, Workspace.name).where(Workspace.id.in_(ids))
        ).all():
            names[str(wid)] = wname

    # Suy email thành viên cho các sự kiện HÀNG LOẠT chỉ lưu `member_ids` (đánh dấu
    # thanh toán / đặt hạn hàng loạt…) — để cột Đối tượng hiện RÕ AI bị ảnh hưởng
    # thay vì chỉ "N thành viên". Cũng suy từ target_id khi target_type=MEMBER mà
    # payload chưa có email (QUEUE_PICKED, MEMBER_REMOVED_SYNCED cũ…). Phân giải lúc
    # đọc → áp cho cả log cũ, không cần migration.
    member_ids: set[UUID] = set()
    for r in rows:
        d = r.data or {}
        if d.get("member_ids") and not d.get("emails"):
            for mid in d["member_ids"]:
                try:
                    member_ids.add(UUID(str(mid)))
                except (ValueError, TypeError):
                    pass
        if r.target_type == "MEMBER" and r.target_id and not _emails_in_log_data(d):
            try:
                member_ids.add(UUID(r.target_id))
            except (ValueError, TypeError):
                pass
    member_emails: dict[str, str] = {}
    if member_ids:
        mem_stmt = select(Member.id, Member.email).where(Member.id.in_(member_ids))
        if not user.is_super_admin:
            mem_stmt = mem_stmt.where(Member.invited_by_user_id == user.id)
        for mid, memail in db.execute(mem_stmt).all():
            member_emails[str(mid)] = memail

    # Suy email từ payload QueueItem khi audit chỉ có queue_item_id / QUEUE_ITEM
    # (REVOKE_INVITES_QUEUED cũ chỉ lưu count; QUEUE_PICKED không mang email).
    queue_ids: set[UUID] = set()
    for r in rows:
        d = r.data or {}
        if _emails_in_log_data(d):
            continue
        qid = _queue_item_id_of(r)
        if qid:
            try:
                queue_ids.add(UUID(qid))
            except (ValueError, TypeError):
                pass
        elif isinstance(d.get("payload"), dict):
            if _queue_payload_emails(d["payload"]):
                continue
    queue_emails: dict[str, list[str]] = {}
    if queue_ids:
        for qid, payload in db.execute(
            select(QueueItem.id, QueueItem.payload).where(QueueItem.id.in_(queue_ids))
        ).all():
            resolved = _queue_payload_emails(payload)
            if resolved:
                queue_emails[str(qid)] = resolved

    out: list[AuditLogOut] = []
    for r in rows:
        o = AuditLogOut.model_validate(r)
        wid = _workspace_id_of(r)
        o.workspace_name = names.get(wid) if wid else None
        d = dict(r.data or {})
        mutated = False
        if d.get("member_ids") and not d.get("emails"):
            resolved = [
                member_emails[str(m)]
                for m in d["member_ids"]
                if str(m) in member_emails
            ]
            if resolved:
                d["emails"] = resolved
                mutated = True
        if (
            r.target_type == "MEMBER"
            and r.target_id
            and r.target_id in member_emails
            and not _emails_in_log_data(d)
        ):
            d["email"] = member_emails[r.target_id]
            mutated = True
        if not _emails_in_log_data(d):
            qid = _queue_item_id_of(r)
            if qid and qid in queue_emails:
                d["emails"] = queue_emails[qid]
                if len(queue_emails[qid]) == 1:
                    d["email"] = queue_emails[qid][0]
                mutated = True
            elif isinstance(d.get("payload"), dict):
                from_payload = _queue_payload_emails(d["payload"])
                if from_payload:
                    d["emails"] = from_payload
                    if len(from_payload) == 1:
                        d["email"] = from_payload[0]
                    mutated = True
        if mutated:
            o.data = d
        out.append(o)
    return out
