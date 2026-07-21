"""Chức năng: REMOVE MEMBER (xoá thành viên) — đơn / hàng loạt / cleanup hết hạn.

⚠️ ĐỌC `remove.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - POST   /cleanup-expired   → cleanup_expired_members
  - POST   /bulk-remove       → bulk_remove_members
  - DELETE /{member_id}       → remove_member
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    enforce_command_spam,
    get_session,
    require_permission,
)
from app.models import Member, QueueItem, User
from app.permissions import Permission
from app.schemas import MemberBulkRemoveIn
from app.sse import publish_task_event

from ._shared import (
    router,
    SUBSCRIPTION_GRACE_AFTER_EXPIRY,
    _get_workspace_or_404,
    _has_open_remove_task,
    _member_or_404_visible,
    _visibility_filter,
)


def _build_removal_task(
    member: Member, created_by_id: UUID | None, workspace_id: UUID
) -> tuple[QueueItem, str]:
    """Chọn LOẠI task gỡ theo trạng thái member trên ChatGPT (khớp change_email.py +
    yêu cầu user 2026-07-13):
      - `pending` (chờ tham gia) → **REVOKE_INVITES**: extension thu hồi ở tab "Lời mời
        đang chờ xử lý" TRƯỚC; nếu email không có ở đó (đã kịp chấp nhận → thành active)
        thì tự fallback xoá ở tab "Người dùng". Payload `emails` (executeRevokeInvites
        nhận list).
      - `active`/khác (đã tham gia) → **REMOVE_MEMBER**: vào THẲNG tab "Người dùng",
        không dò tab Lời mời.
    Nhờ đó DB không còn mark removed member pending mà lời mời vẫn treo trên ChatGPT
    (bug cũ: REMOVE_MEMBER cho pending → tab Người dùng không thấy → MEMBER_NOT_IN_
    WORKSPACE → mark removed dù chưa thu hồi). Trả (queue_item, task_type).

    `created_by_id`: user bấm lệnh (endpoint) hoặc người mời member (scheduler nền,
    xem main.py) — cột nullable, chỉ dùng để truy vết chủ task."""
    if member.status == "pending":
        qi = QueueItem(
            type="REVOKE_INVITES",
            status="PENDING",
            workspace_id=workspace_id,
            payload={"emails": [member.email.lower()]},
            created_by_id=created_by_id,
        )
        return qi, "REVOKE_INVITES"
    qi = QueueItem(
        type="REMOVE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"member_id": str(member.id), "email": member.email},
        created_by_id=created_by_id,
    )
    return qi, "REMOVE_MEMBER"


@router.post("/cleanup-expired", status_code=status.HTTP_202_ACCEPTED)
def cleanup_expired_members(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    """Tìm các member đã hết hạn (`subscription_end_at <= now`, active/pending)
    trong workspace → enqueue 1 REMOVE_MEMBER task cho mỗi email + audit.

    Không còn ân hạn (`SUBSCRIPTION_GRACE_AFTER_EXPIRY = 0`, yêu cầu user
    2026-07-10): hết hạn là xoá ngay, không chờ. Trả về list email đã enqueue.
    Dashboard có thể gọi để admin "1 click remove tất cả expired". Cùng rule với
    scheduler ở `main.py` (background timer dọn định kỳ mọi workspace).
    """
    _get_workspace_or_404(db, workspace_id)
    # KHÔNG gate assert_workspace_access: gán workspace CHỈ giới hạn việc ADD (mời).
    # Xoá/dọn thành viên mình ĐÃ add vẫn cho phép kể cả khi sub-admin bị gỡ khỏi
    # workspace — visibility filter dưới đây khoá theo invited_by_user_id nên chỉ
    # dọn được member mình mời, không rò rỉ. Xem đầu file remove.py.
    now = datetime.now(timezone.utc)
    cutoff = now - SUBSCRIPTION_GRACE_AFTER_EXPIRY
    expired = (
        db.execute(
            select(Member).where(
                Member.workspace_id == workspace_id,
                Member.status.in_(("active", "pending")),
                Member.subscription_end_at.isnot(None),
                Member.subscription_end_at <= cutoff,
            )
        )
        .scalars()
        .all()
    )
    # Visibility: sub-admin chỉ thấy/cleanup member họ invite
    if not user.is_super_admin:
        expired = [m for m in expired if m.invited_by_user_id == user.id]

    enqueued: list[str] = []
    events: list[tuple[str, str]] = []  # (email, task_type) để publish sau commit
    for member in expired:
        # Idempotent: bỏ qua nếu member đã có task gỡ đang mở (REMOVE_MEMBER hoặc
        # REVOKE_INVITES — tránh đẻ task trùng khi admin bấm 2 lần / scheduler vừa
        # enqueue). Xem _has_open_remove_task + remove.md.
        if _has_open_remove_task(db, member):
            continue
        # pending → REVOKE_INVITES (tab Lời mời trước), active → REMOVE_MEMBER.
        queue_item, task_type = _build_removal_task(member, user.id, workspace_id)
        db.add(queue_item)
        db.flush()
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_EXPIRED_REMOVE_QUEUED",
            result="PENDING",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "workspace_id": str(workspace_id),
                "email": member.email,
                "task_type": task_type,
                "subscription_end_at": member.subscription_end_at.isoformat()
                if member.subscription_end_at
                else None,
                "queue_item_id": str(queue_item.id),
            },
            commit=False,
        )
        enqueued.append(member.email)
        events.append((member.email, task_type))
    if enqueued:
        db.commit()
        for email, task_type in events:
            publish_task_event(
                workspace_id,
                {"type": "task-available", "task_type": task_type, "email": email},
            )
    return {"workspace_id": str(workspace_id), "count": len(enqueued), "emails": enqueued}


@router.post("/bulk-remove", status_code=status.HTTP_202_ACCEPTED)
def bulk_remove_members(
    workspace_id: UUID,
    body: MemberBulkRemoveIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    """Xoá hàng loạt member → enqueue 1 REMOVE_MEMBER task cho MỖI member.

    Khác bulk-invite (gộp 1 task vì ChatGPT cho paste nhiều email vào 1 dialog):
    extension chỉ remove được 1 member / dialog nên mỗi member = 1 task riêng
    (giống cleanup-expired + DELETE đơn).

    Chọn member bằng `member_ids` (checkbox trong bảng) và/hoặc `emails` (dán
    tay). Backend gộp & dedupe theo member.id, áp visibility (sub-admin chỉ xoá
    member mình mời) và chỉ lấy member status active/pending. id/email không khớp
    → bỏ qua; emails không match trả về trong `skipped` để UI cảnh báo.
    """
    _get_workspace_or_404(db, workspace_id)
    # KHÔNG gate assert_workspace_access — xem cleanup_expired_members ở trên: gán
    # workspace chỉ giới hạn ADD; `_visibility_filter` (invited_by_user_id) đủ khoá.

    emails_lower = {e.strip().lower() for e in body.emails if e.strip()}
    if not body.member_ids and not emails_lower:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cần ít nhất 1 member_id hoặc email để xoá",
        )

    conds = []
    if body.member_ids:
        conds.append(Member.id.in_(body.member_ids))
    if emails_lower:
        conds.append(func.lower(Member.email).in_(emails_lower))

    stmt = select(Member).where(
        Member.workspace_id == workspace_id,
        Member.status.in_(("active", "pending")),
        or_(*conds),
    )
    stmt = _visibility_filter(stmt, user)
    # Dedupe theo id (member có thể khớp cả member_ids lẫn emails).
    targets = {m.id: m for m in db.execute(stmt).scalars()}

    enqueued: list[str] = []
    events: list[tuple[str, str]] = []  # (email, task_type) để publish sau commit
    for member in targets.values():
        # pending → REVOKE_INVITES (tab Lời mời trước), active → REMOVE_MEMBER.
        queue_item, task_type = _build_removal_task(member, user.id, workspace_id)
        db.add(queue_item)
        db.flush()
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_BULK_REMOVE_QUEUED",
            result="PENDING",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "workspace_id": str(workspace_id),
                "email": member.email,
                "task_type": task_type,
                "queue_item_id": str(queue_item.id),
            },
            commit=False,
        )
        enqueued.append(member.email)
        events.append((member.email, task_type))

    if enqueued:
        db.commit()
        for email, task_type in events:
            publish_task_event(
                workspace_id,
                {
                    "type": "task-available",
                    "task_type": task_type,
                    "email": email,
                },
            )

    matched_lower = {m.email.lower() for m in targets.values()}
    skipped = sorted(emails_lower - matched_lower)
    return {
        "workspace_id": str(workspace_id),
        "count": len(enqueued),
        "emails": enqueued,
        "skipped": skipped,
    }


@router.delete("/{member_id}", status_code=status.HTTP_202_ACCEPTED)
def remove_member(
    workspace_id: UUID,
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_REMOVE)),
) -> dict:
    _get_workspace_or_404(db, workspace_id)
    # KHÔNG gate assert_workspace_access — xem cleanup_expired_members ở trên: gán
    # workspace chỉ giới hạn ADD; `_member_or_404_visible` (invited_by_user_id) đủ khoá.
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    # DB là nguồn member đầy đủ: mọi member vào qua web app + SYNC_DATA giữ DB
    # đồng bộ với ChatGPT. Member đã 'removed' → KHÔNG enqueue task: tránh
    # extension đi tìm lại email đó trên ChatGPT (vô ích, tốn thời gian lật hết
    # các trang). Khớp business rule "chỉ active/pending mới xoá" mà bulk-remove
    # và cleanup-expired đã áp sẵn (xem remove.md §4).
    if member.status == "removed":
        return {"status": "already_removed", "email": member.email}

    # Chống spam: cùng (removal, email) lặp >3 lần liên tiếp → cấm 10 phút. Dùng chung
    # 1 bucket "REMOVE_MEMBER" cho cả pending/active (chỉ là khoá rate-limit theo email).
    enforce_command_spam(db, user, "REMOVE_MEMBER", member.email)

    # pending → REVOKE_INVITES (tab Lời mời trước), active → REMOVE_MEMBER (tab Người dùng).
    queue_item, task_type = _build_removal_task(member, user.id, workspace_id)
    db.add(queue_item)
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_REMOVE_QUEUED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "task_type": task_type,
            "queue_item_id": str(queue_item.id),
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": task_type},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}
