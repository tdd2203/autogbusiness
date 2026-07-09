"""Chức năng: CHANGE EMAIL (đổi email member — giữ nguyên hạn dùng cũ).

⚠️ ĐỌC `change-email.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoint:
  - POST /{member_id}/change-email → change_member_email

Nghiệp vụ: khách đổi email. KHÔNG được cấp hạn mới — email mới phải kế thừa
y nguyên `subscription_end_at` (và subscription_months) của email cũ. Đổi email
= 2 action vật lý trên ChatGPT: (1) XOÁ email cũ, (2) MỜI email mới → enqueue
REMOVE_MEMBER rồi INVITE_MEMBER (queue FIFO: xoá trước, mời sau → trả seat trước
khi mời). Vì là thay thế 1-đổi-1 (net seat = 0) nên KHÔNG chạy seat guard.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import assert_workspace_access, get_session, require_permission
from app.models import Invite, Member, QueueItem, User
from app.permissions import Permission
from app.schemas import MemberChangeEmailIn, MemberOut
from app.sse import publish_task_event

from ._shared import router, _get_workspace_or_404, _member_or_404_visible


@router.post(
    "/{member_id}/change-email",
    response_model=MemberOut,
    status_code=status.HTTP_201_CREATED,
)
def change_member_email(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberChangeEmailIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Đổi email cho 1 member: xoá email cũ + mời email mới, GIỮ NGUYÊN hạn dùng.

    Cần CẢ quyền mời (MEMBER_INVITE) lẫn xoá (MEMBER_REMOVE) vì sinh ra 2 action.
    Trả về Member MỚI (email mới, status=pending) để dashboard cập nhật bảng.
    """
    ws = _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    # Đổi email cũng là 1 thao tác xoá → yêu cầu thêm quyền remove (require_permission
    # ở trên đã ép MEMBER_INVITE; kiểm tra remove ở đây để không cấp lén quyền xoá).
    if not user.is_super_admin and Permission.MEMBER_REMOVE.value not in (
        user.permissions or []
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Đổi email cần cả quyền mời và quyền xoá thành viên",
        )

    old = _member_or_404_visible(db, workspace_id, member_id, user)
    new_email = body.new_email.lower()

    if old.status == "removed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Không thể đổi email cho thành viên đã bị xoá",
        )
    if new_email == old.email.lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email mới trùng với email hiện tại",
        )

    # Email mới KHÔNG được trùng member đang hoạt động/chờ khác trong workspace.
    existing_new = db.execute(
        select(Member).where(
            Member.workspace_id == workspace_id, Member.email == new_email
        )
    ).scalar_one_or_none()
    if existing_new and existing_new.status != "removed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email mới đã là thành viên trong workspace",
        )

    # Hạn dùng kế thừa Y NGUYÊN từ email cũ — KHÔNG tính lại. Kế thừa CẢ mốc neo
    # "Ngày gia hạn" (subscription_purchased_at) để cột hiển thị KHỚP với hạn (hết hạn
    # = gia hạn + 30); nếu bỏ, cột gia hạn fallback last_invited_at=now sẽ lệch hạn cũ.
    carried_months = old.subscription_months
    carried_end = old.subscription_end_at
    carried_purchased = old.subscription_purchased_at
    role = old.chatgpt_role or "member"
    old_email = old.email
    now = datetime.now(timezone.utc)

    # (1) XOÁ email cũ — enqueue trước để queue FIFO trả seat trước khi mời.
    remove_qi = QueueItem(
        type="REMOVE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={"member_id": str(old.id), "email": old_email},
        created_by_id=user.id,
    )
    db.add(remove_qi)
    # (2) MỜI email mới.
    invite_qi = QueueItem(
        type="INVITE_MEMBER",
        status="PENDING",
        workspace_id=workspace_id,
        payload={
            "email": new_email,
            "role": role,
            "verified_domain": ws.verified_domain,
        },
        created_by_id=user.id,
    )
    db.add(invite_qi)
    db.flush()

    # Email cũ → removed ngay trong DB (extension sẽ thực thi xoá trên ChatGPT).
    old.status = "removed"

    # Tạo/cập nhật member email mới với hạn dùng cũ. Giữ chủ sở hữu (invited_by)
    # của member cũ — đây là thay thế, không phải lời mời mới của admin thao tác.
    if existing_new:
        member = existing_new
        member.status = "pending"
        member.chatgpt_role = role
        member.invited_by_user_id = old.invited_by_user_id
        member.subscription_months = carried_months
        member.subscription_purchased_at = carried_purchased
        member.subscription_end_at = carried_end
        member.last_invited_at = now
    else:
        member = Member(
            workspace_id=workspace_id,
            email=new_email,
            chatgpt_role=role,
            status="pending",
            invited_by_user_id=old.invited_by_user_id,
            subscription_months=carried_months,
            subscription_purchased_at=carried_purchased,
            subscription_end_at=carried_end,
            last_invited_at=now,
        )
        db.add(member)

    db.add(
        Invite(
            workspace_id=workspace_id,
            email=new_email,
            role=role,
            status="pending",
            queue_item_id=invite_qi.id,
            invited_by_user_id=old.invited_by_user_id,
        )
    )
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_EMAIL_CHANGED",
        result="PENDING",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "old_email": old_email,
            "new_email": new_email,
            "old_member_id": str(old.id),
            "role": role,
            "subscription_months": carried_months,
            "subscription_end_at": carried_end.isoformat() if carried_end else None,
            "remove_queue_item_id": str(remove_qi.id),
            "invite_queue_item_id": str(invite_qi.id),
        },
        commit=False,
    )
    db.commit()
    db.refresh(member)

    # Đánh thức extension cho cả 2 task.
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(remove_qi.id),
            "task_type": "REMOVE_MEMBER",
        },
    )
    publish_task_event(
        workspace_id,
        {
            "type": "task-available",
            "task_id": str(invite_qi.id),
            "task_type": "INVITE_MEMBER",
        },
    )
    return member
