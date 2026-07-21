"""Ví — endpoint quản trị (super-admin only): cấu hình phí/bank, cờ beta per-user,
xem ví mọi user, nạp demo (adjust), duyệt yêu cầu rút."""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.config import get_settings
from app.deps import get_session, require_super_admin
from app.models import Member, User, Wallet, WalletTransaction, WithdrawalRequest
from app.schemas import (
    MemberFeeIn,
    MemberOut,
    PaymentSettingsIn,
    PaymentSettingsOut,
    UserFeeIn,
    WalletAdjustIn,
    WalletAdminUserOut,
    WalletBetaIn,
    WalletTxnOut,
    WalletTxnPage,
    WithdrawalAdminOut,
    WithdrawalOut,
    WithdrawalRejectIn,
)
from app.services import wallet_service

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


@router.get("/admin/users/{user_id}/transactions", response_model=WalletTxnPage)
def user_transactions(
    user_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
    limit: int = Query(100, ge=1, le=500),
) -> WalletTxnPage:
    rows = (
        db.execute(
            select(WalletTransaction)
            .where(WalletTransaction.user_id == user_id)
            .order_by(WalletTransaction.seq.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return WalletTxnPage(items=[WalletTxnOut.model_validate(r) for r in rows], next_cursor=None)


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
