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
    cycle_settings,
    is_cycle_aligned,
    quote_cycle,
    _mark_member_paid,
    _member_or_404_visible,
    _months_between,
    _trim_cycles_to_end,
)

# Phân biệt "không truyền" với "truyền None": `None` là một giá trị HỢP LỆ của báo giá
# (chế độ 30 ngày không có báo giá nào), nên không dùng None làm mặc định được.
_UNSET = object()


def _cycle_quote_for(
    db: Session | None,
    member: Member,
    body: MemberUpdateSubscriptionIn,
    *,
    now: datetime | None = None,
):
    """Báo giá theo chu kỳ cho lần ĐỔI HẠN — `None` nếu không ở chế độ đó.

    Chỉ dựng khi client gửi SỐ THÁNG. "Theo ngày cụ thể" (chỉ gửi `end_at`) là admin
    tự chọn mốc, §4 quy định BE KHÔNG tính lại — kể cả ở chế độ này.

    `months` là SỐ MỐC nên `extra_months = months − 1`, giống `renew.py::_renew_quote`.
    Có `purchased_at` thì neo từ đó (admin đổi mốc); không thì điểm nối =
    `max(hạn hiện tại, now)` — đúng luật chống thu trùng của §3.6.2.

    `now` = mốc báo giá của lượt bán (xem `perform_subscription_core`). Hàm đọc
    `member.subscription_end_at` nên phải gọi TRƯỚC khi ghi hạn mới lên member.
    """
    ws = getattr(member, "workspace", None)
    if ws is None or not is_cycle_aligned(ws):
        return None
    if body.subscription_months is None or body.subscription_end_at is not None:
        return None
    settings_row = cycle_settings(db) if db is not None else None
    extra = max(0, int(body.subscription_months) - 1)
    if body.subscription_purchased_at is not None:
        return quote_cycle(
            ws,
            body.subscription_purchased_at,
            extra_months=extra,
            settings_row=settings_row,
        )
    return quote_cycle(
        ws,
        datetime.now(timezone.utc) if now is None else now,
        current_end=member.subscription_end_at,
        extra_months=extra,
        settings_row=settings_row,
    )


def _resolve_end_at(
    member: Member,
    body: MemberUpdateSubscriptionIn,
    *,
    db: Session | None = None,
    now: datetime | None = None,
    quote: object = _UNSET,
) -> datetime | None:
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

    `now` = mốc báo giá; `quote` = báo giá đã dựng sẵn của CHÍNH lượt bán này (truyền
    vào để tiền và hạn không ra từ hai lần dựng khác nhau).
    """
    if body.subscription_end_at is not None:
        return body.subscription_end_at
    if body.subscription_months is None:
        return None
    if quote is _UNSET:
        quote = _cycle_quote_for(db, member, body, now=now)
    if quote is not None:
        # Chế độ `cycle_aligned`: hạn rơi đúng MỐC CHỐT, không phải neo + N×30.
        return quote.end_at
    if body.subscription_purchased_at is not None:
        return _end_from_purchase(
            body.subscription_purchased_at, body.subscription_months
        )
    now = datetime.now(timezone.utc) if now is None else now
    if member.subscription_end_at is not None and member.subscription_end_at > now:
        return _extend_subscription_end(
            member.subscription_end_at, body.subscription_months
        )
    return _end_from_purchase(now, body.subscription_months)


def _resolve_purchased_at(
    body: MemberUpdateSubscriptionIn,
    target_end: datetime | None,
    target_months: int | None,
    *,
    member: Member | None = None,
    now: datetime | None = None,
    quote: object = _UNSET,
) -> datetime | None:
    """Ngày mua để LƯU lại (mốc neo, dùng làm mặc định khi mở lại modal).

    Ưu tiên ngày mua client gửi. Nếu không có → suy ngược từ hạn - months×30 (đúng mốc
    đã dùng để tính hạn, kể cả nhánh cộng dồn). None khi vô thời hạn.
    """
    if body.subscription_purchased_at is not None:
        return body.subscription_purchased_at
    if target_months is None or target_end is None:
        return None
    ws = getattr(member, "workspace", None) if member is not None else None
    if ws is not None and is_cycle_aligned(ws):
        # Neo = ĐIỂM NỐI của cửa sổ vừa bán (§3.6.7). Suy ngược `hạn − months×30` ở
        # chế độ này ra một ngày vô nghĩa vì hạn không còn cách neo đúng 30 ngày.
        #
        # LẤY TỪ BÁO GIÁ, không đọc lại `member.subscription_end_at`: caller gọi hàm
        # này SAU khi đã ghi hạn MỚI lên member, nên đọc lại là lấy chính hạn mới làm
        # điểm nối — cửa sổ suy ngược ra rỗng và mọi con số tính từ nó (đơn giá trên
        # bảng điều khiển, phí kỳ) đều sai.
        if quote is not _UNSET and quote is not None:
            return quote.join_at
        now = datetime.now(timezone.utc) if now is None else now
        cur = member.subscription_end_at
        return cur if cur is not None and cur > now else now
    return target_end - timedelta(days=target_months * SUBSCRIPTION_DAYS_PER_MONTH)


def subscription_would_extend(
    member: Member,
    body: MemberUpdateSubscriptionIn,
    *,
    db: Session | None = None,
    now: datetime | None = None,
    quote: object = _UNSET,
) -> bool:
    """Đổi hạn này có KÉO DÀI hạn không (để quyết định tính phí — user 2026-07-13:
    "chỉ khi kéo dài hạn"). True khi hạn MỚI > hạn hiện tại (cả hai có giá trị). Vô
    thời hạn (hạn mới None) / hạn hiện tại None / rút ngắn / giữ nguyên → False."""
    target_end = _resolve_end_at(member, body, db=db, now=now, quote=quote)
    cur = member.subscription_end_at
    return target_end is not None and cur is not None and target_end > cur


def _billable_extension_months(
    member: Member,
    body: MemberUpdateSubscriptionIn,
    *,
    db: Session | None = None,
    now: datetime | None = None,
    quote: object = _UNSET,
) -> int:
    """Số THÁNG tính phí cho lần kéo dài (đơn vị 30 ngày, làm tròn LÊN, tối thiểu 1).
    'Theo số tháng' = đúng số tháng cộng thêm; 'theo ngày' = (hạn mới − hạn cũ)/30."""
    if body.subscription_months is not None:
        return max(1, int(body.subscription_months))
    target_end = _resolve_end_at(member, body, db=db, now=now, quote=quote)
    cur = member.subscription_end_at
    if target_end is not None and cur is not None and target_end > cur:
        days = (target_end - cur).total_seconds() / 86400.0
        return max(1, ceil(days / SUBSCRIPTION_DAYS_PER_MONTH))
    return 0


def subscription_fee(
    db: Session,
    member: Member,
    user: User,
    default_fee: int,
    body: MemberUpdateSubscriptionIn,
    *,
    now: datetime | None = None,
) -> int:
    """Phí đổi hạn theo số tháng KÉO DÀI; 0 nếu không kéo dài (rút ngắn / vô thời hạn
    / giữ nguyên). Nhánh GPT nhân đơn giá/tháng, nhánh Canva tra bảng bậc. Dùng chung
    endpoint + webhook replay.

    `now` = mốc báo giá. Dựng báo giá MỘT lần rồi dùng cho cả câu hỏi "có kéo dài
    không" lẫn số tiền: dựng hai lần là hai mốc giờ khác nhau, đủ để rơi hai bên một
    ngưỡng nửa ngày."""
    quote = _cycle_quote_for(db, member, body, now=now)
    if not subscription_would_extend(member, body, db=db, now=now, quote=quote):
        return 0
    if quote is not None:
        # Cùng lý do với `invite.fee_for_member`: ở chế độ này nhân đơn giá × số
        # tháng sẽ thu trọn một tháng cho quãng chỉ tới mốc chốt.
        return payment_flow.fee_for_window(
            db,
            user,
            prorated_half_days=quote.prorated_half_days,
            cycle_days=quote.cycle_days,
            whole_months=quote.whole_months,
            member_fee=member.fee_vnd,
            default_fee=default_fee,
            settings_row=cycle_settings(db),
        )
    months = _billable_extension_months(member, body, db=db, now=now, quote=quote)
    return payment_flow.fee_for_months(
        db,
        user,
        months=months,
        platform=payment_flow.member_platform(member),
        member_fee=member.fee_vnd,
        default_fee=default_fee,
    )


def perform_subscription_core(
    db: Session,
    user: User,
    member: Member,
    body: MemberUpdateSubscriptionIn,
    *,
    now: datetime | None = None,
) -> Member:
    """Áp đổi hạn dùng NGAY cho member (tự phục vụ — feature 003 user 2026-07-13 bỏ
    duyệt). KHÔNG trừ phí, KHÔNG commit — caller lo. Dùng chung endpoint + webhook
    replay (sau thanh toán QR).

    `now` = mốc BÁO GIÁ của lượt bán này. Caller nào đã báo giá bằng một mốc thì phải
    truyền LẠI đúng mốc đó: webhook chạy lại lệnh hàng phút sau lúc báo giá, tự lấy
    giờ mới là giao một cửa sổ mà hoá đơn không hề tính tiền (§3.6.2 — điểm nối có thể
    đã vượt ngưỡng ép thêm tháng hoặc vượt luôn mốc chốt). Mặc định `None` = tự lấy
    giờ hiện tại, giữ nguyên hành vi cũ cho call site chưa đổi."""
    now = datetime.now(timezone.utc) if now is None else now
    # Dựng báo giá TRƯỚC mọi phép gán: các hàm dưới đọc `member.subscription_end_at`,
    # mà ngay sau đây nó bị ghi đè bằng hạn MỚI.
    quote = _cycle_quote_for(db, member, body, now=now)
    target_end = _resolve_end_at(member, body, db=db, now=now, quote=quote)
    # "Theo ngày cụ thể" = chỉ gửi hạn, KHÔNG gửi số tháng → GIỮ NGUYÊN số tháng &
    # mốc neo cũ, chỉ đặt lại hạn (yêu cầu user 2026-07-08).
    date_only = body.subscription_end_at is not None and body.subscription_months is None
    target_months = member.subscription_months if date_only else body.subscription_months
    old_months = member.subscription_months
    old_end = member.subscription_end_at

    # Vật chất hoá các chu kỳ hiện có (nếu chưa có) TRƯỚC khi đổi hạn, để đồng bộ
    # dựa trên hạn cũ liền mạch. Xem _ensure_cycles_materialized.
    _ensure_cycles_materialized(member, now=now, actor_id=user.id, db=db)

    member.subscription_months = target_months
    member.subscription_end_at = target_end
    if not date_only:
        member.subscription_purchased_at = _resolve_purchased_at(
            body, target_end, target_months, member=member, now=now, quote=quote,
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
    elif quote is not None and (old_end is None or target_end > old_end):
        # Chế độ neo theo chu kỳ: kỳ phải là CHÍNH cửa sổ vừa bán, lấy thẳng từ báo
        # giá (khuôn của `perform_renew_core`). Ghi `start_at = hạn cũ` + `months =
        # số tháng khách bấm` như nhánh dưới thì kỳ nói khách đã mua TRỌN MỘT THÁNG
        # cho quãng chỉ chạy tới mốc chốt: báo cáo doanh thu đọc `months` khi không
        # có phần lẻ (`report.cycle_units`) nên sổ ghi một đằng, ví trừ một nẻo. Đầu
        # kỳ cũng phải trùng mốc neo (§3.6.7), mà mốc neo ở trên là `quote.join_at`.
        _append_paid_cycle(
            member,
            start_at=quote.join_at,
            end_at=target_end,
            months=quote.whole_months,
            actor_id=user.id,
            now=now,
            prorated_half_days=quote.prorated_half_days,
        )
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
    *,
    priced_at: datetime | None = None,
) -> None:
    """Ví thiếu → tạo hoá đơn QR đổi hạn + HTTP 402. KHÔNG áp đổi hạn (chờ trả tiền).

    `priced_at` = mốc đã dùng để ra `amount`; đóng vào hoá đơn để webhook áp lại đúng
    cửa sổ đó thay vì cửa sổ của lúc tiền về (xem `payment_flow.priced_at_of`)."""
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
        platform=payment_flow.member_platform(member),
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
        priced_at=priced_at,
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
    # MỘT mốc cho cả tiền lẫn hạn: ở chế độ neo theo chu kỳ, hai lần dựng báo giá cách
    # nhau vài mili giây vẫn có thể rơi hai bên một ngưỡng nửa ngày.
    now = datetime.now(timezone.utc)
    # Phí = đơn giá/tháng (2 tầng) × số tháng kéo dài, CHỈ khi kéo dài hạn; ngược
    # lại 0. Dùng chung subscription_fee với webhook replay (khớp amount hoá đơn QR).
    fee = subscription_fee(db, member, user, default_fee, body, now=now)
    mode = payment_flow.decide_payment(db, user, fee)
    if mode == payment_flow.DEFER:
        _create_subscription_order_and_raise(
            db, user, workspace_id, member, body, fee, settings_row, priced_at=now
        )

    perform_subscription_core(db, user, member, body, now=now)
    if mode == payment_flow.WALLET:
        wallet_service.charge_renew(db, user, member.id, fee, email=member.email)

    db.commit()
    db.refresh(member)
    return member
