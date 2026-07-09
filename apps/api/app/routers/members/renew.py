"""Chức năng: GIA HẠN (renew) — TỰ PHỤC VỤ, KHÔNG cần duyệt.

⚠️ ĐỌC `subscription.md` (đổi hạn có duyệt) để phân biệt với file này.

Endpoint:
  - POST /{member_id}/renew → renew_member_subscription

Khác PATCH /{member_id}/subscription (subscription.py — CÓ DUYỆT cho sub-admin):
gia hạn (cộng tháng) là quyền TỰ PHỤC VỤ của cả sub-admin lẫn super-admin (yêu cầu
user 2026-07-08). Áp dụng NGAY:
  - Cộng dồn hạn: còn hạn → hạn cũ + N×30 ngày; hết hạn → bây giờ + N×30 ngày.
  - Tạo 1 CHU KỲ mới (MemberSubscriptionCycle) với payment_status='unpaid'.
  - RESET trạng thái thanh toán của member về 'chưa thanh toán' (kể cả đang 'paid')
    + xoá dấu vết paid_*/payment_requested_* → admin phải xác nhận lại từng chu kỳ.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import assert_workspace_access, get_session, require_permission
from app.models import Member, MemberSubscriptionCycle, User
from app.permissions import Permission
from app.schemas import MemberRenewIn, MemberOut

from ._shared import (
    router,
    SUBSCRIPTION_DAYS_PER_MONTH,
    _end_from_purchase,
    _extend_subscription_end,
    _get_workspace_or_404,
    _member_or_404_visible,
)


@router.post("/{member_id}/renew", response_model=MemberOut)
def renew_member_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberRenewIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Gia hạn N tháng — áp dụng NGAY (không duyệt), tạo chu kỳ mới + reset chưa TT."""
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    months = body.months
    now = datetime.now(timezone.utc)
    old_end = member.subscription_end_at
    old_months = member.subscription_months
    old_anchor = member.subscription_purchased_at

    # Vật chất hoá CHU KỲ 1 nếu member chưa có chu kỳ nào (member cũ trước migration
    # đã được backfill; member mời sau migration tạo cycle 1 ngay lần gia hạn đầu để
    # lịch sử liền mạch). Giữ NGUYÊN trạng thái thanh toán hiện có của kỳ đầu.
    if not member.subscription_cycles and old_end is not None:
        member.subscription_cycles.append(
            MemberSubscriptionCycle(
                cycle_number=1,
                months=old_months,
                start_at=old_anchor,
                end_at=old_end,
                payment_status=member.payment_status,
                payment_requested_at=member.payment_requested_at,
                payment_requested_by_id=member.payment_requested_by_id,
                paid_at=member.paid_at,
                paid_marked_by_id=member.paid_marked_by_id,
            )
        )

    # Cộng dồn: còn hạn → nối tiếp hạn cũ; hết hạn/chưa có → tính từ bây giờ.
    if old_end is not None and old_end > now:
        start_at = old_end
        new_end = _extend_subscription_end(old_end, months)
    else:
        start_at = now
        new_end = _end_from_purchase(now, months)

    member.subscription_months = months
    member.subscription_end_at = new_end
    # Mốc neo "Ngày gia hạn" = hạn mới − months×30 (khớp _resolve_purchased_at của
    # subscription.py: mở lại modal hiển thị đúng chu kỳ vừa gia hạn).
    member.subscription_purchased_at = (
        new_end - timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)
        if new_end is not None
        else None
    )

    # Chu kỳ mới — số thứ tự = max hiện có + 1.
    next_number = (
        max((c.cycle_number for c in member.subscription_cycles), default=0) + 1
    )
    member.subscription_cycles.append(
        MemberSubscriptionCycle(
            cycle_number=next_number,
            months=months,
            start_at=start_at,
            end_at=new_end,
            payment_status="unpaid",
        )
    )

    # RESET thanh toán member về chưa thanh toán (yêu cầu user 2026-07-08).
    member.payment_status = "unpaid"
    member.paid_at = None
    member.paid_marked_by_id = None
    member.payment_requested_at = None
    member.payment_requested_by_id = None

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_SUBSCRIPTION_RENEWED",
        result="OK",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "months": months,
            "cycle_number": next_number,
            "old_end_at": old_end.isoformat() if old_end else None,
            "new_end_at": new_end.isoformat() if new_end else None,
        },
        commit=False,
    )

    db.commit()
    db.refresh(member)
    return member
