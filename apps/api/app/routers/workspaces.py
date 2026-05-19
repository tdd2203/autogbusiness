"""Workspace CRUD + extension API key management."""

import secrets
from datetime import datetime, timezone
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
from app.sse import publish_task_event, subscriber_count
from app.schemas import (
    BillingSyncIn,
    ExtensionInfoIn,
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


@router.post("/extension-info", response_model=WorkspaceOut)
def update_extension_info(
    body: ExtensionInfoIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> Workspace:
    """Extension báo ChatGPT user đang đăng nhập trên browser."""
    if body.email is not None:
        workspace.chatgpt_user_email = body.email.strip().lower() or None
    if body.name is not None:
        workspace.chatgpt_user_name = body.name.strip() or None
    db.add(workspace)
    db.commit()
    db.refresh(workspace)
    return workspace


@router.post("/billing-sync", response_model=WorkspaceOut)
def push_billing_sync(
    body: BillingSyncIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> Workspace:
    """Extension push billing data scrape được từ /admin/billing.

    Format display dashboard: seat_used / seat_total (vd 6/8).
    """
    changes: dict = {}
    for field in (
        "plan",
        "seat_total",
        "seat_used",
        "billing_status",
        "renewal_date",
    ):
        new_val = getattr(body, field)
        if new_val is not None and new_val != getattr(workspace, field):
            changes[field] = {
                "before": getattr(workspace, field),
                "after": new_val.isoformat() if isinstance(new_val, datetime) else new_val,
            }
            setattr(workspace, field, new_val)

    if body.invoices is not None:
        # Lưu list serialized (date thành ISO string) → JSONB
        workspace.billing_invoices = [
            {
                "date": inv.date.isoformat(),
                "amount_vnd": inv.amount_vnd,
                "status": inv.status,
            }
            for inv in body.invoices
        ]
        changes["invoices_count"] = {
            "before": "?",
            "after": len(body.invoices),
        }

    workspace.last_billing_synced_at = datetime.now(timezone.utc)
    db.add(workspace)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action="WORKSPACE_BILLING_SYNCED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace.id),
        data={"changes": changes} if changes else None,
        commit=False,
    )
    db.commit()
    db.refresh(workspace)
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


@router.get("/{workspace_id}/extension-status", response_model=dict)
def get_extension_status(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(get_current_user),
) -> dict:
    """Dashboard poll endpoint này để biết extension nào có đang subscribe SSE
    cho workspace tương ứng. Cross-browser detection — KHÔNG cần postMessage
    bridge cùng trình duyệt.

    Trả:
      - online: bool — có ít nhất 1 extension SSE subscriber đang kết nối
      - subscribers: int — số extension đang subscribe (thường 0 hoặc 1)
    """
    ws = _get_workspace_or_404(db, workspace_id)
    count = subscriber_count(ws.id)
    return {"online": count > 0, "subscribers": count}


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
    include_pending: bool = True,
    expected_locale: str | None = None,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.WORKSPACE_SYNC_TRIGGER)),
) -> dict:
    """Tạo task SYNC_DATA để Extension scrape danh sách member từ ChatGPT về DB.

    Args:
        include_pending: nếu True (default) → scrape cả 3 tab (Người dùng + Lời
        mời + Yêu cầu); nếu False → chỉ scrape Người dùng (nhanh hơn ~3 lần
        nhưng không cập nhật trạng thái pending invites).
        expected_locale: tùy chọn ('vi' | 'en' | 'zh') — chỉ dùng khi client
        chủ động truyền (debug). Dashboard web KHÔNG gửi field này; ngôn ngữ
        sidebar dashboard độc lập với ChatGPT. Null = không check (mặc định).
    """
    _get_workspace_or_404(db, workspace_id)
    normalized_locale: str | None = None
    if expected_locale in ("vi", "en", "zh"):
        normalized_locale = expected_locale
    elif expected_locale and expected_locale.lower().startswith("zh"):
        normalized_locale = "zh"
    payload: dict = {"include_pending": include_pending}
    if normalized_locale:
        payload["expected_locale"] = normalized_locale
    queue_item = QueueItem(
        type="SYNC_DATA",
        status="PENDING",
        workspace_id=workspace_id,
        payload=payload,
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
        data={
            "queue_item_id": str(queue_item.id),
            "include_pending": include_pending,
            "expected_locale": normalized_locale,
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "SYNC_DATA"},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}


@router.post(
    "/{workspace_id}/revoke-invites", status_code=status.HTTP_202_ACCEPTED
)
def trigger_revoke_invites(
    workspace_id: UUID,
    body: dict,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    """Tạo task REVOKE_INVITES để Extension thu hồi danh sách pending invites.

    Body: {"emails": ["a@x.com", "b@y.com", ...]}

    Dùng cho flow "rogue invite detection": sau khi sync, dashboard phát hiện
    pending invites trên ChatGPT KHÔNG có trong DB → admin xác nhận thu hồi.
    """
    _get_workspace_or_404(db, workspace_id)
    raw_emails = body.get("emails") or []
    emails = [
        str(e).strip().lower()
        for e in raw_emails
        if isinstance(e, str) and "@" in e
    ]
    if not emails:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Danh sách emails rỗng hoặc không hợp lệ",
        )

    queue_item = QueueItem(
        type="REVOKE_INVITES",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"emails": emails},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="REVOKE_INVITES_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id), "count": len(emails)},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "REVOKE_INVITES",
        },
    )
    return {
        "queue_item_id": str(queue_item.id),
        "status": "queued",
        "count": len(emails),
    }


@router.post("/{workspace_id}/harvest-labels", status_code=status.HTTP_202_ACCEPTED)
def trigger_harvest_labels(
    workspace_id: UUID,
    body: dict,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    """Dashboard yêu cầu extension auto-quét label ChatGPT cho 1 locale.

    Body: {"locale": "vi" | "en" | "zh"}
    Extension navigate /admin/members → /admin/billing → /admin/identity, đọc
    text 18 control_key rồi POST /ui-labels/harvest. Admin chỉ cần đặt ChatGPT
    sang locale này trước khi bấm — không phải nhập tay.
    """
    locale = str(body.get("locale", "")).lower()
    if locale not in ("vi", "en", "zh"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="locale phải là 'vi', 'en' hoặc 'zh'",
        )
    _get_workspace_or_404(db, workspace_id)
    queue_item = QueueItem(
        type="HARVEST_LABELS",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"locale": locale},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="UI_LABELS_HARVEST_QUEUED",
        result="PENDING",
        target_type="UI_LABEL",
        data={"queue_item_id": str(queue_item.id), "locale": locale},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "HARVEST_LABELS",
        },
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued", "locale": locale}


@router.post("/{workspace_id}/sync-billing", status_code=status.HTTP_202_ACCEPTED)
def trigger_sync_billing(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.WORKSPACE_SYNC_TRIGGER)),
) -> dict:
    """Tạo task SYNC_BILLING để Extension scrape seat_total/seat_used từ trang billing."""
    _get_workspace_or_404(db, workspace_id)
    queue_item = QueueItem(
        type="SYNC_BILLING",
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
        action="WORKSPACE_BILLING_SYNC_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id)},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "SYNC_BILLING"},
    )
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
