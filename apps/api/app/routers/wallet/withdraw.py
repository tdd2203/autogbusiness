"""Ví — gửi & xem yêu cầu rút tiền của user hiện tại."""

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.action_limit import enforce_action_cooldown
from app.deps import get_session, require_wallet_enabled
from app.models import User, WithdrawalRequest
from app.schemas import WithdrawalCreateIn, WithdrawalOut
from app.services import wallet_service
from app.services.wallet_service import InsufficientBalance

from ._shared import router


@router.post("/withdrawals", response_model=WithdrawalOut, status_code=status.HTTP_201_CREATED)
def create_withdrawal(
    body: WithdrawalCreateIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> WithdrawalOut:
    enforce_action_cooldown(db, user, "WALLET_WITHDRAW")
    request = WithdrawalRequest(
        user_id=user.id,
        amount_vnd=body.amount_vnd,
        bank_account=body.bank_account.strip(),
        note=body.note,
        status="pending",
    )
    db.add(request)
    db.flush()  # cần id cho ref của giao dịch hold
    try:
        hold_txn = wallet_service.create_withdrawal_hold(db, user, request)
    except InsufficientBalance as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "INSUFFICIENT_BALANCE",
                "message": "Số dư khả dụng không đủ để rút",
                "available": e.available,
                "requested": e.requested,
                "shortfall": e.shortfall,
            },
        ) from e
    request.hold_txn_id = hold_txn.id
    db.add(request)
    db.commit()
    db.refresh(request)
    return WithdrawalOut.model_validate(request)


@router.get("/withdrawals", response_model=list[WithdrawalOut])
def list_my_withdrawals(
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> list[WithdrawalOut]:
    rows = (
        db.execute(
            select(WithdrawalRequest)
            .where(WithdrawalRequest.user_id == user.id)
            .order_by(WithdrawalRequest.created_at.desc())
            .limit(100)
        )
        .scalars()
        .all()
    )
    return [WithdrawalOut.model_validate(r) for r in rows]
