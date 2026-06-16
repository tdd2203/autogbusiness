"""Chức năng: TASK TRIGGERS (dashboard enqueue task cho Extension thực thi).

⚠️ ĐỌC `triggers.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST /{workspace_id}/sync           → trigger_sync          (SYNC_DATA)
  - POST /{workspace_id}/revoke-invites → trigger_revoke_invites (REVOKE_INVITES)
  - POST /{workspace_id}/harvest-labels → trigger_harvest_labels (HARVEST_LABELS)
  - POST /{workspace_id}/sync-billing   → trigger_sync_billing  (SYNC_BILLING)
  - POST /{workspace_id}/purchase-seat  → trigger_purchase_seat (PURCHASE_SEAT)
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    get_session,
    require_permission,
    require_super_admin,
)
from app.models import QueueItem, User
from app.permissions import Permission
from app.schemas import PurchaseSeatIn
from app.sse import publish_task_event

from ._shared import router, _get_workspace_or_404


@router.post("/{workspace_id}/sync", status_code=status.HTTP_202_ACCEPTED)
def trigger_sync(
    workspace_id: UUID,
    include_pending: bool = True,
    scope: str | None = None,
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
    assert_workspace_access(db, user, workspace_id)
    normalized_locale: str | None = None
    if expected_locale in ("vi", "en", "zh"):
        normalized_locale = expected_locale
    elif expected_locale and expected_locale.lower().startswith("zh"):
        normalized_locale = "zh"
    # scope: 'members' | 'invites' | 'both'. Tương thích cũ: nếu client chỉ gửi
    # include_pending thì map (True→both, False→members).
    sync_scope = (
        scope
        if scope in ("members", "invites", "both")
        else ("both" if include_pending else "members")
    )
    payload: dict = {
        "sync_scope": sync_scope,
        # include_pending giữ lại cho reader cũ: members-only → False, còn lại True.
        "include_pending": sync_scope != "members",
    }
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
    assert_workspace_access(db, user, workspace_id)
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


@router.post("/{workspace_id}/purchase-seat", status_code=status.HTTP_202_ACCEPTED)
def trigger_purchase_seat(
    workspace_id: UUID,
    body: PurchaseSeatIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.BILLING_PAY)),
) -> dict:
    """Tạo task PURCHASE_SEAT để Extension mua thêm `quantity` seat trên ChatGPT.

    Flow extension (xem `docs/Workspace_Management/Purchase_Seat.md`):
      1. Navigate /admin/billing?tab=plan
      2. Click "Quản lý giấy phép"
      3. Tăng input "Người dùng" lên +quantity (vd 13 → 14)
      4. Click "Tiếp tục"
      → DỪNG. Admin tự bấm nút payment cuối trên ChatGPT.

    Dedup: nếu workspace đã có PURCHASE_SEAT PENDING/IN_PROGRESS → trả về task
    cũ (tránh double-charge khi user double-click). Audit log để admin trace
    được mọi lần thực hiện.
    """
    _get_workspace_or_404(db, workspace_id)
    existing = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace_id,
                QueueItem.type == "PURCHASE_SEAT",
                QueueItem.status.in_(("PENDING", "IN_PROGRESS")),
            )
        )
        .scalars()
        .first()
    )
    if existing:
        return {
            "queue_item_id": str(existing.id),
            "status": existing.status,
            "deduplicated": True,
        }

    queue_item = QueueItem(
        type="PURCHASE_SEAT",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"quantity": body.quantity},
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="PURCHASE_SEAT_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"queue_item_id": str(queue_item.id), "quantity": body.quantity},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "PURCHASE_SEAT",
        },
    )
    return {
        "queue_item_id": str(queue_item.id),
        "status": "queued",
        "quantity": body.quantity,
        "deduplicated": False,
    }
