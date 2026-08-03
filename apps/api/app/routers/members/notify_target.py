"""Chức năng: CHỈ ĐỊNH người nhận nhắc gia hạn (Telegram) cho TỪNG email.

⚠️ ĐỌC `notify_target.md` (cùng thư mục) + `docs/Notifications/Renewal_Reminder_Telegram.md`.

Endpoint:
  - PATCH /{member_id}/notify-target → set_member_notify_target

Ý nghĩa: mặc định tin nhắc gia hạn của một email về ĐẠI LÝ đã add email đó. Khi đặt
chỉ định, tin nhắc gửi cho NGƯỜI ĐƯỢC CHỈ ĐỊNH **thay cho** đại lý (thường là khách
cuối — chủ thật của tài khoản ChatGPT). Xoá chỉ định (`target=null`) → quay về đại lý.

RÀNG BUỘC TELEGRAM (không né được): bot chỉ nhắn được cho người ĐÃ bấm /start bot, và
không tra được @username → chat_id. Vì vậy:
  - Nhập ID số  → dùng ngay (`resolved=true`), nhưng vẫn cần người đó đã /start bot,
    nếu không lần gửi đầu sẽ trả 'not_started' và tin bị đánh dấu blocked.
  - Nhập @username → `resolved=false` cho tới khi người đó /start bot; trong lúc chờ,
    nhắc vẫn về đại lý để KHÔNG mất thông báo (xem renewal_reminder._recipients_for).
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_permission
from app.models import User
from app.permissions import Permission
from app.services.renewal_reminder import normalize_target, resolve_assignee_chat_id

from ._shared import router, _get_workspace_or_404, _member_or_404_visible


class MemberNotifyTargetIn(BaseModel):
    """'@username' hoặc ID số Telegram. None/rỗng = xoá chỉ định (về lại đại lý)."""

    target: str | None = Field(default=None, max_length=64)


class MemberNotifyTargetOut(BaseModel):
    member_id: UUID
    target: str | None
    chat_id: int | None
    # False = đã lưu chỉ định nhưng CHƯA gửi được cho người đó (họ chưa /start bot).
    resolved: bool


@router.patch("/{member_id}/notify-target", response_model=MemberNotifyTargetOut)
def set_member_notify_target(
    workspace_id: UUID,
    member_id: UUID,
    payload: MemberNotifyTargetIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
) -> MemberNotifyTargetOut:
    _get_workspace_or_404(db, workspace_id)
    member = _member_or_404_visible(db, workspace_id, member_id, user)

    try:
        target, chat_id = normalize_target(payload.target)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    member.notify_telegram_target = target
    member.notify_telegram_chat_id = chat_id
    db.add(member)

    # Nhập @username: nếu người đó đã từng /start bot thì khớp được ngay.
    if target and chat_id is None:
        resolve_assignee_chat_id(db, member)

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="MEMBER_NOTIFY_TARGET_SET" if target else "MEMBER_NOTIFY_TARGET_CLEARED",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "email": member.email,
            "target": target,
            "chat_id": member.notify_telegram_chat_id,
        },
        commit=False,
    )
    db.commit()
    db.refresh(member)

    return MemberNotifyTargetOut(
        member_id=member.id,
        target=member.notify_telegram_target,
        chat_id=member.notify_telegram_chat_id,
        resolved=member.notify_telegram_chat_id is not None,
    )
