"""Duyệt yêu cầu ĐỔI HẠN DÙNG (subscription change approval) — toàn cục cho admin.

⚠️ ĐỌC `subscription_requests.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Song song với luồng duyệt thanh toán (added_members.py), nhưng cho việc đổi hạn dùng:
  - GET  /pending-count    → badge chuông (số yêu cầu chờ duyệt)
  - GET  /pending          → danh sách thông báo cho dropdown chuông
  - POST /approve          → super-admin duyệt (áp pending) / từ chối (clear)

Yêu cầu được TẠO ở members/subscription.py khi SUB-ADMIN gọi PATCH subscription.
Super-admin tự đổi = áp ngay, không đi qua đây.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.audit import log_event
from app.deps import get_current_user, get_session
from app.models import Member, User
from app.routers.members._shared import SUBSCRIPTION_DAYS_PER_MONTH
from app.schemas import SubscriptionApproveIn, SubscriptionRequestNotice

router = APIRouter(
    prefix="/api/v1/subscription-requests", tags=["subscription-requests"]
)


@router.get("/pending-count", response_model=dict)
def pending_subscription_count(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Số yêu cầu đổi hạn dùng đang chờ super-admin duyệt → badge chuông.

    Sub-admin không duyệt → luôn 0 (không hiện badge).
    """
    if not user.is_super_admin:
        return {"count": 0}
    count = db.execute(
        select(func.count())
        .select_from(Member)
        .where(
            Member.status != "removed",
            Member.subscription_request_status == "requested",
        )
    ).scalar_one()
    return {"count": count}


@router.get("/pending", response_model=list[SubscriptionRequestNotice])
def pending_subscription_requests(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[SubscriptionRequestNotice]:
    """Danh sách yêu cầu đổi hạn dùng đang chờ (thông báo cho super-admin).

    Mỗi dòng: ai gửi, email, workspace, hạn hiện tại → hạn đề xuất. Mới nhất trước.
    Sub-admin → [].
    """
    if not user.is_super_admin:
        return []
    stmt = (
        select(Member)
        .options(
            selectinload(Member.workspace),
            selectinload(Member.subscription_requested_by),
            selectinload(Member.invited_by),
        )
        .where(
            Member.status != "removed",
            Member.subscription_request_status == "requested",
        )
        .order_by(Member.subscription_requested_at.desc().nullslast())
    )
    notices: list[SubscriptionRequestNotice] = []
    for member in db.execute(stmt).scalars():
        requester = member.subscription_requested_by or member.invited_by
        notices.append(
            SubscriptionRequestNotice(
                member_id=member.id,
                email=member.email,
                workspace_name=member.workspace.name if member.workspace else None,
                requested_by_username=requester.username if requester else None,
                requested_at=member.subscription_requested_at,
                current_end_at=member.subscription_end_at,
                requested_end_at=member.pending_subscription_end_at,
                requested_months=member.pending_subscription_months,
            )
        )
    return notices


@router.post("/approve", response_model=dict)
def approve_subscription_requests(
    body: SubscriptionApproveIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Super-admin DUYỆT (approve=True) hoặc TỪ CHỐI (approve=False) yêu cầu đổi hạn.

    CHỈ super-admin. approve=True: áp pending_subscription_* vào subscription_* +
    clear request. approve=False: clear request, giữ nguyên hạn cũ. Chỉ tác động
    member đang 'requested' (khác → bỏ qua, không tính count).
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được duyệt đổi hạn dùng",
        )
    members = list(
        db.execute(select(Member).where(Member.id.in_(body.member_ids))).scalars()
    )
    now = datetime.now(timezone.utc)
    updated_ids: list[str] = []
    for member in members:
        if member.subscription_request_status != "requested":
            continue
        if body.approve:
            member.subscription_months = member.pending_subscription_months
            member.subscription_end_at = member.pending_subscription_end_at
            # Suy ngược ngày mua (mốc neo) = hạn - months×30 để mở lại modal hiển thị
            # đúng ngày mua sub-admin đã đặt. None khi vô thời hạn.
            if (
                member.pending_subscription_end_at is not None
                and member.pending_subscription_months is not None
            ):
                member.subscription_purchased_at = (
                    member.pending_subscription_end_at
                    - timedelta(
                        days=member.pending_subscription_months
                        * SUBSCRIPTION_DAYS_PER_MONTH
                    )
                )
            else:
                member.subscription_purchased_at = None
        # approve=False: giữ nguyên subscription_* hiện tại.
        member.subscription_request_status = "none"
        member.pending_subscription_months = None
        member.pending_subscription_end_at = None
        member.subscription_requested_at = None
        member.subscription_requested_by_id = None
        updated_ids.append(str(member.id))

    if updated_ids:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_SUBSCRIPTION_CHANGE_APPROVED"
            if body.approve
            else "MEMBER_SUBSCRIPTION_CHANGE_REJECTED",
            result="OK",
            target_type="MEMBER",
            target_id=updated_ids[0] if len(updated_ids) == 1 else None,
            data={
                "approve": body.approve,
                "count": len(updated_ids),
                "member_ids": updated_ids,
                "approved_at": now.isoformat(),
            },
            commit=False,
        )
        db.commit()
    return {"count": len(updated_ids), "approve": body.approve}
