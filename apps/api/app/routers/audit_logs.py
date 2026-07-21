from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import AuditLog, Member, User, Workspace
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


@router.get("", response_model=list[AuditLogOut])
def list_audit_logs(
    db: Session = Depends(get_session),
    _: User = Depends(require_permission(Permission.AUDIT_LOG_VIEW)),
    limit: int = Query(default=100, le=500),
    action: str | None = Query(default=None),
    actor_type: str | None = Query(default=None),
) -> list[AuditLogOut]:
    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc()).limit(limit)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if actor_type:
        stmt = stmt.where(AuditLog.actor_type == actor_type)
    rows = list(db.execute(stmt).scalars())

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
    # thay vì chỉ "N thành viên". Phân giải lúc đọc → áp cho cả log cũ, không cần
    # migration; member đã hard-delete (>30 ngày) thì bỏ qua id đó.
    member_ids: set[UUID] = set()
    for r in rows:
        d = r.data or {}
        if d.get("member_ids") and not d.get("emails"):
            for mid in d["member_ids"]:
                try:
                    member_ids.add(UUID(str(mid)))
                except (ValueError, TypeError):
                    pass
    member_emails: dict[str, str] = {}
    if member_ids:
        for mid, memail in db.execute(
            select(Member.id, Member.email).where(Member.id.in_(member_ids))
        ).all():
            member_emails[str(mid)] = memail

    out: list[AuditLogOut] = []
    for r in rows:
        o = AuditLogOut.model_validate(r)
        wid = _workspace_id_of(r)
        o.workspace_name = names.get(wid) if wid else None
        d = r.data or {}
        if d.get("member_ids") and not d.get("emails"):
            resolved = [
                member_emails[str(m)]
                for m in d["member_ids"]
                if str(m) in member_emails
            ]
            if resolved:
                # dict MỚI (không mutate r.data của ORM → tránh flush ngoài ý muốn).
                o.data = {**d, "emails": resolved}
        out.append(o)
    return out
