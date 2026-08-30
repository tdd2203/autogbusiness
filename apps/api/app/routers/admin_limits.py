"""Chức năng: super-admin xem và chỉnh HẠN MỨC THAO TÁC ngay trên giao diện.

  - GET  /api/v1/admin/rate-limits → catalog + giá trị đang chạy
  - PUT  /api/v1/admin/rate-limits → lưu (chỉ super-admin)

Catalog (tên nút, mô tả, mặc định, trần) nằm trong code ở `app/action_limit.py`,
DB chỉ giữ SỐ GIÂY đã chỉnh. Nhờ vậy thêm một nút nặng mới chỉ cần khai trong
catalog là giao diện tự có thêm dòng, không phải migrate dữ liệu.
"""

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.action_limit import (
    ACTIONS,
    ACTION_BY_KEY,
    invalidate_config_cache,
    load_config,
)
from app.audit import log_event
from app.deps import get_session, require_super_admin
from app.models import RateLimitSettings, User

router = APIRouter(prefix="/api/v1/admin/rate-limits", tags=["admin"])


class ActionLimitOut(BaseModel):
    key: str
    label: str
    hint: str
    scope: str
    seconds: int
    default_sec: int
    max_sec: int


class RateLimitSettingsOut(BaseModel):
    enabled: bool
    exempt_super_admin: bool
    # False khi biến môi trường RATE_LIMIT_ENABLED=false đang tắt khẩn cấp cả hai
    # tầng — giao diện phải nói rõ, bằng không super-admin bật `enabled` rồi tưởng
    # đã có hiệu lực. Sửa được biến này chỉ bằng cách vào VPS, không qua giao diện.
    effective: bool
    actions: list[ActionLimitOut]
    updated_at: datetime | None = None
    updated_by: str | None = None


class RateLimitSettingsIn(BaseModel):
    enabled: bool
    exempt_super_admin: bool
    # {action_key: giây}. Key lạ bị bỏ qua, giá trị ngoài khoảng bị kẹp về trần —
    # giao diện đã chặn nhưng backend không được tin giao diện.
    cooldowns: dict[str, int] = Field(default_factory=dict)


def _render(db: Session) -> RateLimitSettingsOut:
    config = load_config(db)
    row = db.get(RateLimitSettings, 1)
    updated_by = None
    if row is not None and row.updated_by_id is not None:
        editor = db.get(User, row.updated_by_id)
        updated_by = editor.email if editor else None
    # `enabled` trả về GIÁ TRỊ ĐÃ LƯU chứ không phải giá trị đã trộn với công tắc
    # môi trường: ô tích trên giao diện phải phản ánh đúng thứ super-admin vừa lưu.
    saved_enabled = True if row is None else bool(row.enabled)
    return RateLimitSettingsOut(
        enabled=saved_enabled,
        effective=config.enabled,
        exempt_super_admin=config.exempt_super_admin,
        actions=[
            ActionLimitOut(
                key=spec.key,
                label=spec.label,
                hint=spec.hint,
                scope=spec.scope,
                seconds=config.seconds_for(spec.key),
                default_sec=spec.default_sec,
                max_sec=spec.max_sec,
            )
            for spec in ACTIONS
        ],
        updated_at=row.updated_at if row is not None else None,
        updated_by=updated_by,
    )


@router.get("", response_model=RateLimitSettingsOut)
def get_rate_limits(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> RateLimitSettingsOut:
    """Giá trị đang chạy. Chưa lưu lần nào → toàn bộ mặc định của catalog."""
    return _render(db)


@router.put("", response_model=RateLimitSettingsOut)
def save_rate_limits(
    body: RateLimitSettingsIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> RateLimitSettingsOut:
    """Lưu hạn mức. Hiệu lực NGAY (xoá cache), không cần khởi động lại API."""
    cleaned: dict[str, int] = {}
    for key, raw in body.cooldowns.items():
        spec = ACTION_BY_KEY.get(key)
        if spec is None:
            continue
        cleaned[key] = max(0, min(spec.max_sec, int(raw)))

    row = db.get(RateLimitSettings, 1)
    before = (
        {"enabled": True, "exempt_super_admin": True, "cooldowns": {}}
        if row is None
        else {
            "enabled": bool(row.enabled),
            "exempt_super_admin": bool(row.exempt_super_admin),
            "cooldowns": dict(row.cooldowns or {}),
        }
    )
    if row is None:
        row = RateLimitSettings(id=1)
        db.add(row)
    row.enabled = body.enabled
    row.exempt_super_admin = body.exempt_super_admin
    row.cooldowns = cleaned
    row.updated_by_id = user.id
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="RATE_LIMIT_SETTINGS_UPDATED",
        target_type="SETTINGS",
        target_id="rate_limits",
        data={
            "enabled": body.enabled,
            "exempt_super_admin": body.exempt_super_admin,
            "cooldowns": cleaned,
            "before": before,
        },
        commit=False,
    )
    db.commit()
    invalidate_config_cache()
    return _render(db)
