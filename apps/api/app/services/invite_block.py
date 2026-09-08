"""NGƯNG MỜI TẠM THỜI khi ChatGPT hỏng cú bấm công tắc "mời ngoài miền".

Bối cảnh (chốt user 3/9/2026, kèm ảnh chụp /admin/identity):
ChatGPT thỉnh thoảng hỏng ngay cú bấm công tắc "Cho phép lời mời từ miền bên
ngoài" — in băng-rôn đỏ "Something went wrong. If this issue persists please
contact us...", TẢI LẠI trang thì công tắc VẪN TẮT, và chính ChatGPT gửi thông
báo về tài khoản admin của workspace. Lỗi này rất hiếm và KHÔNG phải do ta bấm
sai.

Vì sao phải chặn ở backend chứ không chỉ báo lỗi: gặp lệnh hỏng thì phản xạ của
đại lý là bấm mời lại ngay, mà bấm lại công tắc lúc ChatGPT đang hỏng là đúng
cách để bị nó khoá thêm (đúng vết 28/8/2026: 16 lệnh hỏng y hệt trong một buổi
sáng vì mỗi lệnh hỏng lại kéo theo một lần bấm mời lại). Nên hệ thống tự lùi
`BLOCK_MINUTES` phút, và chỉ super-admin mở lại sớm được.

Chặn CẢ MỌI lời mời của workspace, không riêng email ngoài miền: khách hầu hết
là gmail nên lệnh mời nào cũng phải đi qua đúng công tắc đó.

Ai gọi:
  * `routers/queue/completion.py` — extension trả EXTERNAL_TOGGLE_BLOCKED.
  * `routers/members/invite.py` + `routers/auto_invite.py` — gác trước khi tạo
    lệnh (`assert_not_blocked`).
  * `routers/workspaces/settings.py` — super-admin bấm "Cho phép mời lại"
    (`clear_block`).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.models import User, Workspace
from app.services import telegram

logger = logging.getLogger(__name__)

VN_TZ = timezone(timedelta(hours=7))

#: Lùi bao lâu sau mỗi lần ChatGPT báo hỏng công tắc. Một tiếng là số user chốt —
#: đủ dài để ChatGPT hồi, đủ ngắn để không mất cả buổi bán hàng.
BLOCK_MINUTES = 60

#: Trần chờ Telegram cho MỘT người nhận — xem `notify_super_admins`.
_SEND_TIMEOUT_SEC = 5

#: Lý do ghi vào cột `invite_block_reason` khi không đọc được băng-rôn nguyên văn.
_DEFAULT_REASON = "ChatGPT báo lỗi khi bật công tắc mời ngoài miền"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    """Postgres trả tz-aware, nhưng SQLite trong test thì không — chuẩn hoá về UTC."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def blocked_until(workspace: Workspace, *, now: datetime | None = None) -> datetime | None:
    """Mốc hết ngưng nếu workspace ĐANG bị ngưng, `None` nếu mời được bình thường.

    Mốc đã qua ⇒ coi như không bị ngưng (tự hết hạn, không cần job dọn). CỐ Ý
    không xoá cột ở đây: hàm này bị gọi trên đường đọc, và một lần ghi ngầm trong
    đường đọc là một lần commit không ai ngờ tới.
    """
    at = workspace.invite_blocked_until
    if at is None:
        return None
    at = _aware(at)
    return at if at > (now or _now()) else None


def block_message(workspace: Workspace, *, now: datetime | None = None) -> str | None:
    """Câu giải thích cho người dùng, `None` khi workspace không bị ngưng."""
    until = blocked_until(workspace, now=now)
    if until is None:
        return None
    mins = max(1, int((until - (now or _now())).total_seconds() // 60) + 1)
    reason = (workspace.invite_block_reason or _DEFAULT_REASON).strip()
    return (
        f"Đang tạm ngưng mời vào \"{workspace.name}\" tới "
        f"{until.astimezone(VN_TZ).strftime('%H:%M %d/%m')} (còn khoảng {mins} phút). "
        f"Lý do: {reason}. Đây là lỗi phía ChatGPT, mời lại ngay chỉ khiến bị khoá "
        f"thêm — chờ hết giờ, hoặc nhờ quản trị viên mở lại sớm."
    )


def assert_not_blocked(workspace: Workspace, *, now: datetime | None = None) -> None:
    """Chặn tạo lệnh mời khi workspace đang bị ngưng. 409 kèm mốc hết ngưng."""
    msg = block_message(workspace, now=now)
    if msg is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=msg)


def block_after_toggle_error(
    db: Session,
    workspace: Workspace,
    *,
    reason: str | None = None,
    detail: str | None = None,
    task_id: str | None = None,
    now: datetime | None = None,
) -> datetime:
    """Ngưng mời workspace này `BLOCK_MINUTES` phút. Trả mốc hết ngưng.

    KHÔNG commit (caller đang trong một transaction lớn hơn — xem
    `completion.py`). Mốc lấy MUỘN HƠN giữa mốc cũ và mốc mới: hai lệnh hỏng liền
    nhau không được rút ngắn thời gian nghỉ.

    `reason` là câu HIỆN LÊN cho đại lý — ngắn, không thuật ngữ. Nhật ký kỹ thuật
    dài của extension đi vào `detail` (chỉ nằm trong audit log), đúng cách chia
    của `services/task_errors.py`.
    """
    at = now or _now()
    fresh = at + timedelta(minutes=BLOCK_MINUTES)
    cur = workspace.invite_blocked_until
    workspace.invite_blocked_until = (
        fresh if cur is None or _aware(cur) < fresh else _aware(cur)
    )
    workspace.invite_block_reason = (reason or _DEFAULT_REASON).strip()[:2000]
    db.add(workspace)
    audit.log_event(
        db,
        actor_type="SYSTEM",
        action="WORKSPACE_INVITE_BLOCKED",
        target_type="workspace",
        target_id=str(workspace.id),
        data={
            "until": workspace.invite_blocked_until.isoformat(),
            "minutes": BLOCK_MINUTES,
            "reason": workspace.invite_block_reason,
            "detail": (detail or "").strip()[:2000] or None,
            "task_id": task_id,
        },
        commit=False,
    )
    logger.warning(
        "[invite-block] ngưng mời %s tới %s — %s",
        workspace.name,
        workspace.invite_blocked_until,
        workspace.invite_block_reason,
    )
    notify_super_admins(db, workspace)
    return workspace.invite_blocked_until


def clear_block(
    db: Session, workspace: Workspace, user: User, *, commit: bool = False
) -> None:
    """Super-admin cho phép mời lại ngay. Không bị ngưng thì im lặng bỏ qua."""
    if workspace.invite_blocked_until is None and workspace.invite_block_reason is None:
        return
    previous = workspace.invite_blocked_until
    workspace.invite_blocked_until = None
    workspace.invite_block_reason = None
    db.add(workspace)
    audit.log_event(
        db,
        actor_type="ADMIN",
        action="WORKSPACE_INVITE_UNBLOCKED",
        actor_id=user.id,
        actor_label=user.email,
        target_type="workspace",
        target_id=str(workspace.id),
        data={"was_until": _aware(previous).isoformat() if previous else None},
        commit=False,
    )
    if commit:
        db.commit()


def notify_super_admins(db: Session, workspace: Workspace) -> int:
    """Bắn Telegram cho super-admin đã liên kết bot. Trả số tin gửi được.

    BEST-EFFORT tuyệt đối: Telegram hỏng KHÔNG được làm đổ luồng chốt lệnh mời
    (chốt lệnh là chỗ hoàn phí — đổ ở đây là giam tiền của đại lý vì một cái bot).

    Gọi `telegram.call` trực tiếp thay cho `send_message` chỉ để HẠ THỜI GIAN CHỜ
    xuống `_SEND_TIMEOUT_SEC`: hàm này chạy TRONG request extension báo kết quả
    lệnh, mà lệnh mời có trần 8 phút — treo 20 giây/người ở đây là tự đẩy mình
    tới TIMEOUT giả.
    """
    until = workspace.invite_blocked_until
    text = (
        "⛔️ <b>Tạm ngưng mời</b>\n"
        f"Không gian: <b>{_esc(workspace.name)}</b>\n"
        f"Mở lại lúc: <b>{_aware(until).astimezone(VN_TZ).strftime('%H:%M %d/%m') if until else '?'}</b>\n"
        f"Lý do: {_esc(workspace.invite_block_reason or _DEFAULT_REASON)}\n\n"
        "ChatGPT hỏng cú bấm công tắc mời ngoài miền và đã gửi thông báo về tài "
        "khoản admin của không gian này. Kiểm tra hộp thư ChatGPT trước khi mở lại sớm."
    )
    chat_ids = [
        cid
        for cid in db.execute(
            select(User.telegram_chat_id).where(
                User.is_super_admin.is_(True),
                User.is_active.is_(True),
                User.telegram_chat_id.is_not(None),
                User.telegram_notify_enabled.is_(True),
            )
        )
        .scalars()
        .all()
        if cid
    ]
    sent = 0
    for chat_id in chat_ids:
        try:
            telegram.call(
                "sendMessage",
                {
                    "chat_id": int(chat_id),
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
                timeout=_SEND_TIMEOUT_SEC,
            )
            sent += 1
        except telegram.TelegramError as exc:
            logger.warning(
                "[invite-block] không gửi được Telegram tới %s (%s): %s",
                chat_id,
                exc.code,
                exc.description,
            )
        except Exception:  # noqa: BLE001 — mạng/lỗi lạ cũng không được đổ luồng
            logger.warning("[invite-block] lỗi lạ khi gửi Telegram tới %s", chat_id)
    return sent


def _esc(text: str) -> str:
    """Thoát HTML cho Bot API (parse_mode=HTML) — tên workspace do người nhập."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
