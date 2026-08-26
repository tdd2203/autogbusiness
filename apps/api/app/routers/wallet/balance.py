"""Ví — số dư & lịch sử giao dịch của user hiện tại."""

from datetime import date as date_type

from fastapi import Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_wallet_enabled
from app.models import User, WalletTransaction
from app.schemas import WalletOut, WalletTxnOut, WalletTxnPage
from app.services import payment_flow, sepay_ledger, wallet_service

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
    limit: int = Query(100, ge=1, le=500),
    before_seq: int | None = Query(
        None, description="Con trỏ: chỉ lấy bút toán CŨ HƠN số thứ tự này (mới→cũ)."
    ),
    date: date_type | None = Query(
        None, description="Chỉ lấy bút toán trong NGÀY này (YYYY-MM-DD, giờ VN)."
    ),
) -> WalletTxnPage:
    """Lịch sử ví, mới→cũ, có PHÂN TRANG THẬT.

    Trước 26/8/2026 endpoint này chỉ có `limit` và luôn trả `next_cursor=None`, còn FE
    xin cứng 100 dòng. Khi trang Ví thêm bộ lọc theo ngày, mọi ngày nằm ngoài 100 bút
    toán gần nhất hiện ra RỖNG — trông như mất sạch lịch sử cũ, dù dữ liệu vẫn còn
    nguyên trong DB (user 2026-08-26). Nay:

      • `date`       → lấy TRỌN ngày VN đó (bấm sang ngày cũ luôn có dữ liệu, không
        phụ thuộc user đã cuộn tới đâu). Vẫn kèm `next_cursor` phòng ngày cực đông.
      • `before_seq` → con trỏ cuộn tiếp; `next_cursor` chỉ khác None khi CÒN dòng cũ hơn.

    Con trỏ dùng `seq` (IDENTITY tăng dần) chứ không dùng `created_at`: nhiều bút toán
    trong cùng một request chia sẻ y hệt `created_at`, phân trang theo mốc đó sẽ nhảy
    cóc mất dòng.
    """
    q = select(WalletTransaction).where(WalletTransaction.user_id == user.id)
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
    return WalletTxnPage(
        items=[WalletTxnOut.model_validate(r) for r in rows],
        next_cursor=str(rows[-1].seq) if has_more and rows else None,
    )
