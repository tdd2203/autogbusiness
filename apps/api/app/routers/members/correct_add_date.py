"""Chức năng: SỬA "NGÀY GIA HẠN / NGÀY ADD ĐẦU TIÊN" — CHỈ 1 LẦN (super-admin).

⚠️ ĐỌC `correct_add_date.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Neo-lại + tính hạn tuân theo `EXPIRY_RULES.md` §3 — KHÔNG tự chế công thức.

Endpoint:
  - PATCH /{member_id}/add-date → correct_member_add_date

Mốc neo "Ngày gia hạn" (= ngày add đầu tiên với gói mua lần đầu) lưu ở
`subscription_purchased_at`, set khi invite = giờ gửi lệnh mời. Đôi khi ghi sai
(mời lại, lệch giờ…) → super-admin cần sửa TAY. Theo yêu cầu user: sửa được ĐÚNG
1 LẦN rồi KHOÁ (cột `add_date_corrected_at`) để không lạm dụng đẩy hạn tuỳ tiện.

Sửa xong tính lại `subscription_end_at = add_date + tháng×30` (hết hạn = gia hạn +
30) khi member còn gói tháng; member vô thời hạn (months None) chỉ đổi mốc neo.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import assert_workspace_access, get_current_user, get_session
from app.models import Member, User
from app.schemas import MemberCorrectAddDateIn, MemberOut

from ._shared import (
    router,
    _end_from_purchase,
    _get_workspace_or_404,
    _mark_member_paid,
    _member_or_404_visible,
    _rebuild_paid_cycles,
)


@router.patch("/{member_id}/add-date", response_model=MemberOut)
def correct_member_add_date(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberCorrectAddDateIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Member:
    """Sửa mốc neo "Ngày gia hạn" (ngày add đầu tiên) — CHỈ super-admin, CHỈ 1 LẦN.

    409 nếu đã sửa rồi (add_date_corrected_at khác NULL). 403 nếu không phải
    super-admin. Sửa xong: subscription_purchased_at = add_date, tính lại
    subscription_end_at = add_date + tháng×30 (nếu còn gói), khoá add_date_corrected_at.
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được sửa ngày gia hạn",
        )
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    if member.add_date_corrected_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ngày gia hạn đã được sửa 1 lần — không thể sửa lại",
        )

    now = datetime.now(timezone.utc)
    old_purchased = member.subscription_purchased_at
    old_end = member.subscription_end_at

    old_months = member.subscription_months
    member.subscription_purchased_at = body.add_date
    if body.clear_end:
        # Vô thời hạn (modal Đổi hạn dùng, tab "Vô thời hạn") → xoá hạn + số tháng,
        # chỉ giữ mốc neo mới.
        member.subscription_months = None
        member.subscription_end_at = None
    elif body.end_at is not None:
        # "Sự kết hợp" (tab Theo ngày cụ thể): admin seed hạn theo tháng rồi tinh chỉnh
        # ±ngày → đặt THẲNG ngày hết hạn đã chốt, subscription_months = None (hạn thủ công).
        member.subscription_months = None
        member.subscription_end_at = body.end_at
    elif body.months is not None:
        # NEO LẠI cả số tháng (modal Đổi hạn dùng): lưu months mới + hạn = ngày mới +
        # months×30 (KHÔNG cộng dồn). "Số tháng" trên modal tính thẳng từ ngày thêm.
        member.subscription_months = body.months
        member.subscription_end_at = _end_from_purchase(body.add_date, body.months)
    elif member.subscription_months is not None:
        # Gói tháng → hết hạn = ngày gia hạn mới + tháng×30.
        member.subscription_end_at = _end_from_purchase(
            body.add_date, member.subscription_months
        )
    elif old_end is not None:
        # Set hạn TAY (months None) nhưng CÓ hạn cụ thể → GIỮ ĐỘ DÀI: dời hạn theo
        # đúng khoảng cách so với mốc gia hạn cũ (old_purchased ?? last_invited_at ??
        # created_at) để "Hạn dùng" luôn khớp "Ngày gia hạn" (yêu cầu user 2026-07-06).
        # Guard: KHÔNG dời hạn thành quá khứ (giữ hạn cũ nếu bị âm) — tránh gỡ oan member.
        old_anchor = old_purchased or member.last_invited_at or member.created_at
        if old_anchor is not None:
            shifted = body.add_date + (old_end - old_anchor)
            member.subscription_end_at = shifted if shifted > now else old_end
    # else: vô thời hạn thật (end None) → chỉ đổi mốc neo.
    member.add_date_corrected_at = now

    # Re-anchor dời CẢ cửa sổ subscription → dựng lại chu kỳ 1-tháng đã thanh toán
    # theo mốc neo mới (mô hình chốt user 2026-07-13). Xem [[subscription-cycle-model]].
    _rebuild_paid_cycles(db, member, actor_id=user.id, now=now)
    _mark_member_paid(member, now=now, actor_id=user.id)

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="MEMBER_ADD_DATE_CORRECTED",
        result="OK",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "old_purchased_at": old_purchased.isoformat() if old_purchased else None,
            "new_purchased_at": body.add_date.isoformat(),
            "old_months": old_months,
            "new_months": member.subscription_months,
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
