"""Chức năng: EXTENSION API KEY (reveal / regenerate khoá X-API-KEY của workspace).

⚠️ ĐỌC `apikey.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /{workspace_id}/reveal-key     → reveal_api_key
  - POST /{workspace_id}/regenerate-key → regenerate_api_key
"""

from uuid import UUID

from fastapi import Depends
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_super_admin
from app.models import User, Workspace
from app.schemas import WorkspaceWithKey

from ._shared import router, _generate_api_key, _get_workspace_or_404


@router.post("/{workspace_id}/reveal-key", response_model=WorkspaceWithKey)
def reveal_api_key(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    """Trả về extension_api_key hiện tại (không regenerate). Audit log mỗi lần reveal."""
    ws = _get_workspace_or_404(db, workspace_id)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_API_KEY_REVEALED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        commit=False,
    )
    db.commit()
    return ws


@router.post("/{workspace_id}/regenerate-key", response_model=WorkspaceWithKey)
def regenerate_api_key(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    ws = _get_workspace_or_404(db, workspace_id)
    ws.extension_api_key = _generate_api_key()
    db.add(ws)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_API_KEY_REGENERATED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws
