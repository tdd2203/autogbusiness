"""Ví — số dư & lịch sử giao dịch của user hiện tại."""

from fastapi import Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_wallet_enabled
from app.models import User, WalletTransaction
from app.schemas import WalletOut, WalletTxnOut, WalletTxnPage
from app.services import payment_flow, wallet_service

from ._shared import get_payment_settings, router


@router.get("", response_model=WalletOut)
def get_wallet(
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> WalletOut:
    wallet = wallet_service.get_or_create_wallet(db, user.id)
    db.commit()
    settings_row = get_payment_settings(db)
    db.commit()
    # Phí mời/gia hạn HIỆU LỰC cho user này = COALESCE(user.invite_fee_vnd, global
    # default) — KHÔNG trả global thô, để "tổng tiền cần thanh toán" hiển thị ở
    # modal Mời/Gia hạn khớp đúng phí sẽ bị trừ (đại lý có phí riêng vẫn đúng).
    # Override theo member (member.fee_vnd) áp riêng ở modal có member cụ thể.
    effective_fee = payment_flow.effective_fee(
        None, user, int(settings_row.invite_fee_vnd or 0)
    )
    return WalletOut(
        balance=wallet.balance,
        held=wallet.held,
        total=wallet.balance + wallet.held,
        wallet_beta=user.wallet_beta,
        invite_fee_vnd=effective_fee,
    )


@router.get("/transactions", response_model=WalletTxnPage)
def list_transactions(
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
    limit: int = Query(50, ge=1, le=200),
) -> WalletTxnPage:
    rows = (
        db.execute(
            select(WalletTransaction)
            .where(WalletTransaction.user_id == user.id)
            .order_by(WalletTransaction.seq.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return WalletTxnPage(items=[WalletTxnOut.model_validate(r) for r in rows], next_cursor=None)
