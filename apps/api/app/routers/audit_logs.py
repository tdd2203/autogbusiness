from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import AuditLog, User
from app.permissions import Permission
from app.schemas import AuditLogOut

router = APIRouter(prefix="/api/v1/audit-logs", tags=["audit"])


@router.get("", response_model=list[AuditLogOut])
def list_audit_logs(
    db: Session = Depends(get_session),
    _: User = Depends(require_permission(Permission.AUDIT_LOG_VIEW)),
    limit: int = Query(default=100, le=500),
    action: str | None = Query(default=None),
    actor_type: str | None = Query(default=None),
) -> list[AuditLog]:
    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc()).limit(limit)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if actor_type:
        stmt = stmt.where(AuditLog.actor_type == actor_type)
    return list(db.execute(stmt).scalars())
