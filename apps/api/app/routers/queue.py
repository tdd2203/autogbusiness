import asyncio
import json
import queue as _queue
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    get_current_user,
    get_session,
    require_extension_workspace,
    require_permission,
)
from app.models import Invite, Member, QueueItem, User, Workspace
from app.permissions import Permission
from app.schemas import QueueCreate, QueueOut, QueueProgressUpdate, QueueUpdate
from app.sse import subscribe, unsubscribe

router = APIRouter(prefix="/api/v1/queue", tags=["queue"])


_TYPE_TO_PERMISSION = {
    "INVITE_MEMBER": Permission.MEMBER_INVITE,
    "REMOVE_MEMBER": Permission.MEMBER_REMOVE,
    "CHANGE_ROLE": Permission.MEMBER_CHANGE_ROLE,
    "SYNC_DATA": Permission.WORKSPACE_SYNC_TRIGGER,
    "SYNC_BILLING": Permission.WORKSPACE_SYNC_TRIGGER,
    "REVOKE_INVITES": Permission.MEMBER_REMOVE,
}


@router.post("", response_model=QueueOut, status_code=status.HTTP_201_CREATED)
def create_task(
    body: QueueCreate,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> QueueItem:
    required = _TYPE_TO_PERMISSION.get(body.type)
    if required is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Loại task không hợp lệ: {body.type}",
        )
    if not user.is_super_admin and required.value not in (user.permissions or []):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Thiếu permission: {required.value}",
        )

    item = QueueItem(
        type=body.type,
        payload=body.payload,
        status="PENDING",
        workspace_id=body.workspace_id,
        created_by_id=user.id,
    )
    db.add(item)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action=f"QUEUE_CREATED:{body.type}",
        result="SUCCESS",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        data={"payload": body.payload},
        commit=False,
    )
    db.commit()
    db.refresh(item)
    return item


@router.get("", response_model=list[QueueOut])
def list_tasks(
    db: Session = Depends(get_session),
    _: User = Depends(require_permission(Permission.QUEUE_VIEW)),
    status_filter: str | None = Query(default=None, alias="status"),
    workspace_id: UUID | None = Query(default=None),
    limit: int = Query(default=50, le=200),
) -> list[QueueItem]:
    stmt = select(QueueItem).order_by(QueueItem.created_at.desc()).limit(limit)
    if status_filter:
        stmt = stmt.where(QueueItem.status == status_filter)
    if workspace_id is not None:
        stmt = stmt.where(QueueItem.workspace_id == workspace_id)
    return list(db.execute(stmt).scalars())


# ---------- Extension endpoints (X-API-KEY) ----------
@router.get("/pending-count", response_model=dict)
def pending_count(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Extension popup hiển thị số task đang chờ cho workspace tương ứng."""
    from sqlalchemy import func as sa_func

    count = (
        db.execute(
            select(sa_func.count(QueueItem.id)).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "PENDING",
            )
        ).scalar()
        or 0
    )
    return {"count": int(count), "workspace_id": str(workspace.id)}


@router.post("/sync-billing", status_code=status.HTTP_202_ACCEPTED, response_model=dict)
def extension_trigger_sync_billing(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Extension popup trigger SYNC_BILLING task để refresh seat_used/seat_total.

    Dùng X-API-KEY auth (workspace key) thay vì admin session — cho phép popup
    extension chủ động enqueue khi user thấy seat hiển thị stale.

    Dedup: nếu đã có SYNC_BILLING PENDING/IN_PROGRESS trong workspace này thì
    trả về task hiện tại, KHÔNG tạo trùng (tránh stack).
    """
    from app.sse import publish_task_event

    existing = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.type == "SYNC_BILLING",
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
    task = QueueItem(
        type="SYNC_BILLING",
        status="PENDING",
        workspace_id=workspace.id,
        payload={"triggered_by": "extension-popup"},
        created_by_id=None,
    )
    db.add(task)
    db.flush()
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action="WORKSPACE_BILLING_SYNC_QUEUED",
        result="PENDING",
        target_type="WORKSPACE",
        target_id=str(workspace.id),
        data={"queue_item_id": str(task.id), "trigger": "popup"},
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace.id,
        {
            "type": "task-available",
            "task_id": str(task.id),
            "task_type": "SYNC_BILLING",
        },
    )
    return {
        "queue_item_id": str(task.id),
        "status": "PENDING",
        "deduplicated": False,
    }


@router.get("/active", response_model=dict)
def active_task(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> dict:
    """Popup extension lấy task đang chạy + tiến trình + đếm pending.

    Trả về:
        in_progress: 1 task IN_PROGRESS gần nhất (hoặc null) — kèm progress JSON
        pending_count: số task PENDING đang chờ pick
        recent_completed: 1 task COMPLETED/FAILED gần nhất trong 60s qua (cho
                          popup hiện "Vừa xong: …") — nullable
    """
    from datetime import timedelta
    from sqlalchemy import func as sa_func

    in_progress = (
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "IN_PROGRESS",
            )
            .order_by(QueueItem.picked_at.desc().nullslast())
            .limit(1)
        )
        .scalars()
        .first()
    )

    pending = (
        db.execute(
            select(sa_func.count(QueueItem.id)).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "PENDING",
            )
        ).scalar()
        or 0
    )

    # Recent terminal task trong 60s gần đây
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=60)
    recent = (
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status.in_(("COMPLETED", "FAILED")),
                QueueItem.completed_at >= cutoff,
            )
            .order_by(QueueItem.completed_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )

    def task_to_dict(t: QueueItem | None) -> dict | None:
        if not t:
            return None
        return {
            "id": str(t.id),
            "type": t.type,
            "status": t.status,
            "progress": t.progress,
            "result": t.result,
            "error_code": t.error_code,
            "error_message": t.error_message,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "picked_at": t.picked_at.isoformat() if t.picked_at else None,
            "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        }

    return {
        "in_progress": task_to_dict(in_progress),
        "pending_count": int(pending),
        "recent_completed": task_to_dict(recent),
        "workspace_id": str(workspace.id),
    }



@router.get("/stream")
async def stream_queue_events(
    workspace: Workspace = Depends(require_extension_workspace),
) -> StreamingResponse:
    """SSE stream: backend push real-time event tới extension khi có task mới.

    Extension fetch /queue/stream với header X-API-KEY, giữ connection mở.
    Khi dashboard tạo task → publish_task_event → SSE yield event NGAY LẬP TỨC.
    Extension nhận event → gọi runUntilIdle → drain queue trong 1-2s.

    Heartbeat 25s/lần để (a) giữ proxy/SW alive, (b) detect dead connection.
    """
    q = subscribe(workspace.id)
    workspace_id = workspace.id
    workspace_name = workspace.name

    async def generator():
        try:
            # Initial event để client biết đã connect thành công.
            hello = {
                "type": "connected",
                "workspace_id": str(workspace_id),
                "workspace_name": workspace_name,
            }
            yield f"data: {json.dumps(hello)}\n\n"

            while True:
                try:
                    event = await asyncio.wait_for(
                        asyncio.to_thread(q.get, True, 25),
                        timeout=30,
                    )
                    yield f"data: {json.dumps(event)}\n\n"
                except (asyncio.TimeoutError, _queue.Empty):
                    # Heartbeat comment — client ignore.
                    yield ": heartbeat\n\n"
        finally:
            unsubscribe(workspace_id, q)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable nginx buffering nếu reverse proxy
        },
    )


@router.get("/next", response_model=QueueOut | None)
def pick_next(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem | None:
    """Extension polling: lấy 1 task PENDING FIFO trong workspace của API key, đánh dấu IN_PROGRESS.

    Trước khi pick task mới, AUTO-FAIL task IN_PROGRESS bị treo > 5 phút trong
    cùng workspace — extension picked nhưng không trả kết quả (content script
    crash, tab close, DOM treo, …). Lazy cleanup tránh popup hiển thị 'ĐANG
    CHẠY' mãi mãi + cho phép task tiếp theo chạy.
    """
    from datetime import timedelta

    STUCK_THRESHOLD = timedelta(minutes=5)
    now = datetime.now(timezone.utc)
    cutoff = now - STUCK_THRESHOLD
    stuck_tasks = (
        db.execute(
            select(QueueItem).where(
                QueueItem.workspace_id == workspace.id,
                QueueItem.status == "IN_PROGRESS",
                QueueItem.picked_at < cutoff,
            )
        )
        .scalars()
        .all()
    )
    for stuck in stuck_tasks:
        age_sec = int((now - stuck.picked_at).total_seconds()) if stuck.picked_at else None
        stuck.status = "FAILED"
        stuck.error_code = "TIMEOUT"
        stuck.error_message = (
            f"Task IN_PROGRESS quá 5 phút ({age_sec}s) — extension không trả "
            f"kết quả. Auto-cleanup lúc pick task tiếp theo."
        )
        stuck.completed_at = now
        db.add(stuck)
        log_event(
            db,
            actor_type="SYSTEM",
            actor_label="lazy-cleanup",
            action=f"QUEUE_TIMEOUT:{stuck.type}",
            result="FAILED",
            target_type="QUEUE_ITEM",
            target_id=str(stuck.id),
            data={"age_sec": age_sec, "workspace_id": str(workspace.id)},
            commit=False,
        )
    if stuck_tasks:
        db.commit()

    item = (
        db.execute(
            select(QueueItem)
            .where(
                QueueItem.status == "PENDING",
                QueueItem.workspace_id == workspace.id,
            )
            .order_by(QueueItem.created_at.asc())
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .first()
    )
    if not item:
        return None
    item.status = "IN_PROGRESS"
    item.picked_at = datetime.now(timezone.utc)
    db.add(item)
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action=f"QUEUE_PICKED:{item.type}",
        result="PENDING",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        commit=False,
    )
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{item_id}", response_model=QueueOut)
def update_task(
    item_id: UUID,
    body: QueueUpdate,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem:
    item = db.get(QueueItem, item_id)
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Queue item không tồn tại"
        )
    if item.workspace_id != workspace.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Queue item không thuộc workspace của API key này",
        )
    # ---- Auto-reconcile các trường hợp "phantom record" trên dashboard ----
    # Khi extension báo lỗi mà thực ra ChatGPT đã ở đúng state mong muốn rồi
    # (vd: remove một member đã không còn trên ChatGPT), backend convert
    # FAILED → COMPLETED và update DB cho khớp thực tế, tránh phantom record.
    reconcile_note: str | None = None
    effective_status = body.status
    if (
        body.status == "FAILED"
        and body.error_code == "UI_ELEMENT_NOT_FOUND"
        and item.type == "REMOVE_MEMBER"
    ):
        member_id_str = (item.payload or {}).get("member_id")
        if member_id_str:
            try:
                member_uuid = UUID(str(member_id_str))
                member = db.get(Member, member_uuid)
                if member and member.workspace_id == workspace.id:
                    member.status = "removed"
                    db.add(member)
                    reconcile_note = (
                        f"Member không tìm thấy trên ChatGPT → đã có sẵn trong "
                        f"trạng thái removed; coi như xoá thành công."
                    )
                    effective_status = "COMPLETED"
            except (ValueError, TypeError):
                pass

    # ---- REVOKE_INVITES COMPLETED → mark các email trong payload là removed ----
    # Extension đã click "Thu hồi lời mời" trên ChatGPT thành công cho danh sách
    # email; DB phải khớp theo (status='removed') để dashboard không còn hiển
    # thị các pending record này.
    if body.status == "COMPLETED" and item.type == "REVOKE_INVITES":
        raw_emails = (item.payload or {}).get("emails") or []
        revoke_emails = [
            str(e).strip().lower()
            for e in raw_emails
            if isinstance(e, str) and "@" in e
        ]
        if revoke_emails:
            stale_members = (
                db.execute(
                    select(Member).where(
                        Member.workspace_id == workspace.id,
                        Member.email.in_(revoke_emails),
                        Member.status.in_(("pending", "active")),
                    )
                )
                .scalars()
                .all()
            )
            for member in stale_members:
                member.status = "removed"
                db.add(member)

    item.status = effective_status
    if body.result is not None:
        item.result = body.result
    elif reconcile_note:
        item.result = {"reconciled": True, "note": reconcile_note}
    item.error_code = None if effective_status == "COMPLETED" else body.error_code
    item.error_message = (
        reconcile_note
        if effective_status == "COMPLETED" and reconcile_note
        else (None if effective_status == "COMPLETED" else body.error_message)
    )
    if effective_status in ("COMPLETED", "FAILED"):
        item.completed_at = datetime.now(timezone.utc)
    db.add(item)

    # CHANGE_ROLE COMPLETED → sync Member.chatgpt_role trong DB.
    # Trước đây extension click đổi role trên ChatGPT thành công nhưng DB
    # không update → dashboard vẫn hiển thị role cũ cho tới khi SYNC_DATA chạy.
    # Lookup member theo email từ payload + đổi chatgpt_role = new_role.
    if (
        item.type == "CHANGE_ROLE"
        and effective_status == "COMPLETED"
    ):
        payload = item.payload or {}
        target_email = (payload.get("email") or "").lower()
        new_role = payload.get("new_role")
        if target_email and new_role:
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member:
                member.chatgpt_role = new_role
                db.add(member)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_ROLE_SYNCED",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={"email": target_email, "new_role": new_role},
                    commit=False,
                )

    # REMOVE_MEMBER COMPLETED → sync Member.status='removed' trong DB.
    if (
        item.type == "REMOVE_MEMBER"
        and effective_status == "COMPLETED"
    ):
        payload = item.payload or {}
        target_email = (payload.get("email") or "").lower()
        if target_email:
            member = db.execute(
                select(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email == target_email,
                )
            ).scalar_one_or_none()
            if member and member.status != "removed":
                member.status = "removed"
                db.add(member)
                log_event(
                    db,
                    actor_type="EXTENSION",
                    actor_label=f"workspace:{workspace.name}",
                    action="MEMBER_REMOVED_SYNCED",
                    result="COMPLETED",
                    target_type="MEMBER",
                    target_id=str(member.id),
                    data={"email": target_email},
                    commit=False,
                )

    # PHANTOM CLEANUP cho INVITE_MEMBER: xoá Member + Invite records mà ChatGPT
    # KHÔNG thực sự nhận → dashboard chỉ hiển thị email đã được mời thật.
    #
    # Case 1 — FAILED (extension không chạy được, content script lỗi, dialog
    # không mở, etc.): xoá toàn bộ Member + Invite records của queue task này.
    #
    # Case 2 — COMPLETED với verify info: chỉ xoá emails trong unverified_emails
    # (ChatGPT từ chối thầm / email đã active sẵn). Verified emails giữ lại.
    #
    # Case 3 — COMPLETED nhưng verify_scrape_failed=true (extension không
    # scrape được tab pending): GIỮ LẠI tất cả records (không có thông tin để
    # quyết định → safe default), admin tự kiểm tra manual.
    #
    # Chỉ xoá Member records `status='pending'` + `joined_at IS NULL` —
    # đảm bảo không xoá nhầm record đã được sync sang active.
    if item.type == "INVITE_MEMBER":
        emails_to_delete: list[str] = []
        if effective_status == "FAILED":
            invites = (
                db.execute(
                    select(Invite).where(Invite.queue_item_id == item.id)
                )
                .scalars()
                .all()
            )
            emails_to_delete = [inv.email.lower() for inv in invites]
        elif effective_status == "COMPLETED":
            result_dict = body.result or {}
            verify_failed = bool(result_dict.get("verify_scrape_failed"))
            if not verify_failed:
                unverified = result_dict.get("unverified_emails") or []
                if isinstance(unverified, list):
                    emails_to_delete = [
                        str(e).lower()
                        for e in unverified
                        if isinstance(e, str) and "@" in e
                    ]

        if emails_to_delete:
            db.execute(
                delete(Member).where(
                    Member.workspace_id == workspace.id,
                    Member.email.in_(emails_to_delete),
                    Member.status == "pending",
                    Member.joined_at.is_(None),
                )
            )
            db.execute(
                delete(Invite).where(
                    Invite.queue_item_id == item.id,
                    Invite.email.in_(emails_to_delete),
                )
            )

    # SYNC_BILLING chỉ chạy khi user chủ động trigger từ dashboard (WorkspaceLayout /
    # Workspaces "Sync billing") hoặc extension popup (POST /queue/sync-billing).
    # Không auto-chain sau INVITE_MEMBER / REMOVE_MEMBER / REVOKE_INVITES.
    log_event(
        db,
        actor_type="EXTENSION",
        actor_label=f"workspace:{workspace.name}",
        action=f"QUEUE_UPDATED:{item.type}"
        + (":RECONCILED" if reconcile_note else ""),
        result=effective_status
        if effective_status in ("COMPLETED", "FAILED")
        else "PENDING",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        data={
            "status": effective_status,
            "error_code": body.error_code,
            "error_message": body.error_message,
            "reconciled": bool(reconcile_note),
        },
        commit=False,
    )
    db.commit()
    db.refresh(item)
    return item


@router.post("/{item_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
def cancel_task(
    item_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Dashboard user huỷ task đang PENDING hoặc IN_PROGRESS.

    Use case: task treo lâu (extension không pick được, hoặc execution hang) →
    user bấm Huỷ thay vì chờ vô hạn.

    Quyền: super-admin huỷ mọi task; sub-admin chỉ huỷ task mình tạo
    (created_by_id = user.id). Task đã COMPLETED/FAILED → 400 (terminal).
    """
    item = db.get(QueueItem, item_id)
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task không tồn tại"
        )
    if item.status in ("COMPLETED", "FAILED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Task đã ở trạng thái terminal: {item.status}",
        )
    if not user.is_super_admin and item.created_by_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin hoặc người tạo task mới huỷ được",
        )
    item.status = "FAILED"
    item.error_code = "USER_CANCELED"
    item.error_message = f"Huỷ bởi {user.email}"
    item.completed_at = datetime.now(timezone.utc)
    db.add(item)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action=f"QUEUE_CANCELED:{item.type}",
        result="FAILED",
        target_type="QUEUE_ITEM",
        target_id=str(item.id),
        commit=False,
    )
    db.commit()
    return {"id": str(item.id), "status": "FAILED"}


@router.patch("/{item_id}/progress", response_model=QueueOut)
def update_progress(
    item_id: UUID,
    body: QueueProgressUpdate,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> QueueItem:
    """Extension báo progress real-time, KHÔNG audit log từng tick (tránh spam)."""
    item = db.get(QueueItem, item_id)
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Queue item không tồn tại"
        )
    if item.workspace_id != workspace.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Queue item không thuộc workspace của API key này",
        )
    item.progress = body.progress
    db.add(item)
    db.commit()
    db.refresh(item)
    return item
