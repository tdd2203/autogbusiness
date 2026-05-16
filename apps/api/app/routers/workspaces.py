"""Workspace CRUD + extension API key management."""

import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_current_user,
    get_session,
    require_extension_workspace,
    require_permission,
    require_super_admin,
)
from app.models import QueueItem, User, Workspace, WorkspaceSettings
from app.permissions import Permission
from app.schemas import (
    WorkspaceCreate,
    WorkspaceOut,
    WorkspaceSettingsOut,
    WorkspaceSettingsUpdate,
    WorkspaceUpdate,
    WorkspaceWithKey,
)

router = APIRouter(prefix="/api/v1/workspaces", tags=["workspaces"])


def _generate_api_key() -> str:
    """48-char URL-safe random string (≈288 bits entropy)."""
    return secrets.token_urlsafe(36)[:48]


def _get_workspace_or_404(db: Session, workspace_id: UUID) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if not ws:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace không tồn tại")
    return ws


@router.get("/whoami", response_model=WorkspaceOut)
def extension_whoami(
    workspace: Workspace = Depends(require_extension_workspace),
) -> Workspace:
    """Extension dùng để verify X-API-KEY hợp lệ + lấy thông tin workspace tương ứng."""
    return workspace


@router.get("", response_model=list[WorkspaceOut])
def list_workspaces(
    db: Session = Depends(get_session),
    _: User = Depends(get_current_user),
) -> list[Workspace]:
    return list(db.execute(select(Workspace).order_by(Workspace.created_at.desc())).scalars())


@router.post("", response_model=WorkspaceWithKey, status_code=status.HTTP_201_CREATED)
def create_workspace(
    body: WorkspaceCreate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    if body.chatgpt_id:
        existing = db.execute(
            select(Workspace).where(Workspace.chatgpt_id == body.chatgpt_id)
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Workspace với chatgpt_id này đã tồn tại",
            )

    ws = Workspace(
        name=body.name,
        chatgpt_id=body.chatgpt_id,
        plan=body.plan,
        seat_total=body.seat_total,
        extension_api_key=_generate_api_key(),
        created_by_id=actor.id,
    )
    db.add(ws)
    db.flush()

    db.add(WorkspaceSettings(workspace_id=ws.id))

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_CREATED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        data={"name": ws.name, "chatgpt_id": ws.chatgpt_id, "plan": ws.plan},
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws


@router.get("/{workspace_id}", response_model=WorkspaceOut)
def get_workspace(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(get_current_user),
) -> Workspace:
    return _get_workspace_or_404(db, workspace_id)


@router.patch("/{workspace_id}", response_model=WorkspaceOut)
def update_workspace(
    workspace_id: UUID,
    body: WorkspaceUpdate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    ws = _get_workspace_or_404(db, workspace_id)
    changes: dict = {}

    for field in ("name", "chatgpt_id", "plan", "seat_total"):
        new_val = getattr(body, field)
        if new_val is not None and new_val != getattr(ws, field):
            changes[field] = {"before": getattr(ws, field), "after": new_val}
            setattr(ws, field, new_val)

    if not changes:
        return ws

    db.add(ws)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_UPDATED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        data=changes,
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws


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


@router.post("/{workspace_id}/sync", status_code=status.HTTP_202_ACCEPTED)
def trigger_sync(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.WORKSPACE_SYNC_TRIGGER)),
) -> dict:
    """Tạo task SYNC_DATA để Extension scrape danh sách member từ ChatGPT về DB."""
    _get_workspace_or_404(db, workspace_id)
    queue_item = QueueItem(
        type="SYNC_DATA",
        status="PENDING",
        workspace_id=workspace_id,
        payload={},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="WORKSPACE_SYNC_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id)},
        commit=False,
    )
    db.commit()
    return {"queue_item_id": str(queue_item.id), "status": "queued"}


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
