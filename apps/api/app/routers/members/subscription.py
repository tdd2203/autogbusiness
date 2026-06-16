"""Chức năng: MEMBER SUBSCRIPTION (cập nhật thời hạn subscription).

⚠️ ĐỌC `subscription.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoint:
  - PATCH /{member_id}/subscription → update_member_subscription
"""

from uuid import UUID

from fastapi import Depends
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import assert_workspace_access, get_session, require_permission
from app.models import Member, User
from app.permissions import Permission
from app.schemas import MemberUpdateSubscriptionIn, MemberOut

from ._shared import (
    router,
    _compute_subscription_end,
    _get_workspace_or_404,
    _member_or_404_visible,
)


@router.patch("/{member_id}/subscription", response_model=MemberOut)
def update_member_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberUpdateSubscriptionIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Update subscription_months (extend hoặc đổi vô thời hạn).

    end_at = created_at + months × 30 days. Admin có thể giảm/tăng tự do; mỗi
    lần PATCH ghi audit log để có lịch sử thay đổi.
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    old_months = member.subscription_months
    old_end = member.subscription_end_at
    member.subscription_months = body.subscription_months
    member.subscription_end_at = _compute_subscription_end(
        member.created_at, body.subscription_months
    )

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_SUBSCRIPTION_UPDATED",
        result="OK",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "old_months": old_months,
            "new_months": body.subscription_months,
            "old_end_at": old_end.isoformat() if old_end else None,
            "new_end_at": member.subscription_end_at.isoformat()
            if member.subscription_end_at
            else None,
        },
        commit=False,
    )
    db.commit()
    db.refresh(member)
    return member
