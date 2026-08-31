"""Chức năng: MEMBER SUBSCRIPTION (đổi hạn dùng — TỰ PHỤC VỤ, có tính phí).

⚠️ ĐỌC `subscription.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
⚠️ Ưu tiên tính hạn tuân theo `EXPIRY_RULES.md` §4 — KHÔNG tự chế công thức.

Endpoint:
  - PATCH /{member_id}/subscription → update_member_subscription

Đổi hạn dùng theo SỐ THÁNG hoặc NGÀY HẾT HẠN cụ thể (xem MemberUpdateSubscriptionIn).
Quy tắc (user 2026-07-13 — BỎ DUYỆT, giống Gia hạn):
  - Áp dụng NGAY cho CẢ sub-admin lẫn super-admin (không còn tạo yêu cầu chờ duyệt).
  - Tính phí khi KÉO DÀI hạn (`subscription_fee` = đơn giá/tháng × số tháng kéo dài):
    ví đủ → trừ + áp ngay; ví thiếu → QR (mã ORDER) + 402, chờ webhook trả tiền.
  - Rút ngắn / vô thời hạn / super-admin / non-beta → miễn phí, áp ngay.
  - Endpoint duyệt (subscription_requests.py) còn nhưng DORMANT — không còn request mới.
"""

from datetime import datetime, timedelta, timezone
from math import ceil
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_permission
from app.models import Member, User
from app.permissions import Permission
from app.routers.wallet._shared import get_payment_settings
from app.services import payment_flow, wallet_service
from app.schemas import MemberUpdateSubscriptionIn, MemberOut

from ._shared import (
    router,
    SUBSCRIPTION_DAYS_PER_MONTH,
    _append_paid_cycle,
    _end_from_purchase,
    _ensure_cycles_materialized,
    _extend_subscription_end,
    _get_workspace_or_404,
    _mark_member_paid,
    _member_or_404_visible,
    _months_between,
    _trim_cycles_to_end,
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


def subscription_would_extend(member: Member, body: MemberUpdateSubscriptionIn) -> bool:
    """Đổi hạn này có KÉO DÀI hạn không (để quyết định tính phí — user 2026-07-13:
    "chỉ khi kéo dài hạn"). True khi hạn MỚI > hạn hiện tại (cả hai có giá trị). Vô
    thời hạn (hạn mới None) / hạn hiện tại None / rút ngắn / giữ nguyên → False."""
    target_end = _resolve_end_at(member, body)
    cur = member.subscription_end_at
    return target_end is not None and cur is not None and target_end > cur


def _billable_extension_months(member: Member, body: MemberUpdateSubscriptionIn) -> int:
    """Số THÁNG tính phí cho lần kéo dài (đơn vị 30 ngày, làm tròn LÊN, tối thiểu 1).
    'Theo số tháng' = đúng số tháng cộng thêm; 'theo ngày' = (hạn mới − hạn cũ)/30."""
    if body.subscription_months is not None:
        return max(1, int(body.subscription_months))
    target_end = _resolve_end_at(member, body)
    cur = member.subscription_end_at
    if target_end is not None and cur is not None and target_end > cur:
        days = (target_end - cur).total_seconds() / 86400.0
        return max(1, ceil(days / SUBSCRIPTION_DAYS_PER_MONTH))
    return 0


def subscription_fee(
    member: Member, user: User, default_fee: int, body: MemberUpdateSubscriptionIn
) -> int:
    """Phí đổi hạn = đơn giá/tháng (2 tầng) × số tháng KÉO DÀI; 0 nếu không kéo dài
    (rút ngắn / vô thời hạn / giữ nguyên). Dùng chung endpoint + webhook replay."""
    if not subscription_would_extend(member, body):
        return 0
    months = _billable_extension_months(member, body)
    return payment_flow.effective_fee_for_months(member.fee_vnd, user, default_fee, months)


def perform_subscription_core(
    db: Session, user: User, member: Member, body: MemberUpdateSubscriptionIn
) -> Member:
    """Áp đổi hạn dùng NGAY cho member (tự phục vụ — feature 003 user 2026-07-13 bỏ
    duyệt). KHÔNG trừ phí, KHÔNG commit — caller lo. Dùng chung endpoint + webhook
    replay (sau thanh toán QR)."""
    now = datetime.now(timezone.utc)
    target_end = _resolve_end_at(member, body)
    # "Theo ngày cụ thể" = chỉ gửi hạn, KHÔNG gửi số tháng → GIỮ NGUYÊN số tháng &
    # mốc neo cũ, chỉ đặt lại hạn (yêu cầu user 2026-07-08).
    date_only = body.subscription_end_at is not None and body.subscription_months is None
    target_months = member.subscription_months if date_only else body.subscription_months
    old_months = member.subscription_months
    old_end = member.subscription_end_at

    # Vật chất hoá các chu kỳ hiện có (nếu chưa có) TRƯỚC khi đổi hạn, để đồng bộ
    # dựa trên hạn cũ liền mạch. Xem _ensure_cycles_materialized.
    _ensure_cycles_materialized(member, now=now, actor_id=user.id)

    member.subscription_months = target_months
    member.subscription_end_at = target_end
    if not date_only:
        member.subscription_purchased_at = _resolve_purchased_at(
            body, target_end, target_months
        )

    # ── Đồng bộ CHU KỲ theo hạn mới (mô hình: 1 LẦN MUA = 1 chu kỳ, đã thanh toán) ──
    # Trước đây đổi hạn KHÔNG đụng cycles → "Kỳ thanh toán" kẹt ở cửa sổ cũ, bất hợp
    # lý khi còn hạn (bug user báo 2026-07-13). Giờ:
    #   - Vô thời hạn → xoá hết kỳ.
    #   - Kéo dài (hạn mới > hạn cũ) → nối 1 kỳ (gộp số tháng kéo dài) từ hạn cũ → mới.
    #   - Từ vô thời hạn thành có hạn → dựng 1 kỳ từ mốc neo → hạn mới.
    #   - Rút ngắn / giữ nguyên → cắt kỳ về hạn mới.
    if target_end is None:
        _trim_cycles_to_end(member, None, now=now)
    elif old_end is not None and target_end > old_end:
        ext_months = (
            body.subscription_months
            if body.subscription_months is not None
            else _months_between(old_end, target_end)
        )
        _append_paid_cycle(
            member,
            start_at=old_end,
            end_at=target_end,
            months=ext_months,
            actor_id=user.id,
            now=now,
        )
    elif old_end is None:
        start = member.subscription_purchased_at or now
        _append_paid_cycle(
            member,
            start_at=start,
            end_at=target_end,
            months=body.subscription_months,
            actor_id=user.id,
            now=now,
        )
    else:
        _trim_cycles_to_end(member, target_end, now=now)
    _mark_member_paid(member, now=now, actor_id=user.id)

    # Bỏ duyệt → không còn trạng thái chờ; dọn dấu vết yêu cầu cũ (nếu có).
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
            "workspace_id": str(member.workspace_id),
            "email": member.email,
            "old_months": old_months,
            "new_months": target_months,
            "old_end_at": old_end.isoformat() if old_end else None,
            "new_end_at": target_end.isoformat() if target_end else None,
        },
        commit=False,
    )
    return member


def _create_subscription_order_and_raise(
    db: Session,
    user: User,
    workspace_id: UUID,
    member: Member,
    body: MemberUpdateSubscriptionIn,
    amount: int,
    settings_row,
) -> None:
    """Ví thiếu → tạo hoá đơn QR đổi hạn + HTTP 402. KHÔNG áp đổi hạn (chờ trả tiền)."""
    if not payment_flow.bank_configured(settings_row):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "INSUFFICIENT_BALANCE",
                "message": "Số dư Ví không đủ và chưa cấu hình thanh toán QR. Vui lòng nạp thêm.",
                "required": amount,
            },
        )
    order = payment_flow.create_order(
        db,
        user,
        kind="subscription",
        amount=amount,
        payload={
            "member_id": str(member.id),
            "subscription_months": body.subscription_months,
            "subscription_purchased_at": body.subscription_purchased_at.isoformat()
            if body.subscription_purchased_at
            else None,
            "subscription_end_at": body.subscription_end_at.isoformat()
            if body.subscription_end_at
            else None,
        },
        workspace_id=workspace_id,
    )
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="PAYMENT_ORDER_CREATED",
        result="PENDING",
        target_type="PAYMENT_ORDER",
        target_id=str(order.id),
        data={
            "kind": "subscription",
            "amount_vnd": amount,
            "member_id": str(member.id),
            "email": member.email,
            "ref_code": order.ref_code,
        },
        commit=False,
    )
    db.commit()
    payment_flow.raise_payment_required(settings_row, order)


@router.patch("/{member_id}/subscription", response_model=MemberOut)
def update_member_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberUpdateSubscriptionIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Đổi hạn dùng — TỰ PHỤC VỤ, áp NGAY (user 2026-07-13: bỏ duyệt, giống Gia hạn).

    Tính phí khi KÉO DÀI hạn (`subscription_would_extend`) với user bị tính phí:
    ví đủ → trừ + áp ngay; ví thiếu → QR (mã ORDER) + 402, đổi hạn CHỜ tới khi webhook
    nhận đủ tiền. Rút ngắn / vô thời hạn / super-admin / non-beta → miễn phí, áp ngay.
    """
    _get_workspace_or_404(db, workspace_id)
    # KHÔNG gate assert_workspace_access: gán workspace CHỈ giới hạn việc ADD (mời).
    # Đổi hạn thành viên mình ĐÃ add vẫn cho phép kể cả khi sub-admin bị gỡ khỏi
    # workspace; `_member_or_404_visible` (invited_by_user_id) đủ khoá. Xem renew.py.
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)
    # Phí = đơn giá/tháng (2 tầng) × số tháng kéo dài, CHỈ khi kéo dài hạn; ngược
    # lại 0. Dùng chung subscription_fee với webhook replay (khớp amount hoá đơn QR).
    fee = subscription_fee(member, user, default_fee, body)
    mode = payment_flow.decide_payment(db, user, fee)
    if mode == payment_flow.DEFER:
        _create_subscription_order_and_raise(db, user, workspace_id, member, body, fee, settings_row)

    perform_subscription_core(db, user, member, body)
    if mode == payment_flow.WALLET:
        wallet_service.charge_renew(db, user, member.id, fee, email=member.email)

    db.commit()
    db.refresh(member)
    return member
