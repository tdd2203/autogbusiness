"""Chức năng: WORKSPACE SETTINGS + EXTENSION STATUS (cấu hình rate-limit + poll online).

⚠️ ĐỌC `settings.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET   /{workspace_id}/settings          → get_workspace_settings
  - PATCH /{workspace_id}/settings          → update_workspace_settings
  - GET   /{workspace_id}/extension-status  → get_extension_status

Lưu ý: `get_extension_status` không thuộc nhóm "settings" thuần tuý nhưng là 1
endpoint read-only nhỏ (poll trạng thái SSE) nên đặt chung ở đây thay vì tạo
module riêng.
"""

from uuid import UUID

from fastapi import Depends
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    get_current_user,
    get_session,
    require_super_admin,
)
from app.models import User, WorkspaceSettings
from app.sse import subscriber_count
from app.schemas import WorkspaceSettingsOut, WorkspaceSettingsUpdate

from ._shared import router, _get_workspace_or_404


@router.get("/{workspace_id}/extension-status", response_model=dict)
def get_extension_status(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Dashboard poll endpoint này để biết extension nào có đang subscribe SSE
    cho workspace tương ứng. Cross-browser detection — KHÔNG cần postMessage
    bridge cùng trình duyệt.

    Trả:
      - online: bool — có ít nhất 1 extension SSE subscriber đang kết nối
      - subscribers: int — số extension đang subscribe (thường 0 hoặc 1)
    """
    ws = _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    count = subscriber_count(ws.id)
    return {"online": count > 0, "subscribers": count}


@router.get("/{workspace_id}/settings", response_model=WorkspaceSettingsOut)
def get_workspace_settings(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> WorkspaceSettings:
    _get_workspace_or_404(db, workspace_id)
    settings_row = db.get(WorkspaceSettings, workspace_id)
    if not settings_row:
        settings_row = WorkspaceSettings(workspace_id=workspace_id)
        db.add(settings_row)
        db.commit()
        db.refresh(settings_row)
    return settings_row


@router.patch("/{workspace_id}/settings", response_model=WorkspaceSettingsOut)
def update_workspace_settings(
    workspace_id: UUID,
    body: WorkspaceSettingsUpdate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> WorkspaceSettings:
    _get_workspace_or_404(db, workspace_id)
    settings_row = db.get(WorkspaceSettings, workspace_id)
    if not settings_row:
        settings_row = WorkspaceSettings(workspace_id=workspace_id)
        db.add(settings_row)
        db.flush()

    changes: dict = {}
    for field in ("rate_limit_invite_ms", "rate_limit_role_ms", "rate_limit_remove_ms", "dry_run_mode"):
        new_val = getattr(body, field)
        if new_val is not None and new_val != getattr(settings_row, field):
            changes[field] = {"before": getattr(settings_row, field), "after": new_val}
            setattr(settings_row, field, new_val)

    if not changes:
        return settings_row

    db.add(settings_row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_SETTINGS_UPDATED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data=changes,
        commit=False,
    )
    db.commit()
    db.refresh(settings_row)
    return settings_row
