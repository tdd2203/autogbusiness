"""Ví — endpoint quản trị (super-admin only): cấu hình phí/bank, cờ beta per-user,
xem ví mọi user, nạp demo (adjust), duyệt yêu cầu rút."""

from datetime import date as date_type
from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.config import get_settings
from app.deps import get_session, require_super_admin
from app.models import (
    Member,
    PaymentOrder,
    QueueItem,
    TopupOrder,
    User,
    Wallet,
    WalletTransaction,
    WithdrawalRequest,
    Workspace,
)
from app.schemas import (
    MemberFeeIn,
    MemberOut,
    PaymentSettingsIn,
    PaymentSettingsOut,
    UserFeeIn,
    WalletAdjustIn,
    WalletAdminUserOut,
    WalletBetaIn,
    WalletTxnAdminOut,
    WalletTxnAdminPage,
    WalletTxnOut,
    WithdrawalAdminOut,
    WithdrawalOut,
    WithdrawalRejectIn,
)
from app.services import sepay_ledger, wallet_service

from ._shared import get_payment_settings, router


def _settings_out(db: Session) -> PaymentSettingsOut:
    s = get_payment_settings(db)
    env = get_settings()
    webhook_url = f"{env.frontend_origin.rstrip('/')}/webhook/sepay" if env.frontend_origin else "/webhook/sepay"
    method = s.sepay_auth_method or "apikey"
    apikey_ok = bool(env.sepay_apikey)
    hmac_ok = bool(env.sepay_webhook_secret)
    # "configured" = secret của method ĐANG CHỌN đã có (none luôn coi là đủ).
    configured = method == "none" or (method == "apikey" and apikey_ok) or (method == "hmac" and hmac_ok)
    return PaymentSettingsOut(
        invite_fee_vnd=s.invite_fee_vnd,
        bank_name=s.bank_name,
        account_number=s.account_number,
        account_name=s.account_name,
        code_prefix=s.code_prefix,
        amount_tolerance_vnd=s.amount_tolerance_vnd,
        payment_codes=s.payment_codes or [],
        sepay_auth_method=method,
        sepay_apikey_configured=apikey_ok,
        sepay_hmac_secret_configured=hmac_ok,
        sepay_webhook_configured=configured,
        webhook_url=webhook_url,
    )


# ── Cấu hình thanh toán ─────────────────────────────────────────────────────

@router.get("/admin/settings", response_model=PaymentSettingsOut)
def get_settings_endpoint(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> PaymentSettingsOut:
    out = _settings_out(db)
    db.commit()
    return out


@router.put("/admin/settings", response_model=PaymentSettingsOut)
def update_settings(
    body: PaymentSettingsIn,
    db: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
) -> PaymentSettingsOut:
    s = get_payment_settings(db)
    fields = body.model_dump(exclude_unset=True)
    for key, value in fields.items():
        setattr(s, key, value)
    s.updated_by_id = admin.id
    s.updated_at = datetime.now(timezone.utc)
    db.add(s)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=admin.id,
        actor_label=admin.email,
        action="PAYMENT_SETTINGS_UPDATED",
        target_type="PAYMENT_SETTINGS",
        target_id="1",
        data=fields,
        commit=False,
    )
    db.commit()
    return _settings_out(db)


# ── Cờ thử nghiệm per-user + xem ví ─────────────────────────────────────────

@router.get("/admin/users", response_model=list[WalletAdminUserOut])
def list_users(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> list[WalletAdminUserOut]:
    users = db.execute(select(User).order_by(User.created_at.asc())).scalars().all()
    wallets = {
        w.user_id: w
        for w in db.execute(select(Wallet)).scalars().all()
    }
    out: list[WalletAdminUserOut] = []
    for u in users:
        w = wallets.get(u.id)
        out.append(
            WalletAdminUserOut(
                user_id=u.id,
                username=u.username,
                email=u.email,
                wallet_beta=u.wallet_beta,
                is_super_admin=u.is_super_admin,
                balance=w.balance if w else 0,
                held=w.held if w else 0,
                invite_fee_vnd=u.invite_fee_vnd,
            )
        )
    return out


@router.put("/admin/users/{user_id}/beta")
def toggle_beta(
    user_id: UUID,
    body: WalletBetaIn,
    db: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
) -> dict:
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User không tồn tại")
    target.wallet_beta = body.enabled
    db.add(target)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=admin.id,
        actor_label=admin.email,
        action="WALLET_BETA_TOGGLED",
        target_type="USER",
        target_id=str(user_id),
        data={"enabled": body.enabled},
        commit=False,
    )
    db.commit()
    return {"user_id": str(user_id), "wallet_beta": target.wallet_beta}


@router.put("/admin/users/{user_id}/fee")
def set_user_fee(
    user_id: UUID,
    body: UserFeeIn,
    db: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
) -> dict:
    """Super-admin đặt/xoá phí mời MẶC ĐỊNH của 1 user (đại lý) — feature 003, user
    2026-07-13. `invite_fee_vnd=null` → về phí mặc định toàn hệ thống. Áp cho lần
    mời/gia hạn kế tiếp; member có phí RIÊNG (members.fee_vnd) vẫn override phí này."""
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User không tồn tại")
    target.invite_fee_vnd = body.invite_fee_vnd
    db.add(target)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=admin.id,
        actor_label=admin.email,
        action="USER_FEE_SET",
        target_type="USER",
        target_id=str(user_id),
        data={"invite_fee_vnd": body.invite_fee_vnd},
        commit=False,
    )
    db.commit()
    return {"user_id": str(user_id), "invite_fee_vnd": target.invite_fee_vnd}


@router.put("/admin/members/{member_id}/fee", response_model=MemberOut)
def set_member_fee(
    member_id: UUID,
    body: MemberFeeIn,
    db: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
) -> Member:
    """Super-admin đặt/xoá phí mời RIÊNG cho 1 member (feature 003). `fee_vnd=null`
    → về phí mặc định. Áp cho lần mời/gia hạn kế tiếp (không hồi tố lời mời đã trừ)."""
    member = db.get(Member, member_id)
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member không tồn tại")
    member.fee_vnd = body.fee_vnd
    db.add(member)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=admin.id,
        actor_label=admin.email,
        action="MEMBER_FEE_SET",
        target_type="MEMBER",
        target_id=str(member_id),
        data={"fee_vnd": body.fee_vnd},
        commit=False,
    )
    db.commit()
    db.refresh(member)
    return member


def _as_uuid(value: str | None) -> UUID | None:
    """`ref_id` lưu dạng chuỗi nên có thể không phải UUID (bút toán cũ) — không parse
    được thì bỏ qua chứ đừng làm hỏng cả trang lịch sử."""
    if not value:
        return None
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _fetch_map(db: Session, model, ids: set[UUID]) -> dict[UUID, object]:
    """Tra hàng loạt theo khoá chính — 1 truy vấn / bảng, tránh N+1 trên 500 dòng."""
    if not ids:
        return {}
    rows = db.execute(select(model).where(model.id.in_(ids))).scalars().all()
    return {r.id: r for r in rows}


def _enrich_txns(db: Session, rows: list[WalletTransaction]) -> list[WalletTxnAdminOut]:
    """Gắn dữ liệu ĐỐI SOÁT vào từng bút toán cho trang quản trị.

    Sổ cái chỉ lưu `ref_type` + `ref_id` trần, nhìn vào một chuỗi UUID thì không
    biết tiền đó đổi lấy cái gì. Ở đây dịch ngược ra mã hoá đơn, trạng thái lệnh,
    workspace và người bấm nút — đủ để đối soát mà không phải mở audit log.
    """
    topup_ids: set[UUID] = set()
    order_ids: set[UUID] = set()
    queue_ids: set[UUID] = set()
    member_ids: set[UUID] = set()
    withdrawal_ids: set[UUID] = set()
    actor_ids: set[UUID] = set()
    for r in rows:
        if r.actor_id:
            actor_ids.add(r.actor_id)
        rid = _as_uuid(r.ref_id)
        if rid is None:
            continue
        # `credit_duplicate_invoice` ghi ref_type="topup" nhưng ref_id lại là id hoá
        # đơn → tra cả hai bảng, bảng nào có thì dùng.
        if r.ref_type == "topup":
            topup_ids.add(rid)
            order_ids.add(rid)
        elif r.ref_type == "order":
            order_ids.add(rid)
        elif r.ref_type == "invite":
            queue_ids.add(rid)
        elif r.ref_type == "renew":
            member_ids.add(rid)
        elif r.ref_type == "withdrawal":
            withdrawal_ids.add(rid)

    topups = _fetch_map(db, TopupOrder, topup_ids)
    orders = _fetch_map(db, PaymentOrder, order_ids)
    # Hoá đơn còn trỏ tiếp sang lệnh/thành viên nó sinh ra — gộp vào lượt tra sau.
    for o in orders.values():
        if o.queue_item_id:
            queue_ids.add(o.queue_item_id)
        if o.member_id:
            member_ids.add(o.member_id)
    queues = _fetch_map(db, QueueItem, queue_ids)
    members = _fetch_map(db, Member, member_ids)
    withdrawals = _fetch_map(db, WithdrawalRequest, withdrawal_ids)
    actors = _fetch_map(db, User, actor_ids)

    ws_ids = {
        w
        for w in (
            [o.workspace_id for o in orders.values()]
            + [q.workspace_id for q in queues.values()]
            + [m.workspace_id for m in members.values()]
        )
        if w
    }
    workspaces = _fetch_map(db, Workspace, ws_ids)

    out: list[WalletTxnAdminOut] = []
    for r in rows:
        item = WalletTxnAdminOut.model_validate(r)
        meta = r.meta or {}
        actor = actors.get(r.actor_id) if r.actor_id else None
        item.actor_email = actor.email if actor else None
        raw_email = meta.get("email")
        item.member_email = str(raw_email) if isinstance(raw_email, str) and raw_email else None

        rid = _as_uuid(r.ref_id)
        order = None
        if r.ref_type == "topup":
            topup = topups.get(rid) if rid else None
            if topup is not None:
                item.ref_code = topup.ref_code
                item.ref_status = topup.status
            else:
                # Trả trùng hoá đơn: tiền vào ví nhưng ref trỏ về hoá đơn cũ.
                order = orders.get(rid) if rid else None
                raw_ref = meta.get("order_ref")
                if isinstance(raw_ref, str) and raw_ref:
                    item.ref_code = raw_ref
        elif r.ref_type == "order":
            order = orders.get(rid) if rid else None
        elif r.ref_type == "invite":
            item.queue_item_id = rid
        elif r.ref_type == "renew":
            member = members.get(rid) if rid else None
            if member is not None:
                item.member_email = item.member_email or member.email
                item.workspace_id = member.workspace_id
        elif r.ref_type == "withdrawal":
            req = withdrawals.get(rid) if rid else None
            if req is not None:
                item.ref_status = req.status

        if order is not None:
            item.ref_code = item.ref_code or order.ref_code
            item.ref_status = item.ref_status or order.status
            item.queue_item_id = order.queue_item_id
            item.workspace_id = order.workspace_id
            if order.member_id and not item.member_email:
                member = members.get(order.member_id)
                if member is not None:
                    item.member_email = member.email

        queue = queues.get(item.queue_item_id) if item.queue_item_id else None
        if queue is not None:
            item.queue_item_type = queue.type
            item.ref_status = item.ref_status or queue.status
            item.workspace_id = item.workspace_id or queue.workspace_id

        ws = workspaces.get(item.workspace_id) if item.workspace_id else None
        item.workspace_name = ws.name if ws is not None else None

        # Mã giao dịch SePay: `meta` có sẵn ở bút toán do webhook ghi; bút toán cũ
        # thiếu thì lấy từ chính lệnh nạp/hoá đơn. Cùng mã in trên sao kê ngân hàng.
        raw_provider = meta.get("provider_txn_id")
        item.provider_txn_id = (
            str(raw_provider) if isinstance(raw_provider, str) and raw_provider else None
        )
        if item.provider_txn_id is None:
            src = topups.get(rid) if rid else None
            item.provider_txn_id = (src or order).provider_txn_id if (src or order) else None

        out.append(item)
    return out


@router.get("/admin/users/{user_id}/transactions", response_model=WalletTxnAdminPage)
def user_transactions(
    user_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
    limit: int = Query(100, ge=1, le=500),
    before_seq: int | None = Query(None, description="Con trỏ: chỉ lấy bút toán cũ hơn seq này."),
    date: date_type | None = Query(None, description="Chỉ lấy bút toán trong NGÀY này (giờ VN)."),
) -> WalletTxnAdminPage:
    """Lịch sử ví của MỘT user (super-admin). Cùng luật phân trang với
    `GET /wallet/transactions` — xem giải thích ở routers/wallet/balance.py.

    Khác bản của người dùng ở chỗ mỗi bút toán được gắn thêm dữ liệu đối soát
    (mã hoá đơn, lệnh, workspace, người thực hiện) — xem `_enrich_txns`."""
    q = select(WalletTransaction).where(WalletTransaction.user_id == user_id)
    if date is not None:
        start, end = sepay_ledger.day_bounds(date)
        q = q.where(WalletTransaction.created_at >= start, WalletTransaction.created_at < end)
    if before_seq is not None:
        q = q.where(WalletTransaction.seq < before_seq)
    rows = (
        db.execute(q.order_by(WalletTransaction.seq.desc()).limit(limit + 1)).scalars().all()
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    return WalletTxnAdminPage(
        items=_enrich_txns(db, list(rows)),
        next_cursor=str(rows[-1].seq) if has_more and rows else None,
    )


@router.post("/admin/users/{user_id}/adjust", response_model=WalletTxnOut)
def adjust_balance(
    user_id: UUID,
    body: WalletAdjustIn,
    db: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
) -> WalletTxnOut:
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User không tồn tại")
    try:
        txn = wallet_service.adjust(db, user_id, body.amount_vnd, actor=admin, reason=body.reason)
    except wallet_service.InsufficientBalance as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "INSUFFICIENT_BALANCE", "message": "Điều chỉnh làm số dư âm", "available": e.available},
        ) from e
    db.commit()
    db.refresh(txn)
    return WalletTxnOut.model_validate(txn)


# ── Duyệt yêu cầu rút ───────────────────────────────────────────────────────

@router.get("/admin/withdrawals", response_model=list[WithdrawalAdminOut])
def list_withdrawals(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
    status_filter: str | None = Query(default="pending", alias="status"),
) -> list[WithdrawalAdminOut]:
    stmt = select(WithdrawalRequest, User).join(User, WithdrawalRequest.user_id == User.id)
    if status_filter:
        stmt = stmt.where(WithdrawalRequest.status == status_filter)
    rows = db.execute(stmt.order_by(WithdrawalRequest.created_at.desc()).limit(200)).all()
    out: list[WithdrawalAdminOut] = []
    for req, u in rows:
        out.append(
            WithdrawalAdminOut(
                id=req.id,
                amount_vnd=req.amount_vnd,
                bank_account=req.bank_account,
                status=req.status,
                note=req.note,
                reject_reason=req.reject_reason,
                created_at=req.created_at,
                reviewed_at=req.reviewed_at,
                user_id=u.id,
                username=u.username,
                user_email=u.email,
            )
        )
    return out


def _get_pending_withdrawal(db: Session, wid: UUID) -> WithdrawalRequest:
    req = db.get(WithdrawalRequest, wid)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Yêu cầu rút không tồn tại")
    if req.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Yêu cầu đã ở trạng thái '{req.status}', không xử lý lại",
        )
    return req


@router.post("/admin/withdrawals/{wid}/settle", response_model=WithdrawalOut)
def settle_withdrawal(
    wid: UUID,
    db: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
) -> WithdrawalOut:
    req = _get_pending_withdrawal(db, wid)
    txn = wallet_service.settle_withdrawal(db, req, admin)
    req.status = "settled"
    req.settle_txn_id = txn.id
    req.reviewed_by_id = admin.id
    req.reviewed_at = datetime.now(timezone.utc)
    db.add(req)
    db.commit()
    db.refresh(req)
    return WithdrawalOut.model_validate(req)


@router.post("/admin/withdrawals/{wid}/reject", response_model=WithdrawalOut)
def reject_withdrawal(
    wid: UUID,
    body: WithdrawalRejectIn,
    db: Session = Depends(get_session),
    admin: User = Depends(require_super_admin),
) -> WithdrawalOut:
    req = _get_pending_withdrawal(db, wid)
    txn = wallet_service.reject_withdrawal(db, req, admin)
    req.status = "rejected"
    req.reject_reason = body.reason
    req.settle_txn_id = txn.id
    req.reviewed_by_id = admin.id
    req.reviewed_at = datetime.now(timezone.utc)
    db.add(req)
    db.commit()
    db.refresh(req)
    return WithdrawalOut.model_validate(req)
