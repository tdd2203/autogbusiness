from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import AuditLog


def log_event(
    db: Session,
    *,
    actor_type: str,
    action: str,
    result: str = "SUCCESS",
    actor_id: UUID | None = None,
    actor_label: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    data: dict[str, Any] | None = None,
    commit: bool = True,
) -> AuditLog:
    entry = AuditLog(
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label=actor_label,
        action=action,
        result=result,
        target_type=target_type,
        target_id=target_id,
        data=data,
    )
    db.add(entry)
    if commit:
        db.commit()
        db.refresh(entry)
    else:
        db.flush()
    return entry
