"""Tab 'Email đã add' — theo dõi thanh toán cho tài khoản phụ.

Gom các Member do 1 user đã add (invited_by_user_id) xuyên suốt mọi workspace,
chỉ những email còn tồn tại trong team (status != 'removed'), kèm trạng thái
thanh toán cho admin. Duyệt 2 bước: sub-admin GỬI yêu cầu duyệt (unpaid ->
requested) qua /request-payment; super-admin XÁC NHẬN đã thanh toán (requested ->
paid) qua /mark-paid. Super-admin có thể xem theo từng tài khoản phụ (?user_id=).
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.audit import log_event
from app.deps import get_current_user, get_session
from app.models import REMOVED_REASON_EMAIL_CHANGED, AuditLog, Member, MemberSubscriptionCycle, User
from app.schemas import (
    AddedMemberOut,
    MemberBulkSetExpiryIn,
    MemberMarkPaidIn,
    MemberRequestPaymentIn,
    MemberRevokeOwnerIn,
    MemberTransferOwnerIn,
    PaymentRequestNotice,
    SubscriptionCycleOut,
)

router = APIRouter(prefix="/api/v1/added-members", tags=["added-members"])

# Số member đọc mỗi lô khi duyệt danh sách dài (xem `list_added_members`). Chỉ ảnh
# hưởng RAM/số truy vấn phụ của selectinload, KHÔNG ảnh hưởng dữ liệu trả về.
_LIST_CHUNK = 200

# Cửa sổ HIỂN THỊ của tab "Đã xoá" (yêu cầu user 2026-08-24: "lưu trong 30 ngày ở
# tab này"). Đây là mốc LỌC LÚC ĐỌC, KHÔNG phải retention: bản ghi vẫn nằm trong DB
# tới khi job nền hard-delete ở mốc riêng, dài hơn (REMOVED_MEMBER_RETENTION = 90
# ngày, do user chốt 2026-07-19). Email bị xoá quá 30 ngày rơi khỏi tab nhưng lịch
# sử vẫn còn để tra cứu chỗ khác.
REMOVED_TAB_WINDOW = timedelta(days=30)


# Số bước tối đa khi lần theo chuỗi đổi email (A → B → C…). Chuỗi thật dài 1–2 bước;
# trần này chỉ để một dữ liệu vòng (A → B → A, do email cũ được mời lại rồi lại đổi)
# không treo vòng lặp.
_EMAIL_CHAIN_MAX_HOPS = 10


def _email_change_next_map(db: Session) -> dict[str, tuple[str, str]]:
    """`id member cũ` → (email mới, `id member mới`) của MỖI lần đổi email.

    Nguồn: nhật ký `MEMBER_EMAIL_CHANGED` — chỉ nó biết email nào thay cho email nào
    (bảng members KHÔNG có liên kết cũ→mới). Sắp theo thời gian rồi ghi đè, nên một
    email từng bị đổi NHIỀU LẦN (đổi đi, được mời lại, lại đổi) sẽ lấy lần GẦN NHẤT —
    đúng với lần bị gỡ đang hiển thị.
    """
    rows = db.execute(
        select(AuditLog.target_id, AuditLog.data)
        .where(AuditLog.action == "MEMBER_EMAIL_CHANGED")
        .order_by(AuditLog.timestamp)
    ).all()
    out: dict[str, tuple[str, str]] = {}
    for target_id, data in rows:
        old_id = (data or {}).get("old_member_id")
        new_email = (data or {}).get("new_email")
        if old_id and new_email and target_id:
            out[str(old_id)] = (str(new_email), str(target_id))
    return out


def _email_change_chain(
    member: Member, next_map: dict[str, tuple[str, str]]
) -> tuple[list[str], list[UUID]]:
    """Chuỗi email THAY THẾ cho `member` (A → B → C) + id member từng chặng.

    Chỉ có nghĩa với email bị gỡ VÌ ĐỔI EMAIL. Trả (emails, ids) LUÔN cùng độ dài để
    UI ghép 1-1: bấm chặng thứ i thì mở đúng member ids[i].
    """
    emails: list[str] = []
    ids: list[UUID] = []
    if member.removed_reason != REMOVED_REASON_EMAIL_CHANGED:
        return emails, ids
    seen = {str(member.id)}
    cursor = str(member.id)
    for _ in range(_EMAIL_CHAIN_MAX_HOPS):
        step = next_map.get(cursor)
        if step is None:
            break
        next_email, next_id = step
        emails.append(next_email)
        ids.append(UUID(next_id))
        if next_id in seen:
            break  # vòng (email cũ được mời lại rồi lại đổi) → dừng
        seen.add(next_id)
        cursor = next_id
    return emails, ids


def _recompute_member_payment_status(member: Member) -> None:
    """Tính lại `Member.payment_status` TỔNG HỢP từ các chu kỳ (nguồn sự thật).

    - Còn kỳ 'unpaid' → member 'unpaid'.
    - Không còn unpaid nhưng có 'requested' → member 'requested'.
    - Tất cả 'paid' → member 'paid'.
    Member KHÔNG có chu kỳ nào (vd vô thời hạn, chưa từng gia hạn) → giữ nguyên
    payment_status cấp member (thao tác legacy trực tiếp trên field member).
    Đồng bộ payment_requested_*/paid_* cấp member để chuông thông báo hiển thị đúng.
    """
    cycles = member.subscription_cycles
    if not cycles:
        return
    statuses = [c.payment_status for c in cycles]
    if any(s == "unpaid" for s in statuses):
        member.payment_status = "unpaid"
    elif any(s == "requested" for s in statuses):
        member.payment_status = "requested"
    else:
        member.payment_status = "paid"

    requested = [c for c in cycles if c.payment_status == "requested"]
    if requested:
        latest = max(
            requested,
            key=lambda c: c.payment_requested_at or datetime.min.replace(tzinfo=timezone.utc),
        )
        member.payment_requested_at = latest.payment_requested_at
        member.payment_requested_by_id = latest.payment_requested_by_id
    else:
        member.payment_requested_at = None
        member.payment_requested_by_id = None

    paid = [c for c in cycles if c.payment_status == "paid"]
    if paid and member.payment_status == "paid":
        latest = max(
            paid, key=lambda c: c.paid_at or datetime.min.replace(tzinfo=timezone.utc)
        )
        member.paid_at = latest.paid_at
        member.paid_marked_by_id = latest.paid_marked_by_id
    else:
        member.paid_at = None
        member.paid_marked_by_id = None


@router.get("", response_model=list[AddedMemberOut])
def list_added_members(
    user_id: UUID | None = None,
    unassigned: bool = False,
    removed: bool = False,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[AddedMemberOut]:
    """Danh sách email user đã add (còn tồn tại) + trạng thái thanh toán.

    - Sub-admin: luôn chỉ thấy email do CHÍNH MÌNH add (bỏ qua user_id/unassigned).
    - Super-admin:
        ?user_id=<id>   → xem riêng 1 tài khoản phụ
        ?unassigned=true → xem "email còn lại" (CHƯA có chủ) — super-admin quản lý
        bỏ trống         → tất cả email đã có chủ (add qua dashboard)
    - ?removed=true → ĐẢO danh sách sang tab "Đã xoá": chỉ email đã rời team trong
      `REMOVED_TAB_WINDOW` (30 ngày) gần nhất, mới xoá xếp trước. Quy tắc ai-thấy-gì
      giữ NGUYÊN như trên. Email `removed` mà thiếu `removed_at` (dữ liệu cũ trước
      khi có cột) KHÔNG lọt vào — không biết xoá lúc nào thì không xếp được vào cửa sổ.
    """
    if user.is_super_admin:
        target_user_id = user_id
    else:
        target_user_id = user.id
        unassigned = False  # sub-admin không xem pool email còn lại

    stmt = select(Member).options(
        selectinload(Member.workspace),
        selectinload(Member.invited_by),
        selectinload(Member.subscription_cycles),
    )
    if removed:
        cutoff = datetime.now(timezone.utc) - REMOVED_TAB_WINDOW
        stmt = stmt.where(
            Member.status == "removed",
            Member.removed_at.isnot(None),
            Member.removed_at >= cutoff,
        ).order_by(Member.removed_at.desc())
    else:
        stmt = stmt.where(Member.status != "removed").order_by(
            Member.created_at.desc()
        )
    if unassigned:
        # Email còn lại: chưa gán cho ai → super-admin quản lý.
        stmt = stmt.where(Member.invited_by_user_id.is_(None))
    elif target_user_id is not None:
        stmt = stmt.where(Member.invited_by_user_id == target_user_id)
    # else: super-admin xem mặc định → TẤT CẢ member còn tồn tại (kể cả email
    # còn lại chưa chủ) để quản lý đầy đủ + gán/chuyển quyền sở hữu. Owner hiển
    # thị qua invited_by_username (None = chưa chủ).

    # RAM (2026-08-04): trước đây `db.execute(stmt).scalars()` nạp TOÀN BỘ member +
    # workspace + chủ + chu kỳ vào identity map của session RỒI mới dựng output →
    # đỉnh RAM = (ORM + Pydantic) cho cả bảng. Giờ đọc theo LÔ (`yield_per`) và
    # `expunge` từng lô sau khi đã dựng xong output của lô đó, nên phần ORM luôn bị
    # chặn ở 1 lô thay vì tăng theo số email.
    #
    # KẾT QUẢ TRẢ VỀ KHÔNG ĐỔI: vẫn là TOÀN BỘ danh sách, cùng thứ tự (order_by giữ
    # nguyên), cùng nội dung từng phần tử — đây thuần tuý là đổi cách nạp.
    #
    # Vì sao expunge an toàn ở đây:
    #  - `expunge` chỉ TÁCH object khỏi session, không xoá giá trị đã nạp và không
    #    ghi gì xuống DB.
    #  - `_recompute_member_payment_status` CỐ Ý chỉ sửa trong bộ nhớ để hiển thị;
    #    trước giờ session cũng đóng mà KHÔNG commit nên thay đổi đó chưa từng được
    #    lưu. Expunge giữ nguyên đúng hành vi đó.
    #  - Mọi thuộc tính cần dùng đều đã đọc xong TRƯỚC khi expunge lô.
    # `selectinload` chạy được cùng `yield_per` (một truy vấn phụ cho mỗi lô).
    # Tab "Đã xoá": nạp SẴN bản đồ đổi email (1 truy vấn cho cả danh sách) để mỗi
    # dòng kể được "email này đã đổi sang đâu". Danh sách thường không cần → không tốn.
    next_email_map = _email_change_next_map(db) if removed else {}

    rows: list[AddedMemberOut] = []
    result = db.execute(stmt.execution_options(yield_per=_LIST_CHUNK)).scalars()
    for chunk in result.partitions():
        for member in chunk:
            # HARDENING (2026-07-14): payment_status cấp member = TỔNG HỢP TỪ CYCLES (nguồn
            # sự thật). Cờ lưu có thể lệch nếu một mẻ nền dựng/đổi kỳ mà không recompute
            # (vd migration cycle 13/7). Tính lại tại đây để hiển thị + đếm LUÔN khớp kỳ,
            # không bao giờ tái diễn cảnh "chưa thanh toán" mà badge "đã thanh toán".
            _recompute_member_payment_status(member)
            out = AddedMemberOut.model_validate(member)
            out.workspace_name = member.workspace.name if member.workspace else None
            out.invited_by_username = (
                member.invited_by.username if member.invited_by else None
            )
            out.cycles = [
                SubscriptionCycleOut.model_validate(c)
                for c in member.subscription_cycles
            ]
            # Email bị gỡ VÌ ĐỔI EMAIL: lần theo cả chuỗi tới email nhận CUỐI CÙNG
            # (A → B → C). Người dùng nhìn email cũ phải biết hạn/tiền của nó giờ nằm
            # ở đâu — không có chuỗi này thì email cũ trông như "mất trắng mà vẫn còn
            # hạn" (user hỏi 2026-08-24).
            if removed:
                chain, chain_ids = _email_change_chain(member, next_email_map)
                out.email_changed_to = chain
                out.email_changed_to_ids = chain_ids
            rows.append(out)
        for member in chunk:
            db.expunge(member)
    return rows


@router.get("/pending-count", response_model=dict)
def pending_payment_count(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Số email đang chờ super-admin XÁC NHẬN thanh toán (payment_status='requested').

    Phục vụ biểu tượng thông báo trên Dashboard: super-admin thấy tổng số yêu cầu
    đang chờ duyệt (xuyên mọi tài khoản phụ) để biết mà vào tab "Email đã add".
    Sub-admin không duyệt thanh toán → luôn trả 0 (không hiện badge).
    """
    if not user.is_super_admin:
        return {"count": 0}
    count = db.execute(
        select(func.count())
        .select_from(Member)
        .where(Member.status != "removed", Member.payment_status == "requested")
    ).scalar_one()
    return {"count": count}


@router.get("/pending-requests", response_model=list[PaymentRequestNotice])
def pending_payment_requests(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[PaymentRequestNotice]:
    """Danh sách yêu cầu duyệt thanh toán đang chờ (dạng thông báo cho super-admin).

    Mỗi dòng = 1 email đang `requested`: ai gửi (payment_requested_by, fallback chủ
    sở hữu nếu dữ liệu cũ chưa có), email gì, workspace nào, gửi lúc nào — mới nhất
    trước. Phục vụ dropdown chuông + nút 'Xác nhận' nhanh. Sub-admin không duyệt → [].
    """
    if not user.is_super_admin:
        return []
    stmt = (
        select(Member)
        .options(
            selectinload(Member.workspace),
            selectinload(Member.payment_requested_by),
            selectinload(Member.invited_by),
        )
        .where(Member.status != "removed", Member.payment_status == "requested")
        .order_by(Member.payment_requested_at.desc().nullslast())
    )
    notices: list[PaymentRequestNotice] = []
    for member in db.execute(stmt).scalars():
        requester = member.payment_requested_by or member.invited_by
        notices.append(
            PaymentRequestNotice(
                member_id=member.id,
                email=member.email,
                workspace_name=member.workspace.name if member.workspace else None,
                requested_by_username=requester.username if requester else None,
                requested_at=member.payment_requested_at,
            )
        )
    return notices


@router.get("/{member_id}", response_model=AddedMemberOut)
def get_added_member(
    member_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AddedMemberOut:
    """1 email theo id — CÙNG hình dạng 1 dòng của danh sách (kèm chu kỳ, chủ, ws).

    Dùng cho modal "Chi tiết thành viên": bấm email ở mũi tên "đã đổi sang" để nhảy
    sang chi tiết email nhận. Email nhận thường KHÔNG nằm trong danh sách đang mở
    (nó còn sống, còn danh sách là tab "Đã xoá"; có khi lại khác workspace) nên
    không tra được từ dữ liệu đã nạp — phải hỏi thẳng theo id.

    Quyền: super-admin xem mọi email; sub-admin chỉ email CHÍNH MÌNH add (giống luật
    ai-thấy-gì của danh sách). Ngoài tầm nhìn → 404 y như không tồn tại.
    """
    member = db.execute(
        select(Member)
        .options(
            selectinload(Member.workspace),
            selectinload(Member.invited_by),
            selectinload(Member.subscription_cycles),
        )
        .where(Member.id == member_id)
    ).scalar_one_or_none()
    if member is None or (
        not user.is_super_admin and member.invited_by_user_id != user.id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Member not found"
        )

    _recompute_member_payment_status(member)
    out = AddedMemberOut.model_validate(member)
    out.workspace_name = member.workspace.name if member.workspace else None
    out.invited_by_username = member.invited_by.username if member.invited_by else None
    out.cycles = [
        SubscriptionCycleOut.model_validate(c) for c in member.subscription_cycles
    ]
    # Email nhận có thể ĐÃ ĐỔI TIẾP (A → B → C): giữ chuỗi để bấm đi tiếp được.
    # Bản đồ đổi email quét cả bảng nhật ký → chỉ dựng khi email này ĐÚNG là ca đổi.
    if member.removed_reason == REMOVED_REASON_EMAIL_CHANGED:
        chain, chain_ids = _email_change_chain(member, _email_change_next_map(db))
        out.email_changed_to = chain
        out.email_changed_to_ids = chain_ids
    return out


def _load_cycles_with_member(
    db: Session, cycle_ids: list[UUID]
) -> list[MemberSubscriptionCycle]:
    """Nạp chu kỳ kèm member + toàn bộ chu kỳ của member đó (phục vụ recompute)."""
    if not cycle_ids:
        return []
    return list(
        db.execute(
            select(MemberSubscriptionCycle)
            .options(
                selectinload(MemberSubscriptionCycle.member).selectinload(
                    Member.subscription_cycles
                )
            )
            .where(MemberSubscriptionCycle.id.in_(cycle_ids))
        ).scalars()
    )


@router.post("/request-payment", response_model=dict)
def request_members_payment(
    body: MemberRequestPaymentIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Bước 1 — gửi (hoặc rút) yêu cầu duyệt thanh toán theo CHU KỲ hoặc theo email.

    Sub-admin chỉ thao tác trên email mình đã add; super-admin thao tác mọi email.
    - cycle_ids: gửi/rút yêu cầu cho TỪNG chu kỳ (đường chính — tab Email đã add).
    - member_ids: áp cho MỌI chu kỳ của email (email không có chu kỳ → thao tác trực
      tiếp field member, tương thích dữ liệu cũ vô thời hạn).

    requested=True : chỉ kỳ đang 'unpaid' → 'requested'. requested=False: 'requested' → 'unpaid'.
    Sau đó tính lại Member.payment_status tổng hợp.
    """
    now = datetime.now(timezone.utc)
    affected: dict[UUID, Member] = {}
    updated = 0

    def owns(member: Member) -> bool:
        return user.is_super_admin or member.invited_by_user_id == user.id

    def apply_cycle(cycle: MemberSubscriptionCycle) -> None:
        nonlocal updated
        if body.requested:
            if cycle.payment_status != "unpaid":
                return
            cycle.payment_status = "requested"
            cycle.payment_requested_at = now
            cycle.payment_requested_by_id = user.id
        else:
            if cycle.payment_status != "requested":
                return
            cycle.payment_status = "unpaid"
            cycle.payment_requested_at = None
            cycle.payment_requested_by_id = None
        updated += 1

    # Đường CHU KỲ.
    for cycle in _load_cycles_with_member(db, body.cycle_ids):
        if cycle.member is None or not owns(cycle.member):
            continue
        apply_cycle(cycle)
        affected[cycle.member.id] = cycle.member

    # Đường EMAIL.
    if body.member_ids:
        members = db.execute(
            select(Member)
            .options(selectinload(Member.subscription_cycles))
            .where(Member.id.in_(body.member_ids))
        ).scalars()
        for member in members:
            if not owns(member):
                continue
            if member.subscription_cycles:
                for cycle in member.subscription_cycles:
                    apply_cycle(cycle)
            else:
                # Legacy — email không có chu kỳ: thao tác trực tiếp field member.
                if body.requested and member.payment_status == "unpaid":
                    member.payment_status = "requested"
                    member.payment_requested_at = now
                    member.payment_requested_by_id = user.id
                    updated += 1
                elif not body.requested and member.payment_status == "requested":
                    member.payment_status = "unpaid"
                    member.payment_requested_at = None
                    member.payment_requested_by_id = None
                    updated += 1
            affected[member.id] = member

    for member in affected.values():
        _recompute_member_payment_status(member)

    if updated:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_PAYMENT_REQUESTED",
            result="OK",
            target_type="MEMBER",
            target_id=str(next(iter(affected))) if len(affected) == 1 else None,
            data={
                "requested": body.requested,
                "count": updated,
                "member_ids": [str(mid) for mid in affected],
            },
            commit=False,
        )
        db.commit()
    return {"count": updated, "requested": body.requested}


@router.post("/mark-paid", response_model=dict)
def mark_members_paid(
    body: MemberMarkPaidIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Bước 2 — super-admin xác nhận (hoặc huỷ) thanh toán theo CHU KỲ hoặc theo email.

    CHỈ super-admin. paid=True → 'paid'; paid=False → 'unpaid' + xoá dấu vết yêu cầu.
    - cycle_ids: xác nhận từng chu kỳ (đường chính). - member_ids: áp mọi chu kỳ email
      (email không có chu kỳ → field member trực tiếp). Recompute Member.payment_status.
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được xác nhận thanh toán",
        )
    now = datetime.now(timezone.utc)
    affected: dict[UUID, Member] = {}
    updated = 0

    def apply_cycle(cycle: MemberSubscriptionCycle) -> None:
        nonlocal updated
        if body.paid:
            cycle.payment_status = "paid"
            cycle.paid_at = now
            cycle.paid_marked_by_id = user.id
        else:
            cycle.payment_status = "unpaid"
            cycle.paid_at = None
            cycle.paid_marked_by_id = None
            cycle.payment_requested_at = None
            cycle.payment_requested_by_id = None
        updated += 1

    for cycle in _load_cycles_with_member(db, body.cycle_ids):
        if cycle.member is None:
            continue
        apply_cycle(cycle)
        affected[cycle.member.id] = cycle.member

    if body.member_ids:
        members = db.execute(
            select(Member)
            .options(selectinload(Member.subscription_cycles))
            .where(Member.id.in_(body.member_ids))
        ).scalars()
        for member in members:
            if member.subscription_cycles:
                for cycle in member.subscription_cycles:
                    apply_cycle(cycle)
            else:
                member.payment_status = "paid" if body.paid else "unpaid"
                member.paid_at = now if body.paid else None
                member.paid_marked_by_id = user.id if body.paid else None
                if not body.paid:
                    member.payment_requested_at = None
                    member.payment_requested_by_id = None
                updated += 1
            affected[member.id] = member

    for member in affected.values():
        _recompute_member_payment_status(member)

    if updated:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_PAYMENT_MARKED",
            result="OK",
            target_type="MEMBER",
            target_id=str(next(iter(affected))) if len(affected) == 1 else None,
            data={
                "paid": body.paid,
                "count": updated,
                "member_ids": [str(mid) for mid in affected],
            },
            commit=False,
        )
        db.commit()
    return {"count": updated, "paid": body.paid}


@router.post("/bulk-set-expiry", response_model=dict)
def bulk_set_members_expiry(
    body: MemberBulkSetExpiryIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Cập nhật hàng loạt hạn dùng (subscription_end_at) theo từng email.

    Mỗi item = (member_id, end_at đã chốt). Quy tắc duyệt (giống members/subscription.py):
      - SUPER-ADMIN: áp NGAY (tự duyệt) — set subscription_end_at, subscription_months=
        None (đã chuyển sang mốc ngày cụ thể) và xoá mọi yêu cầu đổi hạn đang chờ.
      - SUB-ADMIN  : KHÔNG áp ngay → tạo YÊU CẦU đổi hạn chờ super-admin duyệt
        (subscription_request_status='requested' + pending_subscription_end_at). Chỉ
        thao tác trên email mình sở hữu (invited_by_user_id == user.id), email khác bị
        bỏ qua. Super-admin duyệt qua /subscription-requests/approve (chuông thông báo).
    end_at None = đặt vô thời hạn. member_id không tồn tại / không thuộc quyền bị bỏ
    qua (không tính count). Trả về {count, requested}: requested=True nếu là yêu cầu.
    """
    by_id = {item.member_id: item.end_at for item in body.items}
    members = list(
        db.execute(select(Member).where(Member.id.in_(by_id.keys()))).scalars()
    )
    now = datetime.now(timezone.utc)
    is_super = user.is_super_admin
    updated_ids: list[str] = []
    for member in members:
        # Sub-admin chỉ đổi hạn email mình đã add; super-admin thao tác mọi email.
        if not is_super and member.invited_by_user_id != user.id:
            continue
        target_end = by_id[member.id]
        if is_super:
            member.subscription_end_at = target_end
            member.subscription_months = None
            # Chốt hạn = tự duyệt → xoá mọi yêu cầu đổi hạn đang chờ (nếu có).
            member.subscription_request_status = "none"
            member.pending_subscription_months = None
            member.pending_subscription_end_at = None
            member.subscription_requested_at = None
            member.subscription_requested_by_id = None
        else:
            # Sub-admin — KHÔNG áp dụng, tạo yêu cầu chờ super-admin duyệt.
            member.subscription_request_status = "requested"
            member.pending_subscription_months = None
            member.pending_subscription_end_at = target_end
            member.subscription_requested_at = now
            member.subscription_requested_by_id = user.id
        updated_ids.append(str(member.id))

    if updated_ids:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_EXPIRY_BULK_SET"
            if is_super
            else "MEMBER_EXPIRY_BULK_REQUESTED",
            result="OK" if is_super else "PENDING",
            target_type="MEMBER",
            target_id=updated_ids[0] if len(updated_ids) == 1 else None,
            data={"count": len(updated_ids), "member_ids": updated_ids},
            commit=False,
        )
        db.commit()
    return {"count": len(updated_ids), "requested": not is_super}


@router.post("/revoke-owner", response_model=dict)
def revoke_members_owner(
    body: MemberRevokeOwnerIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Super-admin THU HỒI quyền sở hữu nhiều email → về 'email còn lại' (NULL).

    Chỉ super-admin. Email sau thu hồi không còn thuộc tài khoản phụ nào, super-admin
    quản lý (xem qua ?unassigned=true) và có thể gán lại nếu cần.
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được thu hồi quyền sở hữu",
        )
    members = list(
        db.execute(select(Member).where(Member.id.in_(body.member_ids))).scalars()
    )
    revoked_ids: list[str] = []
    for member in members:
        if member.invited_by_user_id is None:
            continue
        member.invited_by_user_id = None
        revoked_ids.append(str(member.id))

    if revoked_ids:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_OWNER_REVOKED",
            result="OK",
            target_type="MEMBER",
            target_id=revoked_ids[0] if len(revoked_ids) == 1 else None,
            data={"count": len(revoked_ids), "member_ids": revoked_ids},
            commit=False,
        )
        db.commit()
    return {"count": len(revoked_ids)}


@router.post("/transfer-owner", response_model=dict)
def transfer_members_owner(
    body: MemberTransferOwnerIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Super-admin chuyển quyền sở hữu nhiều email sang `target_user_id`.

    - 'Thu hồi về admin': frontend truyền target = id của super-admin đang thao tác.
    - 'Chuyển cho sub-admin': target = id sub-admin đích.
    Chỉ super-admin. Email không thay đổi (đã đúng chủ) bị bỏ qua khỏi count.
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được chuyển quyền sở hữu",
        )
    target = db.get(User, body.target_user_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tài khoản nhận quyền sở hữu không tồn tại",
        )
    members = list(
        db.execute(select(Member).where(Member.id.in_(body.member_ids))).scalars()
    )
    # Chủ cũ khác nhau tuỳ member → tra tên chủ cũ để log "a → b" cho TỪNG email.
    prev_owner_ids = {
        m.invited_by_user_id for m in members if m.invited_by_user_id is not None
    }
    prev_usernames: dict[UUID, str] = {}
    if prev_owner_ids:
        prev_usernames = {
            u.id: u.username
            for u in db.execute(
                select(User).where(User.id.in_(prev_owner_ids))
            ).scalars()
        }
    changed_ids: list[str] = []
    # entries[]: chủ cũ của từng member (member detail khớp theo member_id để hiện
    # "a → b"). Chủ cũ = None → member trước đó "chưa có chủ".
    entries: list[dict] = []
    for member in members:
        if member.invited_by_user_id == body.target_user_id:
            continue
        from_username = (
            prev_usernames.get(member.invited_by_user_id)
            if member.invited_by_user_id is not None
            else None
        )
        member.invited_by_user_id = body.target_user_id
        changed_ids.append(str(member.id))
        entries.append(
            {"member_id": str(member.id), "from_username": from_username}
        )

    if changed_ids:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_OWNER_TRANSFERRED",
            result="OK",
            target_type="MEMBER",
            target_id=changed_ids[0] if len(changed_ids) == 1 else None,
            data={
                "count": len(changed_ids),
                "target_user_id": str(body.target_user_id),
                "target_username": target.username,
                "member_ids": changed_ids,
                "entries": entries,
            },
            commit=False,
        )
        db.commit()
    return {
        "count": len(changed_ids),
        "target_user_id": str(body.target_user_id),
        "target_username": target.username,
    }
