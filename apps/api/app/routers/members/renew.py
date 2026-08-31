"""Chức năng: GIA HẠN (renew) — TỰ PHỤC VỤ, KHÔNG cần duyệt.

⚠️ ĐỌC `subscription.md` (đổi hạn có duyệt) để phân biệt với file này.
⚠️ Cộng dồn hạn tuân theo `EXPIRY_RULES.md` §2.2 — KHÔNG tự chế công thức.

Endpoint:
  - POST /{member_id}/renew → renew_member_subscription

Khác PATCH /{member_id}/subscription (subscription.py — CÓ DUYỆT cho sub-admin):
gia hạn (cộng tháng) là quyền TỰ PHỤC VỤ của cả sub-admin lẫn super-admin (yêu cầu
user 2026-07-08). Áp dụng NGAY:
  - Cộng dồn hạn: còn hạn → hạn cũ + N×30 ngày; hết hạn → bây giờ + N×30 ngày.
  - Tạo 1 CHU KỲ mới (MemberSubscriptionCycle) với payment_status='unpaid'.
  - RESET trạng thái thanh toán của member về 'chưa thanh toán' (kể cả đang 'paid')
    + xoá dấu vết paid_*/payment_requested_* → admin phải xác nhận lại từng chu kỳ.

Phí gia hạn (feature 003, user 2026-07-13): dùng CHUNG mã hoá đơn với mời. Phí 2 tầng
= COALESCE(member.fee_vnd, user.invite_fee_vnd, global). Ví đủ → trừ ví + gia hạn ngay;
ví thiếu → tạo QR (mã ORDER) + 402, gia hạn CHỜ tới khi webhook nhận đủ tiền.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_permission
from app.models import Member, User
from app.permissions import Permission
from app.routers.wallet._shared import get_payment_settings
from app.services import payment_flow, wallet_service
from app.schemas import MemberRenewIn, MemberOut

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
)


def perform_renew_core(db: Session, user: User, member: Member, months: int) -> Member:
    """Áp dụng gia hạn N tháng cho member (cộng dồn hạn + nối N CHU KỲ 1-tháng đã
    thanh toán + audit). KHÔNG trừ phí ví, KHÔNG commit — caller lo. Dùng chung cho
    endpoint (ví đủ / miễn phí) và webhook replay (sau thanh toán QR).

    Mô hình chu kỳ (chốt user 2026-07-13): 1 tháng = 1 chu kỳ; phí thu TRƯỚC nên chu
    kỳ mới là 'paid' NGAY — KHÔNG còn reset member về 'chưa thanh toán'. Xem
    [[subscription-cycle-model]]."""
    now = datetime.now(timezone.utc)
    old_end = member.subscription_end_at

    # Vật chất hoá các chu kỳ hiện có nếu member chưa có kỳ nào (mời sau migration,
    # hoặc member cũ trước bảng cycles) → lịch sử liền mạch trước khi nối kỳ mới.
    _ensure_cycles_materialized(member, now=now, actor_id=user.id)

    # Cộng dồn: còn hạn → nối tiếp hạn cũ; hết hạn/chưa có → tính từ bây giờ.
    if old_end is not None and old_end > now:
        start_at = old_end
        new_end = _extend_subscription_end(old_end, months)
    else:
        start_at = now
        new_end = _end_from_purchase(now, months)

    member.subscription_months = months
    member.subscription_end_at = new_end
    # GIA HẠN cho dòng đang mang cờ "đổi email chưa xong" = quyết định giữ nó lại như
    # một ghế CÓ TRẢ TIỀN ⇒ nó thôi là phần thừa của lần đổi email. Không gỡ cờ thì
    # lần gỡ sau bị gán nhầm lý do 'đổi email' và cảnh báo kêu oan trên ghế tử tế.
    member.email_change_stuck_at = None
    member.email_change_stuck_to = None
    # Mốc neo "Ngày gia hạn" = hạn mới − months×30 (khớp _resolve_purchased_at của
    # subscription.py: mở lại modal hiển thị đúng chu kỳ vừa gia hạn).
    member.subscription_purchased_at = (
        new_end - timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)
        if new_end is not None
        else None
    )

    # Nối 1 CHU KỲ (gộp N tháng, months=months) ĐÃ THANH TOÁN từ start_at → hạn mới
    # (mua gộp = 1 kỳ, không tách; phí đã thu trước).
    _append_paid_cycle(
        member,
        start_at=start_at,
        end_at=new_end,
        months=months,
        actor_id=user.id,
        now=now,
    )
    _mark_member_paid(member, now=now, actor_id=user.id)

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
            "workspace_id": str(member.workspace_id),
            "email": member.email,
            "months": months,
            "old_end_at": old_end.isoformat() if old_end else None,
            "new_end_at": new_end.isoformat() if new_end else None,
        },
        commit=False,
    )
    return member


def _create_renew_order_and_raise(
    db: Session,
    user: User,
    workspace_id: UUID,
    member: Member,
    months: int,
    amount: int,
    settings_row,
) -> None:
    """Ví thiếu → tạo hoá đơn QR gia hạn + HTTP 402. KHÔNG áp gia hạn (chờ trả tiền)."""
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
        kind="renew",
        amount=amount,
        payload={"member_id": str(member.id), "months": months},
        workspace_id=workspace_id,
        platform=payment_flow.member_platform(member),
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
            "kind": "renew",
            "amount_vnd": amount,
            "member_id": str(member.id),
            "email": member.email,
            "months": months,
            "ref_code": order.ref_code,
        },
        commit=False,
    )
    db.commit()
    payment_flow.raise_payment_required(settings_row, order)


@router.post("/{member_id}/renew", response_model=MemberOut)
def renew_member_subscription(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberRenewIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> Member:
    """Gia hạn N tháng — áp dụng NGAY (không duyệt), tạo chu kỳ mới + reset chưa TT.
    Ví đủ → trừ phí + gia hạn ngay; ví thiếu → QR (mã ORDER) + 402, chờ thanh toán."""
    _get_workspace_or_404(db, workspace_id)
    # KHÔNG gate assert_workspace_access: gán workspace CHỈ giới hạn việc ADD (mời)
    # thành viên. Quản lý thành viên mình ĐÃ add (gia hạn ở đây) vẫn cho phép kể cả
    # khi sub-admin đã bị gỡ khỏi workspace — trang "Email đã thêm"/"Gia hạn" gom
    # xuyên workspace. `_member_or_404_visible` khoá theo invited_by_user_id (chỉ
    # thao tác được member mình mời) nên không rò rỉ. Xem activity.py (cùng lý do).
    member = _member_or_404_visible(db, workspace_id, member_id, user)
    months = body.months

    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)
    # Phí gia hạn = đơn giá/tháng (2 tầng) × số tháng gia hạn (user 2026-07-13).
    # GPT nhân đơn giá/tháng; Canva tra bảng bậc (mua dài rẻ hơn) — cùng một điểm vào.
    fee = payment_flow.fee_for_months(
        db,
        user,
        months=months,
        platform=payment_flow.member_platform(member),
        member_fee=member.fee_vnd,
        default_fee=default_fee,
        settings_row=settings_row,
    )

    # Ví trước, QR sau (chỉ user bị tính phí; decide_payment tự bỏ qua super/non-beta).
    mode = payment_flow.decide_payment(db, user, fee)
    if mode == payment_flow.DEFER:
        _create_renew_order_and_raise(db, user, workspace_id, member, months, fee, settings_row)

    perform_renew_core(db, user, member, months)
    if mode == payment_flow.WALLET:
        wallet_service.charge_renew(db, user, member.id, fee, email=member.email)

    db.commit()
    db.refresh(member)
    return member
