"""Chức năng: CÂU THÔNG BÁO CHẠM TRẦN — super-admin tự soạn (nút ⚙️ trang Mời).

  - GET /api/v1/admin/invite-settings → câu đang dùng + câu mặc định + danh sách
    chỗ thay động (để giao diện tự vẽ phần hướng dẫn, khỏi chép chữ sang FE)
  - PUT /api/v1/admin/invite-settings → lưu (chỉ super-admin)

Một câu DÙNG CHUNG cho mọi workspace (user chốt 4/9/2026): riêng từng workspace chỉ
có số trần và ngày mở lại, ghép vào câu qua `{conlai}` / `{ngay}`. Sửa lời lẽ một
lần là cả hệ thống đổi theo, thay vì đi sửa từng không gian.

Phép thay động nằm ở `services/seats.render_cap_message` — chỗ DUY NHẤT biết luật,
dùng chung cho cả câu 409 lúc từ chối lệnh mời lẫn câu hiện trên trang Mời.
"""

from datetime import date, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_super_admin
from app.models import InviteSettings, User
from app.services import seats

router = APIRouter(prefix="/api/v1/admin/invite-settings", tags=["admin"])

#: Ví dụ để giao diện xem trước câu vừa soạn — không đụng tới dữ liệu thật.
_PREVIEW_NAME = "CHATGPT PRO"
_PREVIEW_LEFT = 3
_PREVIEW_DATE = date(2026, 9, 7)


class CapPlaceholder(BaseModel):
    token: str
    hint: str


class InviteSettingsOut(BaseModel):
    # Câu ĐANG LƯU. None = chưa ai sửa → hệ thống dùng `default_message`.
    cap_message: str | None = None
    default_message: str
    placeholders: list[CapPlaceholder]
    # Câu mẫu đã thay động sẵn, để ô soạn thảo hiện ngay "trông sẽ như thế này".
    preview: str
    updated_at: datetime | None = None
    updated_by: str | None = None


class InviteSettingsIn(BaseModel):
    # Gửi null hoặc chuỗi rỗng = quay về câu mặc định trong code.
    cap_message: str | None = Field(default=None, max_length=2000)


#: `hint` là câu giao diện in RA MÀN HÌNH cạnh mỗi chỗ thay động (không phải
#: tooltip): admin phải đọc được ngay "cái này lấy số ở đâu" mà không hỏi lại.
_PLACEHOLDERS = [
    CapPlaceholder(
        token="{conlai}", hint="số suất còn trống tới trần, hệ thống tự tính"
    ),
    CapPlaceholder(
        token="{ngay}", hint="ngày gõ ở ô Ngày mở lại của chính không gian đó"
    ),
    CapPlaceholder(token="{ten}", hint="tên không gian, ví dụ CHATGPT PRO"),
]


def _render(db: Session) -> InviteSettingsOut:
    row = db.get(InviteSettings, 1)
    updated_by = None
    if row is not None and row.updated_by_id is not None:
        editor = db.get(User, row.updated_by_id)
        updated_by = editor.email if editor else None
    return InviteSettingsOut(
        cap_message=row.cap_message if row is not None else None,
        default_message=seats.DEFAULT_CAP_MESSAGE,
        placeholders=_PLACEHOLDERS,
        preview=seats.render_cap_message(
            seats.cap_message_template(db),
            name=_PREVIEW_NAME,
            left=_PREVIEW_LEFT,
            reopen_at=_PREVIEW_DATE,
        ),
        updated_at=row.updated_at if row is not None else None,
        updated_by=updated_by,
    )


@router.get("", response_model=InviteSettingsOut)
def get_invite_settings(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> InviteSettingsOut:
    return _render(db)


@router.put("", response_model=InviteSettingsOut)
def save_invite_settings(
    body: InviteSettingsIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> InviteSettingsOut:
    """Lưu câu thông báo. Hiệu lực NGAY — mọi nơi đọc thẳng từ DB, không cache."""
    cleaned = (body.cap_message or "").strip() or None
    row = db.get(InviteSettings, 1)
    before = row.cap_message if row is not None else None
    if row is None:
        row = InviteSettings(id=1)
        db.add(row)
    row.cap_message = cleaned
    row.updated_by_id = user.id
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="INVITE_CAP_MESSAGE_UPDATED",
        target_type="SETTINGS",
        target_id="invite_cap_message",
        data={"before": before, "after": cleaned},
        commit=False,
    )
    db.commit()
    return _render(db)
