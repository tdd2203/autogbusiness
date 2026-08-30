"""Ví — tạo lệnh nạp (trả QR) + poll trạng thái nạp."""

import secrets
from uuid import UUID

from fastapi import Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.action_limit import enforce_action_cooldown
from app.deps import get_session, require_wallet_enabled
from app.models import TopupOrder, User
from app.schemas import TopupCreatedOut, TopupCreateIn, TopupOut
from app.sepay import build_transfer_note, qr_image_url

from ._shared import ensure_topup_code, get_payment_settings, router, topup_prefix

# Số tiền nạp tối thiểu (VND) — tránh lệnh rác.
MIN_TOPUP_VND = 10_000


@router.post("/topups", response_model=TopupCreatedOut, status_code=status.HTTP_201_CREATED)
def create_topup(
    body: TopupCreateIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> TopupCreatedOut:
    if body.amount_vnd < MIN_TOPUP_VND:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "AMOUNT_INVALID", "message": f"Số tiền nạp tối thiểu {MIN_TOPUP_VND:,}đ"},
        )
    settings_row = get_payment_settings(db)
    if not (settings_row.bank_name and settings_row.account_number):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BANK_NOT_CONFIGURED", "message": "Super-admin chưa cấu hình ngân hàng nhận tiền"},
        )
    # Nội dung CK trên QR nạp = MÃ NẠP CỐ ĐỊNH của user (user 2026-07-14): không đổi
    # giữa các lần nạp → cùng 1 mã + 1 số tiền thì QR luôn y hệt, user lưu lại được.
    # Webhook khớp mã user → cộng đúng số tiền nhận (không phụ thuộc lệnh nạp nào).
    # Cooldown đặt sau các kiểm tra rẻ (số tiền, ngân hàng chưa cấu hình) để lần
    # bấm bị 400/409 không ăn mất lượt của người dùng.
    enforce_action_cooldown(db, user, "WALLET_TOPUP")
    topup_code = ensure_topup_code(db, user)
    # ref_code riêng của DÒNG lệnh (id nội bộ để FE poll trạng thái + lưu lịch sử) —
    # KHÔNG dùng để khớp webhook nữa. Lệnh pending quá 10′ chưa trả tiền sẽ bị job nền
    # xoá; QR vẫn hiệu lực vì khớp theo mã user, không theo dòng lệnh này.
    ref_code = secrets.token_hex(12)
    order = TopupOrder(
        user_id=user.id,
        ref_code=ref_code,
        amount_vnd=body.amount_vnd,
        status="pending",
    )
    db.add(order)
    db.commit()
    db.refresh(order)

    note = build_transfer_note(topup_prefix(settings_row), topup_code)
    qr = qr_image_url(
        settings_row.bank_name,
        settings_row.account_number,
        settings_row.account_name or "",
        body.amount_vnd,
        note,
    )
    return TopupCreatedOut(
        id=order.id,
        ref_code=order.ref_code,
        amount_vnd=order.amount_vnd,
        status=order.status,
        paid_amount_vnd=order.paid_amount_vnd,
        created_at=order.created_at,
        paid_at=order.paid_at,
        note=note,
        bank_name=settings_row.bank_name,
        account_number=settings_row.account_number,
        account_name=settings_row.account_name,
        qr_url=qr,
    )


@router.get("/topups", response_model=list[TopupOut])
def list_topups(
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
    status_filter: str | None = Query(default=None, alias="status"),
) -> list[TopupOut]:
    stmt = select(TopupOrder).where(TopupOrder.user_id == user.id)
    if status_filter:
        stmt = stmt.where(TopupOrder.status == status_filter)
    rows = db.execute(stmt.order_by(TopupOrder.created_at.desc()).limit(100)).scalars().all()
    return [TopupOut.model_validate(r) for r in rows]


@router.get("/topups/{topup_id}", response_model=TopupOut)
def get_topup(
    topup_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_wallet_enabled),
) -> TopupOut:
    order = db.get(TopupOrder, topup_id)
    if order is None or order.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lệnh nạp không tồn tại")
    return TopupOut.model_validate(order)
