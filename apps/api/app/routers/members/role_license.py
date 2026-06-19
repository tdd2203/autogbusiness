"""Chức năng: CHANGE ROLE & LICENSE TYPE (đổi role / loại giấy phép).

⚠️ ĐỌC `role_license.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoints:
  - PATCH /{member_id}/role             → change_member_role          (super-admin)
  - PATCH /{member_id}/license-type     → change_member_license_type  (super-admin)
  - POST  /bulk-change-license-type     → bulk_change_license_type    (MEMBER_CHANGE_ROLE)
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    enforce_command_spam,
    get_session,
    require_permission,
    require_super_admin,
)
from app.models import Member, QueueItem, User
from app.permissions import Permission
from app.sse import publish_task_event
from app.schemas import (
    MemberBulkChangeLicenseTypeIn,
    MemberChangeLicenseTypeIn,
    MemberChangeRoleIn,
)

from ._shared import router, _get_workspace_or_404, _member_or_404_visible, _visibility_filter


@router.post("/bulk-change-license-type", status_code=status.HTTP_202_ACCEPTED)
def bulk_change_license_type(
    workspace_id: UUID,
    body: MemberBulkChangeLicenseTypeIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_CHANGE_ROLE)),
) -> dict:
    """Đổi giấy phép hàng loạt → enqueue 1 CHANGE_LICENSE_TYPE task cho MỖI member.

    Mirror bulk-remove: extension chỉ đổi được 1 member / lần (mở menu '...' trên
    row) nên mỗi member = 1 task riêng. Chọn bằng `member_ids` (checkbox) và/hoặc
    `emails`. Chỉ áp member status active; bỏ qua member đã có đúng license_type
    (không tạo task thừa). Áp visibility (sub-admin chỉ đụng member mình mời).
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)

    emails_lower = {e.strip().lower() for e in body.emails if e.strip()}
    if not body.member_ids and not emails_lower:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cần ít nhất 1 member_id hoặc email để đổi giấy phép",
        )

    conds = []
    if body.member_ids:
        conds.append(Member.id.in_(body.member_ids))
    if emails_lower:
        conds.append(func.lower(Member.email).in_(emails_lower))

    stmt = select(Member).where(
        Member.workspace_id == workspace_id,
        Member.status == "active",
        or_(*conds),
    )
    stmt = _visibility_filter(stmt, user)
    targets = {m.id: m for m in db.execute(stmt).scalars()}

    enqueued: list[str] = []
    already: list[str] = []
    for member in targets.values():
        # Bỏ qua member đã đúng license rồi — không tạo task thừa.
        if member.license_type == body.new_license_type:
            already.append(member.email)
            continue
        queue_item = QueueItem(
            type="CHANGE_LICENSE_TYPE",
            status="PENDING",
            workspace_id=workspace_id,
            payload={
                "member_id": str(member.id),
                "email": member.email,
                "new_license_type": body.new_license_type,
                "old_license_type": member.license_type,
            },
            created_by_id=user.id,
        )
        db.add(queue_item)
        db.flush()
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_BULK_CHANGE_LICENSE_TYPE_QUEUED",
            result="PENDING",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "workspace_id": str(workspace_id),
                "email": member.email,
                "old_license_type": member.license_type,
                "new_license_type": body.new_license_type,
                "queue_item_id": str(queue_item.id),
            },
            commit=False,
        )
        enqueued.append(member.email)

    if enqueued:
        db.commit()
        for email in enqueued:
            publish_task_event(
                workspace_id,
                {
                    "type": "task-available",
                    "task_type": "CHANGE_LICENSE_TYPE",
                    "email": email,
                },
            )

    matched_lower = {m.email.lower() for m in targets.values()}
    skipped = sorted(emails_lower - matched_lower)
    return {
        "workspace_id": str(workspace_id),
        "count": len(enqueued),
        "emails": enqueued,
        "already": already,
        "skipped": skipped,
    }


@router.patch("/{member_id}/role", status_code=status.HTTP_202_ACCEPTED)
def change_member_role(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberChangeRoleIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    # Chống spam: cùng (CHANGE_ROLE, email) lặp >3 lần liên tiếp → cấm 10 phút.
    enforce_command_spam(db, user, "CHANGE_ROLE", member.email)

    queue_item = QueueItem(
        type="CHANGE_ROLE",
        status="PENDING",
        workspace_id=workspace_id,
        payload={
            "member_id": str(member.id),
            "email": member.email,
            "new_role": body.new_role,
            "old_role": member.chatgpt_role,
        },
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_CHANGE_ROLE_QUEUED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "old_role": member.chatgpt_role,
            "new_role": body.new_role,
            "queue_item_id": str(queue_item.id),
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {"type": "task-available", "task_id": str(queue_item.id), "task_type": "CHANGE_ROLE"},
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}


@router.patch("/{member_id}/license-type", status_code=status.HTTP_202_ACCEPTED)
def change_member_license_type(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberChangeLicenseTypeIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    """Đổi loại suất cấp phép (ChatGPT/Codex) của 1 member.

    Tạo QueueItem CHANGE_LICENSE_TYPE → extension mở menu '...' trên row member →
    'Thay đổi loại giấy phép' → chọn ChatGPT/Codex. Sau khi extension báo COMPLETED,
    queue.update_task sync Member.license_type trong DB.
    """
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    # Chống spam: cùng (CHANGE_LICENSE_TYPE, email) lặp >3 lần liên tiếp → cấm 10 phút.
    enforce_command_spam(db, user, "CHANGE_LICENSE_TYPE", member.email)

    queue_item = QueueItem(
        type="CHANGE_LICENSE_TYPE",
        status="PENDING",
        workspace_id=workspace_id,
        payload={
            "member_id": str(member.id),
            "email": member.email,
            "new_license_type": body.new_license_type,
            "old_license_type": member.license_type,
        },
        created_by_id=user.id,
    )
    db.add(queue_item)
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_CHANGE_LICENSE_TYPE_QUEUED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "old_license_type": member.license_type,
            "new_license_type": body.new_license_type,
            "queue_item_id": str(queue_item.id),
        },
        commit=False,
    )
    db.commit()
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(queue_item.id),
            "task_type": "CHANGE_LICENSE_TYPE",
        },
    )
    return {"queue_item_id": str(queue_item.id), "status": "queued"}
