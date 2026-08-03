"""Kênh Telegram: webhook của bot + liên kết tài khoản + điều khiển cho admin.

⚠️ ĐỌC `docs/Notifications/Renewal_Reminder_Telegram.md` trước khi sửa.

Hai nhóm endpoint:

1. `POST /webhook/telegram` — TOP-LEVEL (ngoài `/api`), khớp cách SePay đã làm; nginx
   đã proxy sẵn `location /webhook/` nên không cần đổi cấu hình web. Xác thực bằng
   header `X-Telegram-Bot-Api-Secret-Token` (Telegram gửi lại secret đã đăng ký ở
   setWebhook). LUÔN trả 200 kể cả khi xử lý lỗi — trả lỗi sẽ khiến Telegram gửi lại
   update đó mãi.

2. `/api/v1/telegram/*` — cho dashboard: tạo deep-link liên kết, xem trạng thái,
   bật/tắt, gửi thử; nhóm `/admin/*` (super-admin) để đăng ký webhook và chạy job ngay.

Vì sao phải LIÊN KẾT mà không nhập tay chat_id: Bot API không cho tra cứu người dùng
theo @username, và bot không được nhắn trước cho người lạ. Deep-link `?start=<token>`
là cách duy nhất vừa lấy đúng chat_id vừa chứng minh chính chủ.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.config import get_settings
from app.deps import get_current_user, get_session, require_super_admin
from app.models import (
    Member,
    TelegramContact,
    TelegramLinkToken,
    TelegramNotification,
    TelegramSettings,
    TelegramSubscription,
    User,
)
from app.services import renewal_reminder, telegram

logger = logging.getLogger(__name__)

router = APIRouter(tags=["telegram"])

# Deep-link chỉ sống ngắn: đủ để chuyển sang app Telegram và bấm Start.
LINK_TOKEN_TTL = timedelta(minutes=15)
# Link MỜI nhận thông báo sống lâu hơn: chủ tài khoản gửi qua Zalo/chat cho nhân viên,
# người ta không bấm ngay trong 15 phút. Vẫn có hạn để link cũ không tồn tại mãi.
INVITE_TOKEN_TTL = timedelta(days=7)
# Số dòng tối đa khi trả lời lệnh /danhsach trong chat.
LIST_COMMAND_LIMIT = 15
LIST_COMMAND_HORIZON = timedelta(days=30)


# ── Schemas ───────────────────────────────────────────────────────────────────


class TelegramStatusOut(BaseModel):
    """Trạng thái kênh Telegram của user đang đăng nhập."""

    bot_configured: bool
    bot_username: str | None = None
    linked: bool
    telegram_username: str | None = None
    telegram_chat_id: int | None = None
    linked_at: datetime | None = None
    notify_enabled: bool
    # Các mốc nhắc + giờ gửi đang áp dụng (hiển thị ở Cài đặt cho minh bạch).
    reminder_days: list[int]
    reminder_hour: int


class TelegramLinkOut(BaseModel):
    deep_link: str
    token: str
    expires_at: datetime


class TelegramPrefIn(BaseModel):
    enabled: bool


class TelegramSubscriptionOut(BaseModel):
    """1 người nhận thông báo của tài khoản đang đăng nhập."""

    id: UUID
    chat_id: int
    display_name: str | None = None
    # 'all' = nhận mọi email của tài khoản (kể cả email thêm sau) | 'selected'
    scope: str
    member_ids: list[str] = Field(default_factory=list)
    enabled: bool
    created_at: datetime


class TelegramSubscriptionIn(BaseModel):
    """Cập nhật phạm vi/trạng thái người nhận. Trường None = giữ nguyên."""

    scope: str | None = None
    member_ids: list[UUID] | None = None
    enabled: bool | None = None


class TelegramTokenIn(BaseModel):
    """Token @BotFather + (tuỳ chọn) nhóm nhận bản tổng hợp, nhập từ Dashboard."""

    bot_token: str = Field(min_length=20, max_length=200)
    admin_chat_id: str | None = Field(default=None, max_length=255)


class TelegramAdminChatIn(BaseModel):
    admin_chat_id: str | None = Field(default=None, max_length=255)


class TelegramAdminStatusOut(BaseModel):
    bot_configured: bool
    # Cấu hình đang hiệu lực đến từ đâu: 'env' (.env, không sửa được qua UI) |
    # 'db' (super-admin nhập ở Dashboard) | 'none' (chưa cấu hình).
    config_source: str = "none"
    bot_username: str | None = None
    webhook_url: str | None = None
    webhook_has_error: bool = False
    webhook_last_error: str | None = None
    pending_updates: int = 0
    admin_chat_ids: list[int]
    linked_users: int
    contacts: int
    sent_last_7d: int
    failed_last_7d: int


class TelegramWebhookIn(BaseModel):
    """URL công khai của webhook. Bỏ trống = suy từ FRONTEND_ORIGIN (PUBLIC_URL)."""

    public_url: str | None = Field(default=None, max_length=255)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _require_bot() -> None:
    if not telegram.bot_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "TELEGRAM_NOT_CONFIGURED",
                "message": "Chưa cấu hình TELEGRAM_BOT_TOKEN trên server",
            },
        )


def _safe_bot_username() -> str | None:
    """@username của bot; None nếu chưa cấu hình hoặc gọi Bot API lỗi (không chặn UI)."""
    if not telegram.bot_configured():
        return None
    try:
        return telegram.bot_username() or None
    except telegram.TelegramError as exc:
        logger.warning("[telegram] getMe lỗi: %s", exc)
        return None


def _upsert_contact(db: Session, chat: dict, sender: dict, now: datetime) -> TelegramContact:
    """Ghi/nâng cấp sổ địa chỉ từ một update — nền tảng để chỉ định theo @username."""
    chat_id = int(chat["id"])
    username = (sender.get("username") or "").strip().lower() or None
    display = " ".join(
        part for part in [sender.get("first_name"), sender.get("last_name")] if part
    ).strip() or None

    contact = db.get(TelegramContact, chat_id)
    if contact is None:
        contact = TelegramContact(chat_id=chat_id, started_at=now)
        db.add(contact)
    contact.username = username or contact.username
    contact.display_name = display or contact.display_name
    contact.last_seen_at = now
    contact.blocked_at = None  # họ đang nhắn cho bot ⇒ chắc chắn không chặn nữa

    # Người này từng được CHỈ ĐỊNH bằng @username cho email nào đó nhưng chưa khớp
    # được chat_id → khớp ngay lúc này để tin nhắc kế tiếp đi đúng địa chỉ.
    if username:
        db.execute(
            Member.__table__.update()
            .where(
                func.lower(Member.notify_telegram_target) == f"@{username}",
                Member.notify_telegram_chat_id.is_(None),
            )
            .values(notify_telegram_chat_id=chat_id)
        )
    return contact


def _reply(chat_id: int, html: str) -> None:
    """Trả lời trong webhook — nuốt lỗi để không bao giờ làm webhook trả != 200."""
    try:
        telegram.send_message(chat_id, html)
    except telegram.TelegramError as exc:
        logger.warning("[telegram] trả lời %s lỗi: %s", chat_id, exc)


def _help_text() -> str:
    return (
        "<b>Bot nhắc gia hạn</b>\n\n"
        "/start — kết nối &amp; nhận nhắc\n"
        "/email &lt;địa chỉ&gt; — nhận nhắc gia hạn cho MỘT email cụ thể\n"
        "/huyemail &lt;địa chỉ&gt; — thôi nhận nhắc email đó\n"
        "/danhsach — xem email sắp hết hạn\n"
        "/id — xem ID chat (dùng để chỉ định người nhận)\n"
        "/tat — tạm ngưng nhận nhắc\n"
        "/bat — nhận nhắc trở lại"
    )


# Chống dò email: mỗi chat chỉ được thử `/email` `_EMAIL_CMD_MAX` lần trong
# `_EMAIL_CMD_WINDOW`. Bộ đếm nằm trong process (API chạy 1 worker) và tự quên khi
# restart — đủ để chặn dò hàng loạt, không cần thêm bảng DB.
_EMAIL_CMD_WINDOW = timedelta(minutes=10)
_EMAIL_CMD_MAX = 8
_email_cmd_hits: dict[int, list[datetime]] = {}


def _email_cmd_allowed(chat_id: int, now: datetime) -> bool:
    hits = [t for t in _email_cmd_hits.get(chat_id, []) if now - t < _EMAIL_CMD_WINDOW]
    hits.append(now)
    _email_cmd_hits[chat_id] = hits
    return len(hits) <= _EMAIL_CMD_MAX


def _is_uuid(value: str) -> bool:
    try:
        UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _find_member_by_email(db: Session, email: str) -> Member | None:
    """Email đang còn hiệu lực (active/pending). Trùng email ở nhiều workspace thì
    lấy bản có hạn XA NHẤT — đó là suất khách đang thực sự dùng."""
    return (
        db.execute(
            select(Member)
            .where(
                func.lower(Member.email) == email,
                Member.status.in_(("active", "pending")),
            )
            .order_by(Member.subscription_end_at.desc().nullslast())
            .limit(1)
        )
        .scalars()
        .first()
    )


def _handle_email_subscribe(
    db: Session, chat_id: int, arg: str, contact: TelegramContact, now: datetime
) -> None:
    """`/email <địa chỉ>` — khách TỰ đăng ký nhận nhắc gia hạn cho email của mình.

    Đây là đường thứ 2 (đường 1 là đại lý bấm link kết nối trong Dashboard và nhận
    nhắc cho TOÀN BỘ email của họ). Ở đây người nhắn chỉ nhận nhắc cho ĐÚNG email vừa
    khai. Không chiếm được email người khác: email đã có người nhận rồi thì từ chối.
    """
    email = arg.strip().lower()
    if not email or "@" not in email:
        _reply(chat_id, "Cú pháp: <code>/email abc@gmail.com</code>")
        return
    if not _email_cmd_allowed(chat_id, now):
        _reply(chat_id, "⚠️ Bạn thử quá nhiều lần. Vui lòng chờ ít phút rồi thử lại.")
        return

    member = _find_member_by_email(db, email)
    if member is None:
        _reply(
            chat_id,
            "Không tìm thấy email này trong hệ thống (hoặc đã ngừng hoạt động).\n"
            "Kiểm tra lại chính tả hoặc liên hệ nơi bạn đã mua.",
        )
        return

    if member.notify_telegram_chat_id and member.notify_telegram_chat_id != chat_id:
        _reply(
            chat_id,
            "⚠️ Email này đã được đăng ký nhận thông báo ở một tài khoản Telegram khác.\n"
            "Liên hệ nơi bạn đã mua nếu cần đổi người nhận.",
        )
        return

    if member.notify_telegram_chat_id == chat_id:
        _reply(chat_id, f"✅ Bạn đã đăng ký nhận nhắc cho <code>{telegram.escape_html(email)}</code> rồi.")
        return

    member.notify_telegram_target = (
        f"@{contact.username}" if contact.username else str(chat_id)
    )
    member.notify_telegram_chat_id = chat_id
    db.add(member)
    log_event(
        db,
        actor_type="SYSTEM",
        actor_label=f"telegram:{contact.username or chat_id}",
        action="MEMBER_NOTIFY_TARGET_SELF_SET",
        target_type="MEMBER",
        target_id=str(member.id),
        data={"email": member.email, "chat_id": chat_id},
        commit=False,
    )

    settings = get_settings()
    end_text = (
        f"\nHạn hiện tại: <b>{telegram.escape_html(renewal_reminder._fmt_dt(member.subscription_end_at))}</b>"
        if member.subscription_end_at
        else "\nTài khoản này hiện không giới hạn thời hạn."
    )
    _reply(
        chat_id,
        f"✅ Đã đăng ký nhận nhắc gia hạn cho <code>{telegram.escape_html(email)}</code>."
        + end_text
        + "\n\nBạn sẽ được nhắc khi còn "
        + ", ".join(f"≤{d} ngày" for d in settings.reminder_day_buckets())
        + ".\nGõ /huyemail để thôi nhận.",
    )


def _handle_email_unsubscribe(db: Session, chat_id: int, arg: str) -> None:
    """`/huyemail <địa chỉ>` — bỏ đăng ký. Chỉ bỏ được email do CHÍNH chat này đăng ký."""
    email = arg.strip().lower()
    if not email or "@" not in email:
        _reply(chat_id, "Cú pháp: <code>/huyemail abc@gmail.com</code>")
        return
    rows = (
        db.execute(
            select(Member).where(
                func.lower(Member.email) == email,
                Member.notify_telegram_chat_id == chat_id,
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        _reply(chat_id, "Chat này không đăng ký nhận nhắc cho email đó.")
        return
    for member in rows:
        member.notify_telegram_target = None
        member.notify_telegram_chat_id = None
        db.add(member)
        log_event(
            db,
            actor_type="SYSTEM",
            actor_label=f"telegram:{chat_id}",
            action="MEMBER_NOTIFY_TARGET_SELF_CLEARED",
            target_type="MEMBER",
            target_id=str(member.id),
            data={"email": member.email, "chat_id": chat_id},
            commit=False,
        )
    _reply(
        chat_id,
        f"🔕 Đã thôi nhắc cho <code>{telegram.escape_html(email)}</code>. "
        "Thông báo sẽ quay về người bán.",
    )


def _handle_invite_subscription(
    db: Session,
    chat_id: int,
    row: TelegramLinkToken,
    contact: TelegramContact,
    now: datetime,
) -> None:
    """Ai đó bấm LINK MỜI của một tài khoản → thành người nhận thông báo của tài khoản
    đó (mặc định nhận TOÀN BỘ; chủ tài khoản thu hẹp phạm vi sau ở Cài đặt).

    Link mời KHÔNG đánh dấu used_at: chủ tài khoản thường gửi cho vài người và mỗi
    người tạo một bản ghi riêng (xem docstring TelegramLinkToken).
    """
    owner = db.get(User, row.user_id)
    if owner is None or not owner.is_active:
        _reply(chat_id, "⚠️ Tài khoản mời bạn không còn hiệu lực.")
        return

    display = f"@{contact.username}" if contact.username else (contact.display_name or str(chat_id))
    existing = db.execute(
        select(TelegramSubscription).where(
            TelegramSubscription.user_id == owner.id,
            TelegramSubscription.chat_id == chat_id,
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            TelegramSubscription(
                user_id=owner.id,
                chat_id=chat_id,
                display_name=display[:128],
                scope="all",
                member_ids=[],
                enabled=True,
            )
        )
    else:
        # Bấm lại link = BẬT LẠI, nhưng GIỮ NGUYÊN phạm vi chủ tài khoản đã tinh chỉnh
        # (nếu reset về 'all' thì mỗi lần họ bấm nhầm link lại phá cấu hình).
        existing.enabled = True
        existing.display_name = display[:128]
        db.add(existing)

    log_event(
        db,
        actor_type="SYSTEM",
        actor_label=f"telegram:{contact.username or chat_id}",
        action="TELEGRAM_SUBSCRIPTION_ADDED",
        target_type="USER",
        target_id=str(owner.id),
        data={"chat_id": chat_id, "display_name": display},
        commit=False,
    )
    _reply(
        chat_id,
        f"✅ Bạn sẽ nhận thông báo nhắc gia hạn của tài khoản "
        f"<b>{telegram.escape_html(owner.username)}</b>.\n\n"
        "Chủ tài khoản có thể chỉnh bạn nhận toàn bộ hay chỉ một số email.\n"
        "Gõ /danhsach để xem email sắp hết hạn bạn đang theo dõi.",
    )


def _handle_start(db: Session, chat_id: int, user_arg: str, contact: TelegramContact, now: datetime) -> None:
    """`/start <token>` = liên kết tài khoản dashboard; `/start` trơn = chỉ ghi sổ."""
    if not user_arg:
        who = f"@{contact.username}" if contact.username else f"ID <code>{chat_id}</code>"
        _reply(
            chat_id,
            "✅ Đã kết nối bot.\n\n"
            f"Tài khoản Telegram của bạn: {who}\n"
            "Nếu bạn là <b>đại lý</b>: vào Dashboard → Cài đặt → Telegram và bấm "
            "<b>Kết nối Telegram</b> để nhận nhắc gia hạn cho các email của bạn.\n"
            "Nếu bạn là <b>khách</b>: gửi thông tin trên cho người bán để họ chỉ định "
            "nhận nhắc hạn tài khoản của bạn.\n\n" + _help_text(),
        )
        return

    row = db.get(TelegramLinkToken, user_arg)
    # Link MỜI dùng được nhiều lần (chỉ hết hiệu lực khi quá hạn); link KẾT NỐI chính
    # chủ dùng-một-lần. Xem docstring TelegramLinkToken.
    if row is not None and row.purpose == "invite_sub" and row.expires_at > now:
        _handle_invite_subscription(db, chat_id, row, contact, now)
        return
    if row is None or row.used_at is not None or row.expires_at <= now:
        _reply(
            chat_id,
            "⚠️ Mã liên kết không hợp lệ hoặc đã hết hạn.\n"
            "Vào Dashboard → Cài đặt → Telegram và bấm <b>Kết nối Telegram</b> để lấy mã mới.",
        )
        return

    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        _reply(chat_id, "⚠️ Tài khoản không còn hiệu lực.")
        return

    user.telegram_chat_id = chat_id
    user.telegram_username = contact.username
    user.telegram_linked_at = now
    user.telegram_notify_enabled = True
    row.used_at = now
    db.add(user)
    db.add(row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_LINKED",
        target_type="USER",
        target_id=str(user.id),
        data={"chat_id": chat_id, "telegram_username": contact.username},
        commit=False,
    )
    settings = get_settings()
    _reply(
        chat_id,
        f"✅ Đã liên kết với tài khoản <b>{telegram.escape_html(user.username)}</b>.\n\n"
        f"Bạn sẽ nhận nhắc gia hạn khi email còn "
        f"{', '.join(f'≤{d} ngày' for d in settings.reminder_day_buckets())} "
        f"(gửi lúc {settings.renewal_reminder_hour}:00).\n\n" + _help_text(),
    )


def _handle_list(db: Session, chat_id: int, now: datetime) -> None:
    """`/danhsach` — email sắp hết hạn liên quan tới chính chat này."""
    horizon = now + LIST_COMMAND_HORIZON
    user = db.execute(
        select(User).where(User.telegram_chat_id == chat_id, User.is_active.is_(True))
    ).scalars().first()

    stmt = (
        select(Member)
        .where(
            Member.status.in_(("active", "pending")),
            Member.subscription_end_at.is_not(None),
            Member.subscription_end_at > now,
            Member.subscription_end_at <= horizon,
        )
        .order_by(Member.subscription_end_at)
        .limit(LIST_COMMAND_LIMIT)
    )
    if user is not None:
        stmt = stmt.where(Member.invited_by_user_id == user.id)
        empty_text = "✅ Không có email nào của bạn hết hạn trong 30 ngày tới."
    else:
        # Không phải chính chủ → gộp hai đường: email được CHỈ ĐỊNH tới chat này, và
        # email thuộc các tài khoản đã MỜI chat này nhận thông báo (theo phạm vi).
        subs = (
            db.execute(
                select(TelegramSubscription).where(
                    TelegramSubscription.chat_id == chat_id,
                    TelegramSubscription.enabled.is_(True),
                )
            )
            .scalars()
            .all()
        )
        conditions = [Member.notify_telegram_chat_id == chat_id]
        for sub in subs:
            if sub.scope == "selected":
                ids = [UUID(x) for x in (sub.member_ids or []) if _is_uuid(x)]
                if ids:
                    conditions.append(Member.id.in_(ids))
            else:
                conditions.append(Member.invited_by_user_id == sub.user_id)
        stmt = stmt.where(or_(*conditions))
        empty_text = (
            "Chưa có email nào gửi thông báo tới chat này.\n"
            "Nếu bạn là đại lý, hãy liên kết tài khoản ở Dashboard → Cài đặt → Telegram; "
            "nếu bạn là khách, gõ /email &lt;địa chỉ&gt; để nhận nhắc cho email của mình."
        )

    members = db.execute(stmt).scalars().all()
    if not members:
        _reply(chat_id, empty_text)
        return

    esc = telegram.escape_html
    lines = [
        f"• <code>{esc(m.email)}</code> — hết hạn "
        f"{esc(renewal_reminder._fmt_dt(m.subscription_end_at))} "
        f"({esc(renewal_reminder._fmt_left(m.subscription_end_at, now))})"
        for m in members
    ]
    _reply(chat_id, "📋 <b>Email sắp hết hạn (30 ngày tới)</b>\n\n" + "\n".join(lines))


def _handle_toggle(db: Session, chat_id: int, enabled: bool) -> None:
    user = db.execute(
        select(User).where(User.telegram_chat_id == chat_id)
    ).scalars().first()
    if user is None:
        _reply(
            chat_id,
            "Chat này chưa liên kết tài khoản dashboard nên không có gì để bật/tắt.\n"
            "Muốn ngừng nhận nhắc được chỉ định: nhờ người bán gỡ chỉ định, hoặc chặn bot.",
        )
        return
    user.telegram_notify_enabled = enabled
    db.add(user)
    _reply(
        chat_id,
        "🔕 Đã tạm ngưng nhắc gia hạn. Gõ /bat để nhận lại."
        if not enabled
        else "🔔 Đã bật lại nhắc gia hạn.",
    )


def _process_update(db: Session, update: dict[str, Any]) -> None:
    """Xử lý 1 update. Chỉ quan tâm tin nhắn văn bản dạng lệnh."""
    message = update.get("message") or update.get("edited_message") or {}
    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    text = (message.get("text") or "").strip()
    if not chat or not text:
        return

    chat_id = int(chat["id"])
    now = datetime.now(timezone.utc)
    is_private = chat.get("type") == "private"

    # Lệnh có thể kèm @tenbot khi gõ trong group: '/id@my_bot arg'.
    head, _, arg = text.partition(" ")
    command = head.split("@", 1)[0].lower()
    arg = arg.strip()

    if not is_private:
        # Trong group chỉ hỗ trợ /id — đủ để admin lấy chat_id dán vào
        # TELEGRAM_ADMIN_CHAT_ID; các lệnh cá nhân khác không có ý nghĩa ở group.
        if command == "/id":
            _reply(
                chat_id,
                f"ID của nhóm này: <code>{chat_id}</code>\n"
                "Dán vào biến môi trường <code>TELEGRAM_ADMIN_CHAT_ID</code> để nhóm "
                "nhận bản tổng hợp email sắp hết hạn.",
            )
        return

    contact = _upsert_contact(db, chat, sender, now)

    if command == "/start":
        _handle_start(db, chat_id, arg, contact, now)
    elif command == "/email":
        _handle_email_subscribe(db, chat_id, arg, contact, now)
    elif command in ("/huyemail", "/huy_email"):
        _handle_email_unsubscribe(db, chat_id, arg)
    elif command in ("/danhsach", "/list"):
        _handle_list(db, chat_id, now)
    elif command == "/id":
        who = f"@{contact.username}" if contact.username else "(chưa đặt username)"
        _reply(
            chat_id,
            f"ID chat của bạn: <code>{chat_id}</code>\nUsername: {telegram.escape_html(who)}\n\n"
            "Gửi một trong hai thông tin này cho người bán để được chỉ định nhận nhắc hạn.",
        )
    elif command in ("/tat", "/stop"):
        _handle_toggle(db, chat_id, False)
    elif command in ("/bat", "/resume"):
        _handle_toggle(db, chat_id, True)
    elif command in ("/help", "/tro_giup"):
        _reply(chat_id, _help_text())
    else:
        _reply(chat_id, _help_text())

    db.commit()


# ── Webhook (top-level, giống /webhook/sepay) ─────────────────────────────────


@router.post("/webhook/telegram")
async def telegram_webhook(
    request: Request,
    db: Session = Depends(get_session),
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> dict:
    expected = telegram.webhook_secret().strip()
    # FAIL-CLOSED (bắt buộc): endpoint này CÔNG KHAI và có tác dụng phụ GÁN DANH TÍNH
    # (một '/start' quyết định chat_id nào nhận nhắc cho '@username' nào). Nếu chấp
    # nhận update không xác thực thì bất kỳ ai cũng POST được '/start' giả mạo mang
    # username của khách → chiếm luôn kênh nhận nhắc và đọc được email khách hàng.
    # Vì vậy: CHƯA cấu hình token/secret ⇒ KHÔNG xử lý update nào.
    if not telegram.bot_configured() or not expected:
        logger.warning("[telegram] webhook chưa cấu hình token/secret — từ chối update")
        return {"ok": False}
    if not secrets.compare_digest((x_telegram_bot_api_secret_token or ""), expected):
        logger.warning("[telegram] webhook sai secret — bỏ qua update")
        # 200 + ok:false: không tiết lộ lý do, cũng không để Telegram retry vô hạn.
        return {"ok": False}

    try:
        update = await request.json()
    except Exception:  # noqa: BLE001 — body rác
        return {"ok": True}
    if not isinstance(update, dict):
        return {"ok": True}

    try:
        _process_update(db, update)
    except Exception as exc:  # noqa: BLE001 — webhook PHẢI luôn 200
        db.rollback()
        logger.exception("[telegram] xử lý update lỗi: %s", exc)
    return {"ok": True}


# ── Endpoint cho dashboard ────────────────────────────────────────────────────


@router.get("/api/v1/telegram/status", response_model=TelegramStatusOut)
def telegram_status(
    user: User = Depends(get_current_user),
) -> TelegramStatusOut:
    settings = get_settings()
    return TelegramStatusOut(
        bot_configured=telegram.bot_configured(),
        bot_username=_safe_bot_username(),
        linked=user.telegram_chat_id is not None,
        telegram_username=user.telegram_username,
        telegram_chat_id=user.telegram_chat_id,
        linked_at=user.telegram_linked_at,
        notify_enabled=user.telegram_notify_enabled,
        reminder_days=settings.reminder_day_buckets(),
        reminder_hour=settings.renewal_reminder_hour,
    )


@router.post("/api/v1/telegram/link", response_model=TelegramLinkOut)
def create_link_token(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramLinkOut:
    """Tạo deep-link dùng-một-lần để user bấm Start trong Telegram."""
    _require_bot()
    bot = _safe_bot_username()
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không lấy được thông tin bot từ Telegram (kiểm tra TELEGRAM_BOT_TOKEN)",
        )
    now = datetime.now(timezone.utc)
    # Dọn token KẾT NỐI cũ của chính user này: mỗi lần bấm 'Kết nối' chỉ còn 1 mã hiệu
    # lực. KHÔNG đụng token 'invite_sub' — đó là link mời người khác, sống độc lập.
    db.execute(
        delete(TelegramLinkToken).where(
            TelegramLinkToken.user_id == user.id,
            TelegramLinkToken.purpose == "link_self",
        )
    )
    token = secrets.token_urlsafe(24)
    row = TelegramLinkToken(
        token=token,
        user_id=user.id,
        purpose="link_self",
        created_at=now,
        expires_at=now + LINK_TOKEN_TTL,
    )
    db.add(row)
    db.commit()
    return TelegramLinkOut(
        deep_link=f"https://t.me/{bot}?start={token}",
        token=token,
        expires_at=row.expires_at,
    )


@router.delete("/api/v1/telegram/link", status_code=status.HTTP_204_NO_CONTENT)
def unlink(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    """Huỷ liên kết: ngừng nhận nhắc riêng, KHÔNG động tới chỉ định theo email."""
    user.telegram_chat_id = None
    user.telegram_username = None
    user.telegram_linked_at = None
    db.add(user)
    db.execute(delete(TelegramLinkToken).where(TelegramLinkToken.user_id == user.id))
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_UNLINKED",
        target_type="USER",
        target_id=str(user.id),
        commit=False,
    )
    db.commit()


@router.patch("/api/v1/telegram/preferences", response_model=TelegramStatusOut)
def update_preferences(
    payload: TelegramPrefIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramStatusOut:
    user.telegram_notify_enabled = payload.enabled
    db.add(user)
    db.commit()
    db.refresh(user)
    return telegram_status(user)


@router.get("/api/v1/telegram/subscriptions", response_model=list[TelegramSubscriptionOut])
def list_subscriptions(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[TelegramSubscriptionOut]:
    """Những tài khoản Telegram đang nhận thông báo CỦA TÔI (mời qua link chia sẻ)."""
    rows = (
        db.execute(
            select(TelegramSubscription)
            .where(TelegramSubscription.user_id == user.id)
            .order_by(TelegramSubscription.created_at)
        )
        .scalars()
        .all()
    )
    return [
        TelegramSubscriptionOut(
            id=row.id,
            chat_id=row.chat_id,
            display_name=row.display_name,
            scope=row.scope,
            member_ids=list(row.member_ids or []),
            enabled=row.enabled,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post("/api/v1/telegram/subscriptions/invite", response_model=TelegramLinkOut)
def create_subscription_invite(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramLinkOut:
    """Tạo LINK MỜI: ai bấm vào + Start sẽ nhận thông báo của tài khoản này.

    Khác link 'Kết nối Telegram' (chính chủ, dùng-một-lần): link này **dùng nhiều lần**
    trong thời hạn để chủ tài khoản gửi cho vài người; mỗi người bấm tạo một người
    nhận riêng, và chủ tài khoản gỡ/tuỳ chỉnh phạm vi từng người bất cứ lúc nào.
    """
    _require_bot()
    bot = _safe_bot_username()
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không lấy được thông tin bot từ Telegram (kiểm tra token bot)",
        )
    now = datetime.now(timezone.utc)
    db.execute(
        delete(TelegramLinkToken).where(
            TelegramLinkToken.user_id == user.id,
            TelegramLinkToken.purpose == "invite_sub",
        )
    )
    token = secrets.token_urlsafe(24)
    row = TelegramLinkToken(
        token=token,
        user_id=user.id,
        purpose="invite_sub",
        created_at=now,
        expires_at=now + INVITE_TOKEN_TTL,
    )
    db.add(row)
    db.commit()
    return TelegramLinkOut(
        deep_link=f"https://t.me/{bot}?start={token}",
        token=token,
        expires_at=row.expires_at,
    )


@router.patch(
    "/api/v1/telegram/subscriptions/{subscription_id}",
    response_model=TelegramSubscriptionOut,
)
def update_subscription(
    subscription_id: UUID,
    payload: TelegramSubscriptionIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramSubscriptionOut:
    """Tuỳ chỉnh người nhận: nhận toàn bộ hay chỉ vài email, bật/tắt tạm thời."""
    row = db.get(TelegramSubscription, subscription_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy")

    if payload.scope is not None:
        if payload.scope not in ("all", "selected"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="scope phải là 'all' hoặc 'selected'"
            )
        row.scope = payload.scope
    if payload.member_ids is not None:
        # Chỉ nhận email CỦA CHÍNH user — chặn việc trỏ người nhận sang email người khác.
        owned = set(
            db.execute(
                select(Member.id).where(
                    Member.id.in_(payload.member_ids),
                    Member.invited_by_user_id == user.id,
                )
            )
            .scalars()
            .all()
        )
        row.member_ids = [str(mid) for mid in payload.member_ids if mid in owned]
    if payload.enabled is not None:
        row.enabled = payload.enabled
    if row.scope == "selected" and not row.member_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Chọn ít nhất 1 email, hoặc đổi sang nhận toàn bộ",
        )

    db.add(row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_SUBSCRIPTION_UPDATED",
        target_type="USER",
        target_id=str(user.id),
        data={"chat_id": row.chat_id, "scope": row.scope, "count": len(row.member_ids or [])},
        commit=False,
    )
    db.commit()
    db.refresh(row)
    return TelegramSubscriptionOut(
        id=row.id,
        chat_id=row.chat_id,
        display_name=row.display_name,
        scope=row.scope,
        member_ids=list(row.member_ids or []),
        enabled=row.enabled,
        created_at=row.created_at,
    )


@router.delete(
    "/api/v1/telegram/subscriptions/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_subscription(
    subscription_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    row = db.get(TelegramSubscription, subscription_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy")
    db.delete(row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_SUBSCRIPTION_REMOVED",
        target_type="USER",
        target_id=str(user.id),
        data={"chat_id": row.chat_id},
        commit=False,
    )
    db.commit()


@router.post("/api/v1/telegram/test")
def send_test_message(user: User = Depends(get_current_user)) -> dict:
    """Gửi 1 tin thử tới chat đã liên kết — cách nhanh nhất để biết kênh có thông."""
    _require_bot()
    if not user.telegram_chat_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tài khoản chưa liên kết Telegram",
        )
    try:
        sent = telegram.send_message(
            user.telegram_chat_id,
            "🔔 <b>Tin thử</b> — kênh nhắc gia hạn đang hoạt động bình thường.",
        )
    except telegram.TelegramError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": exc.code, "message": exc.description},
        ) from exc
    return {"sent": True, "message_id": sent.message_id}


# ── Endpoint quản trị (super-admin) ───────────────────────────────────────────


@router.get("/api/v1/telegram/admin/status", response_model=TelegramAdminStatusOut)
def admin_status(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> TelegramAdminStatusOut:
    webhook: dict = {}
    if telegram.bot_configured():
        try:
            webhook = telegram.get_webhook_info()
        except telegram.TelegramError as exc:
            logger.warning("[telegram] getWebhookInfo lỗi: %s", exc)

    since = datetime.now(timezone.utc) - timedelta(days=7)

    def _count(*statuses: str) -> int:
        return int(
            db.execute(
                select(func.count())
                .select_from(TelegramNotification)
                .where(
                    TelegramNotification.status.in_(statuses),
                    TelegramNotification.created_at >= since,
                )
            ).scalar_one()
        )

    return TelegramAdminStatusOut(
        bot_configured=telegram.bot_configured(),
        config_source=telegram.runtime_config().source,
        bot_username=_safe_bot_username(),
        webhook_url=webhook.get("url") or None,
        webhook_has_error=bool(webhook.get("last_error_message")),
        webhook_last_error=webhook.get("last_error_message"),
        pending_updates=int(webhook.get("pending_update_count") or 0),
        admin_chat_ids=telegram.admin_chat_ids(),
        linked_users=int(
            db.execute(
                select(func.count()).select_from(User).where(User.telegram_chat_id.is_not(None))
            ).scalar_one()
        ),
        contacts=int(
            db.execute(select(func.count()).select_from(TelegramContact)).scalar_one()
        ),
        sent_last_7d=_count("sent"),
        failed_last_7d=_count("failed", "blocked"),
    )


def _get_or_create_settings_row(db: Session) -> TelegramSettings:
    row = db.get(TelegramSettings, 1)
    if row is None:
        row = TelegramSettings(id=1)
        db.add(row)
    return row


@router.put("/api/v1/telegram/admin/token")
def save_bot_token(
    payload: TelegramTokenIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    """Lưu token bot do super-admin nhập ở Dashboard (khỏi SSH sửa .env + restart).

    Quy trình mượn từ Tele_Bot (`master/services/bot_registry_service`):
    **getMe xác thực trước** → sai thì báo lỗi ngay tại form; đúng thì **mã hoá Fernet**
    rồi mới cất, kèm sinh sẵn secret webhook (admin không phải tự nghĩ chuỗi ngẫu nhiên).

    KHÔNG ghi token ra log/audit — chỉ ghi @username của bot.
    """
    # Kiểm tra XUNG ĐỘT NGUỒN TRƯỚC khi gọi Telegram: .env đang thắng thì có lưu cũng
    # vô tác dụng — báo ngay, khỏi tốn một vòng gọi mạng và khỏi làm admin tưởng đã xong.
    if (get_settings().telegram_bot_token or "").strip():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Server đang đặt TELEGRAM_BOT_TOKEN trong .env — cấu hình đó được ưu "
                "tiên. Xoá biến trong .env rồi khởi động lại api nếu muốn quản lý ở đây."
            ),
        )

    token = payload.bot_token.strip()
    try:
        me = telegram.verify_token(token)
    except telegram.TelegramError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": exc.code,
                "message": f"Token không dùng được: {exc.description}",
            },
        ) from exc

    row = _get_or_create_settings_row(db)
    row.bot_token_encrypted = telegram.encrypt_secret(token)
    row.bot_username = str(me.get("username") or "").lstrip("@") or None
    # Giữ secret cũ nếu đã có (webhook đã đăng ký với Telegram vẫn dùng được).
    row.webhook_secret = row.webhook_secret or telegram.generate_webhook_secret()
    if payload.admin_chat_id is not None:
        row.admin_chat_id = payload.admin_chat_id.strip() or None
    row.updated_by_id = user.id
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_BOT_TOKEN_SET",
        target_type="SETTINGS",
        target_id="telegram",
        data={"bot_username": row.bot_username},  # KHÔNG log token
        commit=False,
    )
    db.commit()
    telegram.refresh_config()
    return {"bot_username": row.bot_username, "config_source": telegram.runtime_config().source}


@router.delete("/api/v1/telegram/admin/token", status_code=status.HTTP_204_NO_CONTENT)
def clear_bot_token(
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> None:
    """Gỡ token đã lưu → tính năng tắt (liên kết của user vẫn giữ để bật lại sau)."""
    row = db.get(TelegramSettings, 1)
    if row is not None:
        row.bot_token_encrypted = None
        row.bot_username = None
        db.add(row)
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.username,
            action="TELEGRAM_BOT_TOKEN_CLEARED",
            target_type="SETTINGS",
            target_id="telegram",
            commit=False,
        )
        db.commit()
    telegram.refresh_config()


@router.put("/api/v1/telegram/admin/admin-chat")
def save_admin_chat(
    payload: TelegramAdminChatIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> dict:
    """Đặt nhóm nhận BẢN TỔNG HỢP (lấy ID bằng cách thêm bot vào group rồi gõ /id)."""
    if (get_settings().telegram_admin_chat_id or "").strip():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Server đang đặt TELEGRAM_ADMIN_CHAT_ID trong .env — sửa ở .env.",
        )
    raw = (payload.admin_chat_id or "").strip()
    row = _get_or_create_settings_row(db)
    row.admin_chat_id = raw or None
    row.updated_by_id = user.id
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_ADMIN_CHAT_SET",
        target_type="SETTINGS",
        target_id="telegram",
        data={"admin_chat_id": raw or None},
        commit=False,
    )
    db.commit()
    telegram.refresh_config()
    return {"admin_chat_ids": telegram.admin_chat_ids()}


@router.post("/api/v1/telegram/admin/webhook")
def setup_webhook(
    payload: TelegramWebhookIn,
    _: User = Depends(require_super_admin),
) -> dict:
    """Đăng ký webhook với Telegram. URL phải là HTTPS công khai (Telegram yêu cầu)."""
    _require_bot()
    settings = get_settings()
    if not telegram.webhook_secret().strip():
        # Không có secret thì handler webhook từ chối MỌI update (fail-closed) → đăng
        # ký cũng vô nghĩa. Báo rõ thay vì để admin tưởng đã xong mà bot im lặng.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Chưa đặt TELEGRAM_WEBHOOK_SECRET trên server — webhook sẽ từ chối mọi "
                "update. Đặt biến này trong .env rồi khởi động lại api trước khi đăng ký."
            ),
        )
    base = (payload.public_url or settings.frontend_origin or "").strip().rstrip("/")
    if not base.startswith("https://"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Telegram chỉ chấp nhận webhook HTTPS công khai (vd https://gpt.lovevn.org)",
        )
    url = f"{base}/webhook/telegram"
    try:
        telegram.set_webhook(url, settings.telegram_webhook_secret)
    except telegram.TelegramError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": exc.code, "message": exc.description},
        ) from exc
    return {"webhook_url": url, "secret_configured": bool(settings.telegram_webhook_secret)}


@router.post("/api/v1/telegram/admin/run-now")
def run_reminder_now(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> dict:
    """Chạy ngay 1 nhịp quét + gửi, bỏ qua khung giờ (để kiểm tra cấu hình).

    An toàn khi bấm nhiều lần: chống trùng theo `dedupe_key` vẫn có hiệu lực nên
    không ai bị nhắn lặp.
    """
    _require_bot()
    return renewal_reminder.run_tick(db, force_scan=True)
