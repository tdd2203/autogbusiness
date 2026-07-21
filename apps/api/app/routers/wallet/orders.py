"""Ví — hoá đơn thanh toán QR cho mời/gia hạn (feature 003, user 2026-07-13).

Hoá đơn tạo TỰ ĐỘNG khi ví không đủ (ở luồng mời/gia hạn), KHÔNG tạo trực tiếp qua
API này. Endpoint ở đây chỉ để FE POLL trạng thái (chờ webhook nhận tiền → paid →
tự thực thi) + liệt kê lịch sử hoá đơn của chính user.
"""

from uuid import UUID

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_wallet_enabled
from app.models import PaymentOrder, User
from app.schemas import PaymentOrderOut
from app.services import payment_flow

from ._shared import router


def _lazy_expire(db: Session, order: PaymentOrder) -> None:
    """Đánh dấu 'expired' nếu hoá đơn còn 'pending' nhưng đã quá 10 phút (mã QR chỉ
    tồn tại 10 phút — user 2026-07-14). Để FE poll thấy trạng thái hết hạn ngay; job
    nền (main._purge_stale_orders_once) dọn dẹp lệnh quá hạn/không trả tiền."""
    if order.status == "pending" and payment_flow.is_order_expired(order):
        order.status = "expired"
        db.add(order)
        db.commit()
        db.refresh(order)


@router.get("/orders", response_model=list[PaymentOrderOut])
def list_orders(
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
    status_filter: str | None = Query(default=None, alias="status"),
) -> list[PaymentOrderOut]:
    stmt = select(PaymentOrder).where(PaymentOrder.user_id == user.id)
    if status_filter:
        stmt = stmt.where(PaymentOrder.status == status_filter)
    rows = db.execute(stmt.order_by(PaymentOrder.created_at.desc()).limit(100)).scalars().all()
    return [PaymentOrderOut.model_validate(r) for r in rows]


@router.get("/orders/{order_id}", response_model=PaymentOrderOut)
def get_order(
    order_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> PaymentOrderOut:
    order = db.get(PaymentOrder, order_id)
    if order is None or order.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Hoá đơn không tồn tại")
    _lazy_expire(db, order)
    return PaymentOrderOut.model_validate(order)
