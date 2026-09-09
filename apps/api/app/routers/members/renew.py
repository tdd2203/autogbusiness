"""Chức năng: GIA HẠN (renew) — TỰ PHỤC VỤ, KHÔNG cần duyệt.

⚠️ ĐỌC `subscription.md` (đổi hạn có duyệt) để phân biệt với file này.
⚠️ Cộng dồn hạn tuân theo `EXPIRY_RULES.md` §2.2 — KHÔNG tự chế công thức.

Endpoint:
  - POST /{member_id}/renew → renew_member_subscription
  - POST /renew-preview     → preview_renew (chỉ ĐỌC, không đụng gì)

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
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_permission
from app.models import PLATFORM_CANVA, Member, User
from app.permissions import Permission
from app.routers.wallet._shared import get_payment_settings
from app.services import payment_flow, wallet_service
from app.schemas import MemberRenewIn, MemberRenewPreviewIn, MemberOut

from .correct_add_date import end_from_anchor
from ._shared import (
    router,
    SUBSCRIPTION_DAYS_PER_MONTH,
    _append_paid_cycle,
    cycle_settings,
    half_days_between,
    is_cycle_aligned,
    quote_cycle,
    _end_from_purchase,
    _ensure_cycles_materialized,
    _extend_subscription_end,
    _get_workspace_or_404,
    _mark_member_paid,
    _member_or_404_visible,
    _visibility_filter,
)


def _renew_quote(db: Session, member: Member, months: int, *, old_end, now):
    """Báo giá theo chu kỳ hoá đơn — `None` nếu workspace vẫn ở chế độ 30-ngày.

    `months` của giao diện = SỐ MỐC muốn mua, nên `extra_months = months − 1`: gia hạn
    "1 tháng" nghĩa là đi tới mốc chốt kế tiếp. Khách đã hội tụ thì đó đúng là một chu
    kỳ trọn; khách cũ còn lệch thì đó là quãng ngắn hơn và họ CHỈ trả đúng quãng đó —
    chính là cơ chế kéo mọi người về mốc chung sau một vòng gia hạn (EXPIRY_RULES §3.6.8).
    """
    ws = member.workspace
    if ws is None or not is_cycle_aligned(ws):
        return None
    return quote_cycle(
        ws,
        now,
        current_end=old_end,
        extra_months=max(0, months - 1),
        settings_row=cycle_settings(db),
    )


def renew_window(db: Session, member: Member, months: int, *, now: datetime):
    """Cửa sổ SẼ bán cho lượt gia hạn này: `(điểm nối, hạn mới, báo giá|None)`.

    ĐIỂM VÀO DUY NHẤT của câu hỏi "gia hạn xong hạn tới đâu" — cả lúc áp thật
    (`perform_renew_core`) lẫn lúc chỉ xem trước (`preview_renew`) đều gọi hàm này.
    Tách ra vì màn hình gia hạn từng tự cộng `months×30` ở web: đúng ở chế độ 30
    ngày, nhưng ở không gian chốt theo chu kỳ hoá đơn thì hạn rơi vào MỐC CHỐT, tức
    người bán đọc một ngày còn hệ thống ghi một ngày khác (EXPIRY_RULES §3.6.2).
    """
    old_end = member.subscription_end_at
    quote = _renew_quote(db, member, months, old_end=old_end, now=now)
    if quote is not None:
        # Chế độ `cycle_aligned`: hạn rơi đúng MỐC CHỐT, cửa sổ tính từ ĐIỂM NỐI.
        return quote.join_at, quote.end_at, quote
    if old_end is not None and old_end > now:
        # Cộng dồn: còn hạn → nối tiếp hạn cũ; hết hạn/chưa có → tính từ bây giờ.
        return old_end, _extend_subscription_end(old_end, months), None
    return now, _end_from_purchase(now, months), None


def renew_fee(
    db: Session,
    user: User,
    member: Member,
    months: int,
    *,
    quote,
    settings_row,
    default_fee: int,
) -> int:
    """Phí một lượt gia hạn — `quote` là báo giá của CHÍNH cửa sổ vừa dựng ở
    `renew_window` (None = chế độ 30 ngày).

    Nhận `quote` chứ không tự dựng lại: tiền và hạn phải ra từ CÙNG một cửa sổ, dựng
    hai lần là hai mốc giờ khác nhau và có thể rơi hai bên ngưỡng làm tròn nửa ngày.
    """
    if quote is not None:
        # Chế độ `cycle_aligned`: phần lẻ tới mốc + các chu kỳ trọn (§3.6.5).
        return payment_flow.fee_for_window(
            db,
            user,
            prorated_half_days=quote.prorated_half_days,
            cycle_days=quote.cycle_days,
            whole_months=quote.whole_months,
            member_fee=member.fee_vnd,
            default_fee=default_fee,
            settings_row=settings_row,
        )
    # Chế độ 30-ngày: đơn giá/tháng (2 tầng) × số tháng (user 2026-07-13). GPT nhân
    # đơn giá/tháng; Canva tra bảng bậc (mua dài rẻ hơn) — cùng một điểm vào.
    return payment_flow.fee_for_months(
        db,
        user,
        months=months,
        platform=payment_flow.member_platform(member),
        member_fee=member.fee_vnd,
        default_fee=default_fee,
        settings_row=settings_row,
    )


def perform_renew_core(
    db: Session, user: User, member: Member, months: int, *, now: datetime | None = None
) -> Member:
    """Áp dụng gia hạn N tháng cho member (cộng dồn hạn + nối N CHU KỲ 1-tháng đã
    thanh toán + audit). KHÔNG trừ phí ví, KHÔNG commit — caller lo. Dùng chung cho
    endpoint (ví đủ / miễn phí) và webhook replay (sau thanh toán QR).

    Mô hình chu kỳ (chốt user 2026-07-13): 1 tháng = 1 chu kỳ; phí thu TRƯỚC nên chu
    kỳ mới là 'paid' NGAY — KHÔNG còn reset member về 'chưa thanh toán'. Xem
    [[subscription-cycle-model]].

    `now` = mốc BÁO GIÁ của lượt bán này. Caller nào đã báo giá bằng một mốc thì phải
    truyền LẠI đúng mốc đó vào đây, vì tiền và hạn đo từ CÙNG một cửa sổ: webhook QR
    chạy lại lệnh hàng phút sau lúc báo giá, tự lấy giờ mới là bán một cửa sổ mà hoá
    đơn không hề tính tiền (§3.6.2 — điểm nối có thể đã vượt ngưỡng ép thêm tháng hoặc
    vượt luôn mốc chốt). Mặc định `None` = tự lấy giờ hiện tại, giữ nguyên hành vi cũ
    cho call site chưa đổi."""
    now = datetime.now(timezone.utc) if now is None else now
    old_end = member.subscription_end_at

    # Vật chất hoá các chu kỳ hiện có nếu member chưa có kỳ nào (mời sau migration,
    # hoặc member cũ trước bảng cycles) → lịch sử liền mạch trước khi nối kỳ mới.
    _ensure_cycles_materialized(member, now=now, actor_id=user.id, db=db)

    start_at, new_end, quote = renew_window(db, member, months, now=now)

    # `subscription_months` giữ SỐ MỐC KHÁCH YÊU CẦU (luôn ≥ 1), KHÔNG phải
    # `quote.whole_months` — kỳ lẻ có `whole_months=0`, mà `months ≤ 0` trên member
    # nghĩa là VÔ THỜI HẠN (EXPIRY_RULES §5), tức biến khách thành dùng vĩnh viễn.
    # Phân rã đúng của lần bán nằm ở chu kỳ vừa nối. Xem §3.6.7.
    member.subscription_months = months
    member.subscription_end_at = new_end
    # GIA HẠN cho dòng đang mang cờ "đổi email chưa xong" = quyết định giữ nó lại như
    # một ghế CÓ TRẢ TIỀN ⇒ nó thôi là phần thừa của lần đổi email. Không gỡ cờ thì
    # lần gỡ sau bị gán nhầm lý do 'đổi email' và cảnh báo kêu oan trên ghế tử tế.
    member.email_change_stuck_at = None
    member.email_change_stuck_to = None
    # Mốc neo "Ngày gia hạn" = hạn mới − months×30 (khớp _resolve_purchased_at của
    # subscription.py: mở lại modal hiển thị đúng chu kỳ vừa gia hạn).
    # Chế độ `cycle_aligned` KHÔNG suy hạn từ mốc neo (EXPIRY_RULES §3.6.7) nên neo =
    # ĐIỂM NỐI, tức đầu cửa sổ vừa bán. Lấy `new_end − months×30` ở chế độ đó ra một
    # ngày vô nghĩa vì hạn không còn cách neo đúng 30 ngày một tháng.
    if quote is not None:
        member.subscription_purchased_at = quote.join_at
    else:
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
        months=quote.whole_months if quote is not None else months,
        prorated_half_days=quote.prorated_half_days if quote is not None else None,
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
    priced_at,
) -> None:
    """Ví thiếu → tạo hoá đơn QR gia hạn + HTTP 402. KHÔNG áp gia hạn (chờ trả tiền).

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
        kind="renew",
        amount=amount,
        payload={"member_id": str(member.id), "months": months},
        workspace_id=workspace_id,
        platform=payment_flow.member_platform(member),
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
    # MỘT mốc giờ cho cả lượt: báo giá, hoá đơn QR và lúc áp hạn phải cùng đọc một
    # đồng hồ. Trước đây báo giá lấy một `datetime.now()` còn `perform_renew_core` lấy
    # một cái khác, mà giữa hai chỗ đó `decide_payment` còn KHOÁ dòng ví và có thể chờ
    # lâu khi giao dịch khác đang giữ khoá. Hai mốc rơi hai bên ngưỡng làm tròn nửa
    # ngày (hoặc hai bên mốc chốt) là tiền một đằng, hạn một nẻo — không có gì báo.
    now = datetime.now(timezone.utc)

    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)
    # Báo giá bằng ĐÚNG `now` mà `perform_renew_core` sẽ dùng để áp hạn ngay dưới —
    # hai chỗ tính lại cùng một cửa sổ nên không thể lệch nhau. Cố ý KHÔNG chuyền
    # `quote` xuống: `perform_renew_core` còn phục vụ webhook và luồng mời, mà một
    # nhánh quên chuyền là tiền theo cửa sổ này, hạn ghi theo cửa sổ khác — cùng lý do
    # đã ghi ở `_shared.sold_window`.
    _join_at, _new_end, quote = renew_window(db, member, months, now=now)
    fee = renew_fee(
        db,
        user,
        member,
        months,
        quote=quote,
        settings_row=settings_row,
        default_fee=default_fee,
    )

    # Ví trước, QR sau (chỉ user bị tính phí; decide_payment tự bỏ qua super/non-beta).
    mode = payment_flow.decide_payment(db, user, fee)
    if mode == payment_flow.DEFER:
        _create_renew_order_and_raise(
            db, user, workspace_id, member, months, fee, settings_row, priced_at=now
        )

    perform_renew_core(db, user, member, months, now=now)
    if mode == payment_flow.WALLET:
        wallet_service.charge_renew(db, user, member.id, fee, email=member.email)

    db.commit()
    db.refresh(member)
    return member


def _preview_item(
    db: Session,
    user: User,
    member: Member,
    months: int,
    *,
    now: datetime,
    settings_row,
    default_fee: int,
    anchor: datetime | None,
) -> dict:
    """Một dòng xem trước. Đi qua ĐÚNG các hàm mà lệnh thật sẽ gọi (`renew_window`,
    `renew_fee`, `end_from_anchor`) — không có phép tính riêng nào ở đây, vì bản xem
    trước lệch với lệnh thật còn tệ hơn không có bản xem trước."""
    ws = getattr(member, "workspace", None)
    if anchor is not None:
        # Màn hình SỬA "Ngày gia hạn": neo lại từ mốc mới, KHÔNG cộng dồn, KHÔNG thu phí.
        start_at = anchor
        end_at = end_from_anchor(
            ws,
            anchor,
            months,
            now=now,
            old_end=member.subscription_end_at,
            settings_row=cycle_settings(db),
        )
        quote, fee = None, 0
    else:
        start_at, end_at, quote = renew_window(db, member, months, now=now)
        fee = renew_fee(
            db,
            user,
            member,
            months,
            quote=quote,
            settings_row=settings_row,
            default_fee=default_fee,
        )
    row = {
        "member_id": str(member.id),
        "email": member.email,
        "fee": fee,
        "current_end_at": (
            member.subscription_end_at.isoformat()
            if member.subscription_end_at is not None
            else None
        ),
        # `from` = ĐIỂM NỐI (hạn cũ nếu còn hạn), `to` = hạn mới. Đặt tên trùng
        # `invite-preview → detail` để web dùng lại nguyên khối chi tiết cách tính.
        "from": start_at.isoformat(),
        "to": end_at.isoformat() if end_at is not None else None,
        # Nửa ngày là đơn vị THẬT của phần lẻ (§3.6.4) — trả số nguyên nửa-ngày để
        # web tự hiện "20,5 ngày", đừng làm tròn ở đây.
        "half_days": half_days_between(start_at, end_at) if end_at is not None else 0,
        # Nhánh BẢNG GIÁ BẬC (Canva) KHÔNG có "đơn giá tháng" nào nhân ra được tổng:
        # mua 3 tháng rẻ hơn 3 lần giá 1 tháng. Gửi con số của GPT sang đó là bày ra
        # một phép nhân không khớp chính dòng tổng ngay bên cạnh, người bán đọc xong
        # lại đi hỏi vì sao lệch. Thiếu trường này thì màn hình tự bỏ dòng đơn giá.
        "unit_price_vnd": (
            None
            if payment_flow.member_platform(member) == PLATFORM_CANVA
            else payment_flow.effective_fee(member.fee_vnd, user, default_fee)
        ),
    }
    if quote is not None:
        # Tách sẵn HAI KHOẢN để màn hình bày được phép tính ("2 ngày lẻ 21.300đ +
        # 1 tháng trọn 330.000đ") mà không phải tự nhân chia — web tự tính là dựng
        # nguồn sự thật thứ hai cho tiền. Tổng hai khoản đúng bằng `fee` ở trên.
        le_vnd, tron_vnd = payment_flow.fee_window_parts(
            db,
            user,
            prorated_half_days=quote.prorated_half_days,
            cycle_days=quote.cycle_days,
            whole_months=quote.whole_months,
            member_fee=member.fee_vnd,
            default_fee=default_fee,
            settings_row=settings_row,
        )
        row.update(
            {
                "prorated_half_days": quote.prorated_half_days,
                "whole_months": quote.whole_months,
                "cycle_days": quote.cycle_days,
                "cycle_start": quote.cycle_start.isoformat(),
                "cycle_end": quote.cycle_end.isoformat(),
                "forced_extra_month": quote.forced_extra_month,
                "fee_prorated": le_vnd,
                "fee_whole": tron_vnd,
            }
        )
    return row


@router.post("/renew-preview", response_model=dict)
def preview_renew(
    workspace_id: UUID,
    body: MemberRenewPreviewIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Xem trước lượt gia hạn — KHÔNG tạo, KHÔNG trừ, KHÔNG khoá gì.

    Vì sao cần: hạn mới KHÔNG còn suy được ở web. Không gian chốt theo chu kỳ hoá đơn
    cho hạn rơi đúng MỐC CHỐT và thu tiền theo số ngày thật từ điểm nối tới mốc đó
    (EXPIRY_RULES §3.6), nên phép `hạn cũ + tháng×30` mà web từng tự tính vừa sai ngày
    vừa sai tiền — người bán báo với khách một đằng, hệ thống ghi một nẻo.

    Trả về ĐÚNG các con số của lượt bán: hạn mới, tiền, và phân rã để giải thích
    (phần lẻ mấy nửa ngày trên chu kỳ mấy ngày, mấy chu kỳ trọn). Cùng bộ trường với
    `invite-preview → detail` để hai màn hình dùng chung một khối "chi tiết cách tính".

    Nhận NHIỀU member cùng lúc (gia hạn hàng loạt). `member_ids` không thuộc workspace
    này — hoặc sub-admin không được thấy — thì rơi vào `missing`, KHÔNG làm hỏng cả
    bảng: chọn 200 dòng mà một dòng lạ là mất luôn số tiền của 199 dòng kia.
    """
    _get_workspace_or_404(db, workspace_id)
    if body.purchased_at is not None and len(body.member_ids) > 1:
        # Mốc neo là của MỘT email cụ thể (màn hình sửa "Ngày gia hạn"). Áp một mốc
        # cho cả mẻ là dựng ra một bảng số không màn hình nào yêu cầu.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="`purchased_at` chỉ dùng khi xem trước cho đúng một thành viên",
        )
    months = body.months
    # MỘT mốc giờ cho cả bảng: hai dòng cạnh nhau mà đo bằng hai đồng hồ thì có thể
    # rơi hai bên ngưỡng làm tròn nửa ngày, nhìn như hệ thống tính sai.
    now = datetime.now(timezone.utc)
    settings_row = get_payment_settings(db)
    default_fee = int(settings_row.invite_fee_vnd or 0)

    stmt = select(Member).where(
        Member.workspace_id == workspace_id, Member.id.in_(body.member_ids)
    )
    found = {m.id: m for m in db.execute(_visibility_filter(stmt, user)).scalars()}

    items: list[dict] = []
    for member_id in body.member_ids:
        member = found.get(member_id)
        if member is None:
            continue
        items.append(
            _preview_item(
                db,
                user,
                member,
                months,
                now=now,
                settings_row=settings_row,
                default_fee=default_fee,
                anchor=body.purchased_at,
            )
        )
    return {
        "months": months,
        "chargeable": payment_flow.is_chargeable_user(user),
        "total_fee": sum(int(i["fee"]) for i in items),
        "items": items,
        "missing": [str(i) for i in body.member_ids if i not in found],
    }
