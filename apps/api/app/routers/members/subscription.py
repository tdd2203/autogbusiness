"""Chức năng: MEMBER SUBSCRIPTION (đổi hạn dùng — CÓ DUYỆT).

⚠️ ĐỌC `subscription.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoint:
  - PATCH /{member_id}/subscription → update_member_subscription

Đổi hạn dùng theo SỐ THÁNG hoặc NGÀY HẾT HẠN cụ thể (xem MemberUpdateSubscriptionIn).
Quy tắc duyệt (theo yêu cầu user):
  - SUPER-ADMIN: áp dụng NGAY (tự duyệt).
  - SUB-ADMIN : KHÔNG áp dụng ngay → tạo YÊU CẦU chờ super-admin duyệt + thông báo.
    Super-admin duyệt qua subscription_requests.py.
"""

from datetime import datetime, timedelta, timezone
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
    SUBSCRIPTION_DAYS_PER_MONTH,
    _end_from_purchase,
    _extend_subscription_end,
    _get_workspace_or_404,
    _member_or_404_visible,
)


def _resolve_end_at(member: Member, body: MemberUpdateSubscriptionIn) -> datetime | None:
    """Tính ngày hết hạn mục tiêu.

    Ưu tiên:
    1. `subscription_end_at` có giá trị → dùng TRỰC TIẾP (dự phòng caller gửi ngày cụ
       thể, vd bulk-set-expiry). BE không tính lại.
    2. `subscription_purchased_at` + `subscription_months` = NEO THEO NGÀY MUA (đường
       chính của modal): hạn = ngày mua + N×30 ngày CHÍNH XÁC tới giây.
    3. Chỉ `subscription_months` = N → GIA HẠN CỘNG DỒN:
       - Còn hạn (end_at > now) → cộng tiếp từ hạn cũ: `end_at + N×30` ngày (giữ giờ).
       - Hết hạn / chưa có hạn → BÂY GIỜ + N×30 ngày.
    4. Tất cả None → None (VÔ THỜI HẠN).
    """
    if body.subscription_end_at is not None:
        return body.subscription_end_at
    if body.subscription_months is None:
        return None
    if body.subscription_purchased_at is not None:
        return _end_from_purchase(
            body.subscription_purchased_at, body.subscription_months
        )
    now = datetime.now(timezone.utc)
    if member.subscription_end_at is not None and member.subscription_end_at > now:
        return _extend_subscription_end(
            member.subscription_end_at, body.subscription_months
        )
    return _end_from_purchase(now, body.subscription_months)


def _resolve_purchased_at(
    body: MemberUpdateSubscriptionIn,
    target_end: datetime | None,
    target_months: int | None,
) -> datetime | None:
    """Ngày mua để LƯU lại (mốc neo, dùng làm mặc định khi mở lại modal).

    Ưu tiên ngày mua client gửi. Nếu không có → suy ngược từ hạn - months×30 (đúng mốc
    đã dùng để tính hạn, kể cả nhánh cộng dồn). None khi vô thời hạn.
    """
    if body.subscription_purchased_at is not None:
        return body.subscription_purchased_at
    if target_months is None or target_end is None:
        return None
    return target_end - timedelta(days=target_months * SUBSCRIPTION_DAYS_PER_MONTH)


@router.patch("/{member_id}/subscription", response_model=MemberOut)
def update_member_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberUpdateSubscriptionIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Đổi hạn dùng. Super-admin áp ngay; sub-admin tạo yêu cầu chờ duyệt.

    Trả về Member: nếu super-admin → subscription_* đã đổi; nếu sub-admin →
    subscription_* GIỮ NGUYÊN, subscription_request_status='requested' + pending_*
    chứa giá trị đề xuất (UI hiện nhãn "chờ duyệt").
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    target_end = _resolve_end_at(member, body)
    # "Theo ngày cụ thể" = chỉ gửi hạn, KHÔNG gửi số tháng → GIỮ NGUYÊN số tháng &
    # mốc neo (subscription_purchased_at) cũ, chỉ đặt lại hạn (yêu cầu user 2026-07-08).
    date_only = body.subscription_end_at is not None and body.subscription_months is None
    target_months = member.subscription_months if date_only else body.subscription_months
    now = datetime.now(timezone.utc)

    if user.is_super_admin:
        # Tự duyệt — áp ngay + xoá mọi yêu cầu đang chờ (nếu có).
        old_months = member.subscription_months
        old_end = member.subscription_end_at
        member.subscription_months = target_months
        member.subscription_end_at = target_end
        # Date-only → giữ mốc neo cũ; ngược lại suy/đặt lại theo body.
        if not date_only:
            member.subscription_purchased_at = _resolve_purchased_at(
                body, target_end, target_months
            )
        member.subscription_request_status = "none"
        member.pending_subscription_months = None
        member.pending_subscription_end_at = None
        member.subscription_requested_at = None
        member.subscription_requested_by_id = None
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
                "new_months": target_months,
                "old_end_at": old_end.isoformat() if old_end else None,
                "new_end_at": target_end.isoformat() if target_end else None,
            },
            commit=False,
        )
    else:
        # Sub-admin — KHÔNG áp dụng, tạo yêu cầu chờ duyệt + thông báo admin.
        member.subscription_request_status = "requested"
        member.pending_subscription_months = target_months
        member.pending_subscription_end_at = target_end
        member.subscription_requested_at = now
        member.subscription_requested_by_id = user.id
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_SUBSCRIPTION_CHANGE_REQUESTED",
            result="PENDING",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "workspace_id": str(workspace_id),
                "email": member.email,
                "current_end_at": member.subscription_end_at.isoformat()
                if member.subscription_end_at
                else None,
                "requested_months": target_months,
                "requested_end_at": target_end.isoformat() if target_end else None,
            },
            commit=False,
        )

    db.commit()
    db.refresh(member)
    return member
