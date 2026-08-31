"""Chức năng: BẢNG GIÁ CANVA — xem giá đang áp, đặt mặc định hệ thống, đặt hàng loạt
cho đại lý.

Canva bán theo BẬC (mua dài rẻ hơn), khác hẳn ChatGPT bán theo đơn giá/tháng — lý do
và công thức nằm ở `app/services/canva_price.py`. File này chỉ là cửa vào HTTP.

Endpoints (đăng ký lên router dùng chung từ `_shared`, prefix `/api/v1/canva`):
  - GET /price-tiers          → bảng ĐANG ÁP cho người gọi (đại lý → hệ thống → gốc)
  - GET /price-tiers/default  → bảng mặc định hệ thống (super-admin)
  - PUT /price-tiers/default  → đặt bảng mặc định hệ thống (super-admin)
  - GET /price-tiers/agents   → danh sách đại lý ĐANG có bảng riêng (super-admin)
  - PUT /price-tiers/agents   → đặt/xoá bảng riêng cho NHIỀU đại lý một lần (super-admin)
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_current_user, get_session, require_super_admin
from app.models import User
from app.routers.wallet._shared import get_payment_settings
from app.schemas import (
    CanvaAgentPriceIn,
    CanvaAgentPriceListOut,
    CanvaAgentPriceRow,
    CanvaPriceTier,
    CanvaPriceTiersIn,
    CanvaPriceTiersOut,
)
from app.services import canva_price

from ._shared import router


def _out(tiers: list[dict], source: str) -> CanvaPriceTiersOut:
    return CanvaPriceTiersOut(
        tiers=[CanvaPriceTier(**t) for t in tiers],
        sellable_months=canva_price.sellable_months(tiers),
        source=source,  # type: ignore[arg-type]
    )


@router.get("/price-tiers", response_model=CanvaPriceTiersOut)
def get_effective_price_tiers(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> CanvaPriceTiersOut:
    """Bảng giá ĐANG ÁP cho chính người gọi — trang mời Canva đọc đúng cái này để
    hiện các mốc tháng và số tiền, khỏi tự đoán rồi lệch với lúc trừ ví."""
    settings_row = get_payment_settings(db)
    own = canva_price.normalize_tiers(user.canva_price_tiers)
    if own:
        return _out(own, "user")
    system = canva_price.normalize_tiers(settings_row.canva_price_tiers)
    if system:
        return _out(system, "system")
    return _out([dict(t) for t in canva_price.DEFAULT_TIERS], "builtin")


@router.get("/price-tiers/default", response_model=CanvaPriceTiersOut)
def get_default_price_tiers(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> CanvaPriceTiersOut:
    """Bảng mặc định toàn hệ thống (áp cho đại lý chưa đặt riêng)."""
    settings_row = get_payment_settings(db)
    system = canva_price.normalize_tiers(settings_row.canva_price_tiers)
    if system:
        return _out(system, "system")
    return _out([dict(t) for t in canva_price.DEFAULT_TIERS], "builtin")


def _validated(body: CanvaPriceTiersIn) -> list[dict]:
    """Bảng gửi lên → dạng chuẩn đã sắp xếp. Rỗng = xoá (quay về tầng dưới).

    Chặn bảng chỉ còn rác: pydantic đã canh từng dòng, nhưng gửi lên toàn dòng trùng
    số tháng thì sau khi gộp có thể còn 1 bậc — vẫn hợp lệ, chỉ cần khác rỗng.
    """
    tiers = canva_price.normalize_tiers([t.model_dump() for t in body.tiers])
    if body.tiers and not tiers:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Bảng giá không hợp lệ: cần ít nhất một bậc có số tháng ≥ 1.",
        )
    return tiers


@router.put("/price-tiers/default", response_model=CanvaPriceTiersOut)
def set_default_price_tiers(
    body: CanvaPriceTiersIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> CanvaPriceTiersOut:
    """Đặt bảng mặc định hệ thống. Gửi danh sách rỗng = xoá, quay về bảng gốc."""
    settings_row = get_payment_settings(db)
    tiers = _validated(body)
    settings_row.canva_price_tiers = tiers or None
    db.add(settings_row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="CANVA_PRICE_TIERS_UPDATED",
        result="SUCCESS",
        target_type="PAYMENT_SETTINGS",
        target_id="1",
        data={"scope": "system", "tiers": tiers},
        commit=False,
    )
    db.commit()
    return _out(tiers or [dict(t) for t in canva_price.DEFAULT_TIERS],
                "system" if tiers else "builtin")


@router.get("/price-tiers/agents", response_model=CanvaAgentPriceListOut)
def list_agent_price_tiers(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> CanvaAgentPriceListOut:
    """Ai đang được đặt giá riêng, và bảng riêng đó là gì.

    Trang quản trị cần cái này để hiện rõ đại lý nào lệch khỏi bảng mặc định — trước
    đây đặt giá riêng là thao tác ghi một chiều, nhìn màn hình không kiểm chứng được.
    """
    rows = (
        db.execute(select(User).where(User.canva_price_tiers.isnot(None)))
        .scalars()
        .all()
    )
    out: list[CanvaAgentPriceRow] = []
    for u in rows:
        tiers = canva_price.normalize_tiers(u.canva_price_tiers)
        if tiers:
            out.append(
                CanvaAgentPriceRow(
                    user_id=u.id,
                    tiers=[CanvaPriceTier(**t) for t in tiers],
                )
            )
    return CanvaAgentPriceListOut(overrides=out)


@router.put("/price-tiers/agents", response_model=dict)
def set_agent_price_tiers(
    body: CanvaAgentPriceIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> dict:
    """Đặt bảng giá riêng cho NHIỀU đại lý cùng lúc; danh sách rỗng = xoá bảng riêng
    của họ (quay về mặc định hệ thống).

    Sửa hàng loạt là yêu cầu thẳng của user (2026-09-01): đổi giá Canva mà phải mở
    từng đại lý thì sẽ có người bị bỏ sót và bán sai giá hàng tháng trời mới lộ.
    """
    tiers = _validated(body)
    users = (
        db.execute(select(User).where(User.id.in_(body.user_ids))).scalars().all()
    )
    found: set[UUID] = {u.id for u in users}
    missing = [str(uid) for uid in body.user_ids if uid not in found]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Không tìm thấy tài khoản: {', '.join(missing)}",
        )
    for u in users:
        u.canva_price_tiers = tiers or None
        db.add(u)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="CANVA_PRICE_TIERS_UPDATED",
        result="SUCCESS",
        target_type="USER",
        # `audit_logs.target_id` chỉ rộng 64 ký tự — nhét danh sách UUID vào là ghi
        # nhật ký nổ giữa chừng (đã dính lúc test). Sửa nhiều người thì mốc là 'bulk',
        # danh sách đầy đủ nằm trong `data`.
        target_id=str(users[0].id) if len(users) == 1 else "bulk",
        data={
            "scope": "agents",
            "user_count": len(users),
            "usernames": sorted(u.username for u in users),
            "tiers": tiers,
        },
        commit=False,
    )
    db.commit()
    return {"updated": len(users), "cleared": not tiers}
