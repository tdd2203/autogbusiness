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
    TelegramTemplate,
    User,
    Workspace,
)
from app.services import renewal_reminder, telegram

logger = logging.getLogger(__name__)

router = APIRouter(tags=["telegram"])

# Deep-link chỉ sống ngắn: đủ để chuyển sang app Telegram và bấm Start.
LINK_TOKEN_TTL = timedelta(minutes=15)
# Link MỜI nhận thông báo sống lâu hơn: chủ tài khoản gửi qua Zalo/chat cho nhân viên,
# người ta không bấm ngay trong 15 phút. Vẫn có hạn để link cũ không tồn tại mãi.
INVITE_TOKEN_TTL = timedelta(days=7)
# Số link mời còn hiệu lực tối đa của MỘT tài khoản. Mỗi người nhận thường cần 1 link
# riêng (phạm vi khác nhau), nhưng quá số này thì chính chủ cũng không quản nổi ai là ai.
MAX_ACTIVE_INVITES = 20
# Số dòng tối đa khi trả lời /danhsach hoặc /handung. Danh sách dài tự cắt thành nhiều
# tin (Telegram tối đa 4096 ký tự/tin); vượt mốc này thì chỉ đếm số còn lại để bot
# không bắn ra hàng chục tin liên tiếp.
LIST_COMMAND_LIMIT = 200
# Ngưỡng của /handung — "email còn dưới 7 ngày sử dụng".
EXPIRING_COMMAND_HORIZON = timedelta(days=7)
# Số email tối đa liệt kê ngay trong lời chào sau khi bấm link nhận thông báo. Có giới
# hạn vì tin Telegram tối đa 4096 ký tự — phần dư chỉ đếm số, xem tiếp bằng /danhsach.
WELCOME_LIST_LIMIT = 20


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
    # Tên link mời đã đưa người này vào (None nếu link đã bị gỡ/hết hạn) — chủ tài
    # khoản phát nhiều link nên cần biết ai đến từ đâu.
    invite_label: str | None = None


class TelegramInviteIn(BaseModel):
    """Tạo link mời: đặt tên gợi nhớ + CHỌN SẴN email người bấm link sẽ nhận."""

    label: str | None = Field(default=None, max_length=64)
    scope: str = "all"
    member_ids: list[UUID] = Field(default_factory=list)


class TelegramInviteOut(BaseModel):
    """1 link mời đang phát. Có đủ `deep_link`/`token`/`expires_at` như TelegramLinkOut
    để nơi gọi cũ dùng lại được nguyên xi."""

    token: str
    deep_link: str
    expires_at: datetime
    created_at: datetime
    label: str | None = None
    scope: str = "all"
    member_ids: list[str] = Field(default_factory=list)
    # Số người đã bấm link này (đếm từ telegram_subscriptions.invite_token).
    recipients: int = 0


class TelegramTemplateScopeOut(BaseModel):
    """Một phạm vi ĐÃ có mẫu riêng — để web đánh dấu trong ô chọn phạm vi."""

    scope: str
    chat_id: int | None = None
    member_id: UUID | None = None
    # Tên hiển thị của người nhận/email (đã xoá thì để trống, dòng mẫu vẫn còn đó).
    label: str | None = None
    updated_at: datetime


class TelegramRecipientOut(BaseModel):
    """Một chat Telegram đang nhận thông báo của tôi — nguồn cho ô chọn người nhận."""

    chat_id: int
    label: str
    # 'owner' = chính tôi | 'subscriber' = người được mời qua link | 'assignee' = khách
    # được chỉ định cho một email cụ thể.
    kind: str


class TelegramTemplateOut(BaseModel):
    """Mẫu của MỘT phạm vi + mẫu gốc + danh sách biến + bản xem trước."""

    scope: str = "all"
    chat_id: int | None = None
    member_id: UUID | None = None
    body: str | None = None
    item_line: str | None = None
    default_body: str
    default_item_line: str
    # Mẫu ĐANG có hiệu lực cho phạm vi này khi chưa đặt mẫu riêng (mẫu chung nếu đã
    # soạn, không thì mẫu gốc). Web lấy làm nội dung khởi điểm — soạn mẫu cho một
    # người nhận mà phải gõ lại từ đầu cả mẫu chung thì chẳng ai làm.
    base_body: str
    base_item_line: str
    body_placeholders: list[str]
    item_placeholders: list[str]
    preview: str
    # Chính bộ dữ liệu đã dựng nên `preview`. Trả kèm để web dựng lại bản xem trước
    # NGAY LÚC GÕ (khỏi phải Lưu mới thấy) mà vẫn ra đúng con số như server.
    sample: dict[str, Any]
    # Bản xem trước thứ hai, dựng bằng EMAIL THẬT của phạm vi đang sửa. `None` khi phạm
    # vi chưa có email nào — web nói thẳng ra thay vì vẽ một bong bóng trống.
    preview_real: str | None = None
    sample_real: dict[str, Any] | None = None
    # Mọi phạm vi đang có mẫu riêng + danh sách chọn được — gửi kèm để mở modal là đủ
    # dữ liệu vẽ ô chọn phạm vi, khỏi gọi thêm 2 endpoint nữa.
    overrides: list[TelegramTemplateScopeOut] = Field(default_factory=list)
    recipients: list[TelegramRecipientOut] = Field(default_factory=list)
    # Loại người nhận mà phạm vi này gửi tới ('owner' | 'assignee' | 'subscriber') —
    # web hiện tên loại đó lên để người soạn biết mình đang viết cho ai.
    audience: str = "owner"


class TelegramTemplateIn(BaseModel):
    """Lưu mẫu cho MỘT phạm vi. Bỏ trống cả body lẫn item_line = xoá mẫu phạm vi đó."""

    scope: str = "all"
    chat_id: int | None = None
    member_id: UUID | None = None
    body: str | None = Field(default=None, max_length=4000)
    item_line: str | None = Field(default=None, max_length=1000)


class TelegramMemberLinkIn(BaseModel):
    """Email cần tạo link thông báo (nút 'Thông báo' trên dòng email)."""

    member_id: UUID


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


# /start chỉ chào mừng + cho biết đang nhận thông báo cho bao nhiêu email. Đổ nguyên
# bảng lệnh vào đó thì lời chào dài gấp đôi mà /huongdan có sẵn đúng bảng ấy.
_HELP_HINT = "Xem hướng dẫn các lệnh tại : /huongdan"


def _help_text() -> str:
    """Bảng lệnh — chỉ `/huongdan` trả về, nên không liệt kê lại chính `/huongdan`."""
    return (
        "<b>Bot nhắc gia hạn</b>\n\n"
        "/start — kết nối &amp; nhận nhắc\n"
        "/email &lt;địa chỉ&gt; — nhận nhắc gia hạn cho Một email cụ thể\n"
        "ví dụ : /email ex1@example.com\n\n"
        "/huyemail &lt;địa chỉ&gt; — thôi nhận nhắc email đó\n"
        "ví dụ : /huyemail ex1@example.com\n\n"
        "/danhsach — xem toàn bộ email bạn sở hữu\n"
        "/handung — email còn dưới 7 ngày sử dụng\n"
        "/id — xem ID của bạn (gửi cho người bán nếu cần)\n"
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
        _reply(chat_id, "Cú pháp: <code>/email ex1@example.com</code>")
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
        + ".\nGõ /huyemail &lt;địa chỉ&gt; để thôi nhận.\n"
        "ví dụ : /huyemail ex1@example.com",
    )


def _handle_email_unsubscribe(db: Session, chat_id: int, arg: str) -> None:
    """`/huyemail <địa chỉ>` — bỏ đăng ký. Chỉ bỏ được email do CHÍNH chat này đăng ký."""
    email = arg.strip().lower()
    if not email or "@" not in email:
        _reply(chat_id, "Cú pháp: <code>/huyemail ex1@example.com</code>")
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


def _linked_owner(db: Session, chat_id: int) -> User | None:
    """Tài khoản dashboard đã liên kết vào chat này (nếu có)."""
    return (
        db.execute(select(User).where(User.telegram_chat_id == chat_id, User.is_active.is_(True)))
        .scalars()
        .first()
    )


def _watch_conditions(db: Session, chat_id: int) -> list:
    """Điều kiện SQL cho "email mà CHAT NÀY sẽ nhận thông báo".

    Gộp ba đường vào nhau vì một người có thể nhận theo nhiều kiểu cùng lúc:
    email được CHỈ ĐỊNH thẳng tới chat, email của chính tài khoản dashboard đã liên
    kết, và email thuộc các tài khoản đã MỜI chat này (theo phạm vi từng đăng ký).
    """
    conditions = [Member.notify_telegram_chat_id == chat_id]
    owner = _linked_owner(db, chat_id)
    if owner is not None:
        conditions.append(Member.invited_by_user_id == owner.id)
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
    for sub in subs:
        if sub.scope == "selected":
            ids = [UUID(x) for x in (sub.member_ids or []) if _is_uuid(x)]
            if ids:
                conditions.append(Member.id.in_(ids))
        else:
            conditions.append(Member.invited_by_user_id == sub.user_id)
    return conditions


def _watch_members(
    db: Session,
    chat_id: int,
    limit: int,
    *,
    expiring_before: datetime | None = None,
) -> tuple[int, list[Member]]:
    """(tổng số, tối đa `limit` dòng đầu) email mà CHAT NÀY đang theo dõi.

    `expiring_before` = chỉ lấy email CÓ hạn và hạn rơi trước mốc đó (email vô thời hạn
    bị loại — chúng không bao giờ cần gia hạn).
    """
    # SessionLocal đặt autoflush=False: đăng ký/chỉ định vừa `db.add` ở trên chưa xuống
    # DB nên truy vấn bên dưới sẽ không thấy. Flush (chưa commit) để đọc đúng.
    db.flush()
    where = [Member.status.in_(("active", "pending")), or_(*_watch_conditions(db, chat_id))]
    if expiring_before is not None:
        where += [
            Member.subscription_end_at.is_not(None),
            Member.subscription_end_at <= expiring_before,
        ]
    total = db.execute(select(func.count()).select_from(Member).where(*where)).scalar_one()
    if not total:
        return 0, []
    members = (
        db.execute(
            select(Member)
            .where(*where)
            # Email chưa đặt hạn xuống cuối: người nhận quan tâm cái sắp hết hạn trước.
            .order_by(Member.subscription_end_at.is_(None), Member.subscription_end_at)
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return total, members


def _member_line(member: Member, now: datetime) -> str:
    """1 dòng "• email — hết hạn ...". Chỉ mốc hết hạn, không kèm "còn N ngày" — thông
    tin đó lặp lại đúng ngày tháng vừa in ngay bên cạnh."""
    esc = telegram.escape_html
    end_at = member.subscription_end_at
    if end_at is None:
        tail = "không giới hạn thời hạn"
    elif end_at <= now:
        tail = f"đã hết hạn {esc(renewal_reminder._fmt_dt(end_at))}"
    else:
        tail = f"hết hạn {esc(renewal_reminder._fmt_dt(end_at))}"
    return f"• <code>{esc(member.email)}</code> — {tail}"


def _reply_lines(chat_id: int, header: str, lines: list[str], footer: str = "") -> None:
    """Trả lời một danh sách, tự cắt thành nhiều tin nếu vượt giới hạn ký tự."""
    for chunk in telegram.split_html_lines(header, lines, footer):
        _reply(chat_id, chunk)


def _watch_list_html(db: Session, chat_id: int, now: datetime) -> str:
    """Khối "email bạn sẽ nhận thông báo" để chèn vào lời chào sau khi bấm link.

    Trả về '' khi chưa có email nào — nơi gọi tự chọn câu thay thế cho hợp ngữ cảnh.
    Người vừa bấm link cần thấy NGAY mình theo dõi những email nào (bấm nhầm link của
    người khác thì biết liền), thay vì phải gõ thêm /danhsach.
    """
    total, members = _watch_members(db, chat_id, WELCOME_LIST_LIMIT)
    if not total:
        return ""
    lines = [_member_line(m, now) for m in members]
    text = f"📋 <b>Email bạn sẽ nhận thông báo ({total})</b>\n" + "\n".join(lines)
    if total > len(members):
        text += f"\n… và {total - len(members)} email khác."
    return text


def _merge_scope(
    old_scope: str,
    old_ids: list[str],
    new_scope: str,
    new_ids: list[str],
) -> tuple[str, list[str]]:
    """Phạm vi CŨ + phạm vi của link vừa bấm = hợp của hai bên (chỉ thêm, không bớt).

    'all' là tập lớn nhất nên đụng vào 'all' là ra 'all'. Hai bên cùng 'selected' thì
    nối danh sách, giữ thứ tự cũ trước để chủ tài khoản mở ra vẫn thấy quen mắt.
    """
    if old_scope == "all" or new_scope == "all":
        return "all", []
    return "selected", list(dict.fromkeys([*old_ids, *new_ids]))


def _handle_invite_subscription(
    db: Session,
    chat_id: int,
    row: TelegramLinkToken,
    contact: TelegramContact,
    now: datetime,
) -> None:
    """Ai đó bấm LINK MỜI của một tài khoản → thành người nhận thông báo của tài khoản
    đó, theo ĐÚNG phạm vi email đã gắn sẵn trong link (mặc định: toàn bộ).

    Người đã là người nhận rồi mà bấm thêm link khác thì phạm vi CỘNG DỒN (xem
    `_merge_scope`) — email đang theo dõi không bao giờ mất vì bấm thêm một link.

    Link mời KHÔNG đánh dấu used_at: chủ tài khoản thường gửi cho vài người và mỗi
    người tạo một bản ghi riêng (xem docstring TelegramLinkToken).
    """
    owner = db.get(User, row.user_id)
    if owner is None or not owner.is_active:
        _reply(chat_id, "⚠️ Tài khoản mời bạn không còn hiệu lực.")
        return

    link_scope = row.scope if row.scope in ("all", "selected") else "all"
    link_member_ids = [str(x) for x in (row.member_ids or []) if _is_uuid(str(x))]
    if link_scope == "selected" and not link_member_ids:
        # Link chọn email nhưng danh sách rỗng (email đã bị xoá sau khi tạo link) —
        # KHÔNG âm thầm nâng lên 'all': người này chỉ được cho xem vài email cụ thể.
        _reply(
            chat_id,
            "⚠️ Link này không còn email nào để theo dõi. Liên hệ người gửi link để lấy link mới.",
        )
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
                scope=link_scope,
                member_ids=link_member_ids,
                enabled=True,
                invite_token=row.token,
            )
        )
    else:
        # Bấm LẠI đúng link vừa dùng = BẬT LẠI, GIỮ NGUYÊN phạm vi chủ tài khoản đã tinh
        # chỉnh (nếu reset thì mỗi lần họ bấm nhầm link lại phá cấu hình).
        # Bấm một link KHÁC = CỘNG THÊM phạm vi của link mới, KHÔNG thay thế: người đã
        # nhận email A rồi bấm link có email B thì nhận cả A lẫn B — bấm link chỉ bao
        # giờ THÊM. Muốn bớt thì chủ tài khoản sửa phạm vi ở danh sách người nhận.
        if existing.invite_token != row.token:
            existing.scope, existing.member_ids = _merge_scope(
                existing.scope, list(existing.member_ids or []), link_scope, link_member_ids
            )
            existing.invite_token = row.token
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
        data={
            "chat_id": chat_id,
            "display_name": display,
            "scope": link_scope,
            "count": len(link_member_ids),
            "label": row.label,
        },
        commit=False,
    )
    listing = _watch_list_html(db, chat_id, now)
    _reply(
        chat_id,
        f"✅ Bạn sẽ nhận thông báo nhắc gia hạn của tài khoản "
        f"<b>{telegram.escape_html(owner.username)}</b>.\n\n"
        + (
            listing
            if listing
            else "Hiện chưa có email nào trong danh sách. Có email mới bạn sẽ được nhắc tự động."
        )
        + "\n\nChủ tài khoản có thể chỉnh bạn nhận toàn bộ hay chỉ một số email.\n"
        "Gõ /danhsach để xem toàn bộ email bạn sở hữu, "
        "/handung để xem email còn dưới 7 ngày.",
    )


def _handle_member_notify_link(
    db: Session,
    chat_id: int,
    row: TelegramLinkToken,
    contact: TelegramContact,
    now: datetime,
) -> None:
    """Khách bấm link "Thông báo" của MỘT email → thành người nhận nhắc cho email đó.

    Bản không-cần-gõ của lệnh `/email <địa chỉ>`: đại lý gửi link nên khách không thể
    gõ sai địa chỉ, và không lộ thông tin email nào khác. Cùng luật chống chiếm kênh:
    email đã có người nhận khác thì từ chối.
    """
    member = db.get(Member, row.member_id) if row.member_id else None
    if member is None or member.status not in ("active", "pending"):
        _reply(chat_id, "⚠️ Email trong link không còn hoạt động. Liên hệ nơi bạn đã mua.")
        return

    email_html = telegram.escape_html(member.email)
    if member.notify_telegram_chat_id and member.notify_telegram_chat_id != chat_id:
        _reply(
            chat_id,
            f"⚠️ <code>{email_html}</code> đã được đăng ký nhận thông báo ở một tài "
            "khoản Telegram khác. Liên hệ nơi bạn đã mua nếu cần đổi người nhận.",
        )
        return

    if member.notify_telegram_chat_id != chat_id:
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
            data={"email": member.email, "chat_id": chat_id, "via": "link"},
            commit=False,
        )

    settings = get_settings()
    # Khách có thể đã nhận nhắc cho vài email khác → liệt kê CẢ DANH SÁCH, không chỉ
    # email vừa bấm, để họ thấy đúng những gì mình đang theo dõi.
    listing = _watch_list_html(db, chat_id, now)
    _reply(
        chat_id,
        f"✅ Bạn sẽ nhận nhắc gia hạn cho <code>{email_html}</code>.\n"
        + (f"\n{listing}\n" if listing else "")
        + "\nNhắc trước khi hết hạn "
        + ", ".join(f"{d} ngày" for d in settings.reminder_day_buckets())
        + ".\nGõ /huyemail &lt;địa chỉ&gt; để thôi nhận.",
    )


def _handle_start(db: Session, chat_id: int, user_arg: str, contact: TelegramContact, now: datetime) -> None:
    """`/start <token>` = liên kết tài khoản dashboard; `/start` trơn = chỉ ghi sổ."""
    if not user_arg:
        # Bấm Start lại (link cũ đã hết hạn, hoặc mở lại chat): nếu chat này đã nhận
        # thông báo rồi thì trả luôn danh sách thay vì bài hướng dẫn kết nối.
        listing = _watch_list_html(db, chat_id, now)
        if listing:
            _reply(
                chat_id,
                "✅ Bot đã sẵn sàng.\n\n" + listing + "\n\n" + _HELP_HINT,
            )
            return
        who = f"@{contact.username}" if contact.username else f"ID <code>{chat_id}</code>"
        _reply(
            chat_id,
            "✅ Đã kết nối bot.\n\n"
            f"Tài khoản Telegram của bạn: {who}\n\n"
            "Hiện chưa có email nào gửi thông báo tới đây.\n\n" + _HELP_HINT,
        )
        return

    row = db.get(TelegramLinkToken, user_arg)
    # Link MỜI / link THÔNG BÁO THEO EMAIL dùng được nhiều lần (chỉ hết hiệu lực khi
    # quá hạn); link KẾT NỐI chính chủ dùng-một-lần. Xem docstring TelegramLinkToken.
    if row is not None and row.expires_at > now:
        if row.purpose == "invite_sub":
            _handle_invite_subscription(db, chat_id, row, contact, now)
            return
        if row.purpose == "invite_member":
            _handle_member_notify_link(db, chat_id, row, contact, now)
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
    listing = _watch_list_html(db, chat_id, now)
    _reply(
        chat_id,
        f"✅ Đã liên kết với tài khoản <b>{telegram.escape_html(user.username)}</b>.\n\n"
        f"Bạn sẽ nhận nhắc gia hạn khi email còn "
        f"{', '.join(f'≤{d} ngày' for d in settings.reminder_day_buckets())} "
        f"(gửi lúc {settings.renewal_reminder_hour}:00).\n\n"
        + (listing + "\n\n" if listing else "")
        + _HELP_HINT,
    )


def _handle_list(db: Session, chat_id: int, now: datetime) -> None:
    """`/danhsach` — TOÀN BỘ email chat này đang theo dõi, KHÔNG lọc theo hạn.

    Trước đây lệnh này chỉ trả email hết hạn trong 30 ngày tới: khách vừa bấm link
    "Thông báo" của một email còn hạn dài (hoặc email vô thời hạn) gõ /danhsach ra
    danh sách rỗng và tưởng link hỏng. Phần lọc theo hạn chuyển sang /handung.
    """
    total, members = _watch_members(db, chat_id, LIST_COMMAND_LIMIT)
    if not members:
        # Một câu chung cho cả đại lý đã liên kết lẫn khách lẻ: /email dùng được ở cả
        # hai trường hợp nên không cần tách nhánh theo _linked_owner.
        _reply(
            chat_id,
            "Bạn chưa sở hữu email nào cả.\n"
            "Gõ /email &lt;địa chỉ&gt; để nhận thông báo gia hạn cho email của bạn.\n"
            "ví dụ : /email ex1@example.com",
        )
        return

    footer = "Gõ /handung để xem email còn dưới 7 ngày sử dụng."
    if total > len(members):
        footer = f"… và {total - len(members)} email khác.\n{footer}"
    _reply_lines(
        chat_id,
        f"📋 <b>Email bạn sở hữu ({total})</b>",
        [_member_line(m, now) for m in members],
        footer,
    )


def _handle_expiring(db: Session, chat_id: int, now: datetime) -> None:
    """`/handung` — email còn dưới 7 ngày sử dụng.

    Email ĐÃ hết hạn cũng nằm trong danh sách này: đó chính là những suất cần gia hạn
    gấp nhất, bỏ chúng ra thì người nhận không còn chỗ nào thấy được. Email vô thời hạn
    thì không bao giờ xuất hiện (xem `_watch_members`).
    """
    total, members = _watch_members(
        db, chat_id, LIST_COMMAND_LIMIT, expiring_before=now + EXPIRING_COMMAND_HORIZON
    )
    if not members:
        _reply(
            chat_id,
            "✅ Không có email nào còn dưới 7 ngày sử dụng.\n"
            "Gõ /danhsach để xem toàn bộ email bạn sở hữu.",
        )
        return

    footer = f"… và {total - len(members)} email khác." if total > len(members) else ""
    _reply_lines(
        chat_id,
        f"⏳ <b>Email còn dưới 7 ngày sử dụng ({total})</b>",
        [_member_line(m, now) for m in members],
        footer,
    )


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
    elif command in ("/handung", "/han_dung", "/saphethan"):
        _handle_expiring(db, chat_id, now)
    elif command == "/id":
        who = f"@{contact.username}" if contact.username else "(chưa đặt username)"
        _reply(
            chat_id,
            f"ID của bạn: <code>{chat_id}</code>\nUsername: {telegram.escape_html(who)}\n\n"
            "Gửi một trong hai thông tin này cho người bán để được chỉ định nhận nhắc hạn.",
        )
    elif command in ("/tat", "/stop"):
        _handle_toggle(db, chat_id, False)
    elif command in ("/bat", "/resume"):
        _handle_toggle(db, chat_id, True)
    elif command in ("/huongdan", "/help", "/tro_giup"):
        _reply(chat_id, _help_text())
    else:
        # Gõ sai / nhắn chữ thường: KHÔNG đổ nguyên bài hướng dẫn (spam và dễ
        # khiến khách tưởng bot hiểu), chỉ chỉ đường tới /huongdan.
        _reply(chat_id, "Sai cú pháp : /huongdan để xem hướng dẫn")

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
    # Tên link đã đưa từng người vào — chủ tài khoản phát nhiều link nên cần biết
    # người này đến từ link nào (link đã gỡ/hết hạn thì không còn tên, để trống).
    labels = dict(
        db.execute(
            select(TelegramLinkToken.token, TelegramLinkToken.label).where(
                TelegramLinkToken.user_id == user.id,
                TelegramLinkToken.purpose == "invite_sub",
            )
        ).all()
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
            invite_label=labels.get(row.invite_token) if row.invite_token else None,
        )
        for row in rows
    ]


def _owned_member_ids(db: Session, user: User, member_ids: list[UUID]) -> list[str]:
    """Lọc còn lại email THUỘC user, giữ nguyên thứ tự người dùng chọn.

    Chặn việc trỏ người nhận sang email của tài khoản khác — cùng luật với
    `update_subscription`, kể cả với super-admin (chỉ email do chính họ add).
    """
    owned = set(
        db.execute(
            select(Member.id).where(
                Member.id.in_(member_ids),
                Member.invited_by_user_id == user.id,
            )
        )
        .scalars()
        .all()
    )
    # dict.fromkeys: bỏ trùng nhưng vẫn giữ thứ tự (set() sẽ xáo trộn).
    return list(dict.fromkeys(str(mid) for mid in member_ids if mid in owned))


def _invite_out(row: TelegramLinkToken, bot: str, recipients: int) -> TelegramInviteOut:
    return TelegramInviteOut(
        token=row.token,
        deep_link=f"https://t.me/{bot}?start={row.token}",
        expires_at=row.expires_at,
        created_at=row.created_at,
        label=row.label,
        scope=row.scope or "all",
        member_ids=list(row.member_ids or []),
        recipients=recipients,
    )


@router.post("/api/v1/telegram/subscriptions/invite", response_model=TelegramInviteOut)
def create_subscription_invite(
    payload: TelegramInviteIn | None = None,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramInviteOut:
    """Tạo LINK MỜI: ai bấm vào + Start sẽ nhận thông báo của tài khoản này, theo
    phạm vi email **chọn ngay lúc tạo link**.

    Khác link 'Kết nối Telegram' (chính chủ, dùng-một-lần): link này **dùng nhiều lần**
    trong thời hạn để chủ tài khoản gửi cho vài người; mỗi người bấm tạo một người
    nhận riêng, và chủ tài khoản gỡ/tuỳ chỉnh phạm vi từng người bất cứ lúc nào.

    Nhiều link SỐNG SONG SONG (không xoá link cũ khi tạo link mới): mỗi link là một
    "suất" khác nhau — link cho nhân viên xem toàn bộ, link cho khách chỉ xem 2 email.
    """
    _require_bot()
    bot = _safe_bot_username()
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không lấy được thông tin bot từ Telegram (kiểm tra token bot)",
        )
    data = payload or TelegramInviteIn()
    if data.scope not in ("all", "selected"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="scope phải là 'all' hoặc 'selected'"
        )
    member_ids: list[str] = []
    if data.scope == "selected":
        member_ids = _owned_member_ids(db, user, data.member_ids)
        if not member_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Chọn ít nhất 1 email của bạn, hoặc đổi sang nhận toàn bộ",
            )

    now = datetime.now(timezone.utc)
    # Dọn link đã hết hạn của chính user (không ai bấm được nữa) rồi mới đếm hạn mức.
    db.execute(
        delete(TelegramLinkToken).where(
            TelegramLinkToken.user_id == user.id,
            TelegramLinkToken.purpose == "invite_sub",
            TelegramLinkToken.expires_at <= now,
        )
    )
    active = db.execute(
        select(func.count())
        .select_from(TelegramLinkToken)
        .where(
            TelegramLinkToken.user_id == user.id,
            TelegramLinkToken.purpose == "invite_sub",
            TelegramLinkToken.expires_at > now,
        )
    ).scalar_one()
    if active >= MAX_ACTIVE_INVITES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Đang có {active} link mời còn hiệu lực (tối đa {MAX_ACTIVE_INVITES}). "
                "Gỡ bớt link không dùng rồi tạo lại."
            ),
        )

    token = secrets.token_urlsafe(24)
    row = TelegramLinkToken(
        token=token,
        user_id=user.id,
        purpose="invite_sub",
        label=(data.label or "").strip()[:64] or None,
        scope=data.scope,
        member_ids=member_ids,
        created_at=now,
        expires_at=now + INVITE_TOKEN_TTL,
    )
    db.add(row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_INVITE_CREATED",
        target_type="USER",
        target_id=str(user.id),
        data={"label": row.label, "scope": data.scope, "count": len(member_ids)},
        commit=False,
    )
    db.commit()
    return _invite_out(row, bot, recipients=0)


@router.get("/api/v1/telegram/invites", response_model=list[TelegramInviteOut])
def list_subscription_invites(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[TelegramInviteOut]:
    """Các link mời CÒN HIỆU LỰC của tôi + đã có bao nhiêu người bấm.

    Link hết hạn không liệt kê: không bấm được nữa thì hiện ra chỉ gây bấm nhầm khi
    đi gửi cho người khác.
    """
    bot = _safe_bot_username() or ""
    now = datetime.now(timezone.utc)
    rows = (
        db.execute(
            select(TelegramLinkToken)
            .where(
                TelegramLinkToken.user_id == user.id,
                TelegramLinkToken.purpose == "invite_sub",
                TelegramLinkToken.expires_at > now,
            )
            .order_by(TelegramLinkToken.created_at.desc())
        )
        .scalars()
        .all()
    )
    if not rows:
        return []
    counts = dict(
        db.execute(
            select(TelegramSubscription.invite_token, func.count())
            .where(
                TelegramSubscription.user_id == user.id,
                TelegramSubscription.invite_token.in_([r.token for r in rows]),
            )
            .group_by(TelegramSubscription.invite_token)
        ).all()
    )
    return [_invite_out(row, bot, recipients=int(counts.get(row.token, 0))) for row in rows]


@router.delete("/api/v1/telegram/invites/{token}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subscription_invite(
    token: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    """Gỡ link mời: ai chưa bấm thì hết bấm được.

    KHÔNG đụng tới người ĐÃ bấm — họ vẫn đang nhận thông báo; muốn ngắt thì gỡ ở
    danh sách "Người nhận thông báo" (hai việc khác nhau, gộp lại sẽ gây gỡ nhầm).
    """
    row = db.get(TelegramLinkToken, token)
    if row is None or row.user_id != user.id or row.purpose != "invite_sub":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy link")
    db.delete(row)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_INVITE_REVOKED",
        target_type="USER",
        target_id=str(user.id),
        data={"label": row.label},
        commit=False,
    )
    db.commit()


@router.get("/api/v1/telegram/template", response_model=TelegramTemplateOut)
def get_template(
    scope: str = "all",
    chat_id: int | None = None,
    member_id: UUID | None = None,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramTemplateOut:
    """Mẫu của MỘT phạm vi + MẪU GỐC để đối chiếu/khôi phục.

    Không truyền gì = phạm vi 'all' (mẫu chung) — giữ nguyên hành vi cũ cho client cũ.
    """
    scope, chat_id, member_id = _check_template_scope(db, user, scope, chat_id, member_id)
    row = _template_row(db, user, scope, chat_id, member_id)
    return _template_out(
        db,
        user,
        scope,
        chat_id,
        member_id,
        row.body if row else None,
        row.item_line if row else None,
    )


@router.put("/api/v1/telegram/template", response_model=TelegramTemplateOut)
def save_template(
    payload: TelegramTemplateIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramTemplateOut:
    """Lưu mẫu cho một phạm vi. Bỏ trống cả hai ô = xoá mẫu đó (quay về mẫu ngoài).

    Chặn biến `{lạ}` NGAY LÚC LƯU: phát hiện lúc gửi thì tin đã đi rồi, người nhận
    thấy một chỗ trống khó hiểu mà đại lý không biết.
    """
    scope, chat_id, member_id = _check_template_scope(
        db, user, payload.scope, payload.chat_id, payload.member_id
    )
    body = (payload.body or "").strip() or None
    item_line = (payload.item_line or "").strip() or None

    for value, key in ((body, "body"), (item_line, "item_line")):
        if not value:
            continue
        bad = renewal_reminder.unknown_placeholders(
            value, renewal_reminder.TEMPLATE_PLACEHOLDERS[key]
        )
        if bad:
            allowed = ", ".join(f"{{{p}}}" for p in renewal_reminder.TEMPLATE_PLACEHOLDERS[key])
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Biến không hợp lệ: {', '.join('{' + b + '}' for b in bad)}. "
                    f"Chỉ dùng: {allowed}"
                ),
            )

    row = _template_row(db, user, scope, chat_id, member_id)
    if body is None and item_line is None:
        if row is not None:
            db.delete(row)
    else:
        if row is None:
            row = TelegramTemplate(
                user_id=user.id, scope=scope, chat_id=chat_id, member_id=member_id
            )
            db.add(row)
        row.body = body
        row.item_line = item_line
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.username,
        action="TELEGRAM_TEMPLATE_UPDATED" if (body or item_line) else "TELEGRAM_TEMPLATE_RESET",
        target_type="USER",
        target_id=str(user.id),
        # Phạm vi nào bị đổi — không ghi thì log chỉ nói "đã sửa mẫu" mà không biết mẫu nào.
        data={"scope": scope, "chat_id": chat_id, "member_id": str(member_id) if member_id else None},
        commit=False,
    )
    db.commit()
    return _template_out(db, user, scope, chat_id, member_id, body, item_line)


def _check_template_scope(
    db: Session, user: User, scope: str, chat_id: int | None, member_id: UUID | None
) -> tuple[str, int | None, UUID | None]:
    """Chuẩn hoá + kiểm tra phạm vi. Trả về đúng bộ (scope, chat_id, member_id) để lưu.

    Chặn ngay ở đây chứ không tin client: soạn mẫu cho chat/email của người khác là
    nhìn trộm được họ đang theo dõi gì (và ghi đè nội dung tin của họ).
    """
    if scope not in ("all", "chat", "member"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Phạm vi phải là 'all', 'chat' hoặc 'member'",
        )
    if scope == "all":
        return "all", None, None
    if scope == "chat":
        if chat_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Thiếu chat_id cho mẫu theo người nhận",
            )
        if chat_id not in {r.chat_id for r in _recipient_options(db, user)}:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Người nhận không nằm trong danh sách nhận thông báo của bạn",
            )
        return "chat", chat_id, None
    if member_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Thiếu member_id cho mẫu theo email"
        )
    stmt = select(Member.id).where(Member.id == member_id)
    if not user.is_super_admin:
        stmt = stmt.where(Member.invited_by_user_id == user.id)
    if db.execute(stmt).scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Email không tồn tại hoặc bạn không có quyền truy cập",
        )
    return "member", None, member_id


def _template_row(
    db: Session, user: User, scope: str, chat_id: int | None, member_id: UUID | None
) -> TelegramTemplate | None:
    stmt = select(TelegramTemplate).where(
        TelegramTemplate.user_id == user.id, TelegramTemplate.scope == scope
    )
    if scope == "chat":
        stmt = stmt.where(TelegramTemplate.chat_id == chat_id)
    elif scope == "member":
        stmt = stmt.where(TelegramTemplate.member_id == member_id)
    return db.execute(stmt).scalars().first()


def _recipient_options(db: Session, user: User) -> list[TelegramRecipientOut]:
    """Mọi chat Telegram đang nhận thông báo CỦA TÔI — ba nguồn, gộp theo chat_id.

    Một người có thể vừa là chính chủ vừa được chỉ định cho một email; gộp lại để ô
    chọn không hiện hai dòng trỏ cùng một chat (mà mẫu thì chỉ có một).
    """
    out: dict[int, TelegramRecipientOut] = {}
    if user.telegram_chat_id:
        out[user.telegram_chat_id] = TelegramRecipientOut(
            chat_id=user.telegram_chat_id, label=user.username, kind="owner"
        )
    subs = (
        db.execute(
            select(TelegramSubscription)
            .where(TelegramSubscription.user_id == user.id)
            .order_by(TelegramSubscription.created_at)
        )
        .scalars()
        .all()
    )
    for sub in subs:
        out.setdefault(
            sub.chat_id,
            TelegramRecipientOut(
                chat_id=sub.chat_id,
                label=sub.display_name or f"chat {sub.chat_id}",
                kind="subscriber",
            ),
        )
    assigned = db.execute(
        select(Member.notify_telegram_chat_id, Member.notify_telegram_target)
        .where(
            Member.invited_by_user_id == user.id,
            Member.notify_telegram_chat_id.is_not(None),
        )
        .distinct()
    ).all()
    for assigned_chat_id, target in assigned:
        out.setdefault(
            assigned_chat_id,
            TelegramRecipientOut(
                chat_id=assigned_chat_id,
                label=target or f"chat {assigned_chat_id}",
                kind="assignee",
            ),
        )
    return list(out.values())


def _template_overrides(db: Session, user: User) -> list[TelegramTemplateScopeOut]:
    """Các phạm vi ĐANG có mẫu riêng, kèm tên để web hiện "đã tuỳ chỉnh" ngay trên ô chọn."""
    rows = (
        db.execute(select(TelegramTemplate).where(TelegramTemplate.user_id == user.id))
        .scalars()
        .all()
    )
    emails = dict(
        db.execute(
            select(Member.id, Member.email).where(
                Member.id.in_([r.member_id for r in rows if r.member_id])
            )
        ).all()
    )
    labels = {r.chat_id: r.label for r in _recipient_options(db, user)}
    return [
        TelegramTemplateScopeOut(
            scope=row.scope,
            chat_id=row.chat_id,
            member_id=row.member_id,
            label=emails.get(row.member_id) if row.member_id else labels.get(row.chat_id or 0),
            updated_at=row.updated_at,
        )
        for row in rows
    ]


def _template_audience(
    db: Session, user: User, scope: str, chat_id: int | None, member_id: UUID | None
) -> str:
    """Loại người nhận mà mẫu của phạm vi này sẽ tới — quyết định MẪU GỐC đem ra sửa.

    Mỗi loại người nhận có mẫu gốc riêng (`renewal_reminder.default_body`): đại lý thấy
    link gia hạn, khách lẻ được bảo liên hệ nơi đã mua. Lấy mẫu của đại lý làm khởi
    điểm cho mẫu gửi khách thì người soạn sửa nhầm nội dung ngay từ dòng đầu.
    """
    if scope == "chat" and chat_id is not None:
        for recipient in _recipient_options(db, user):
            if recipient.chat_id == chat_id:
                return recipient.kind
    if scope == "member" and member_id is not None:
        member = db.get(Member, member_id)
        if member is not None and member.notify_telegram_chat_id:
            return "assignee"
    # Chưa chỉ định ai → chính đại lý nhận tin của email đó (xem `_recipients_for`).
    return "owner"


def _template_out(
    db: Session,
    user: User,
    scope: str,
    chat_id: int | None,
    member_id: UUID | None,
    body: str | None,
    item_line: str | None,
) -> TelegramTemplateOut:
    audience = _template_audience(db, user, scope, chat_id, member_id)
    default_body = renewal_reminder.default_body(audience)
    default_item_line = renewal_reminder.default_item_line(audience)
    shared = _template_row(db, user, "all", None, None) if scope != "all" else None
    base_body = (shared.body if shared else None) or default_body
    base_item_line = (shared.item_line if shared else None) or default_item_line
    real = _preview_real_sample(db, user, scope, chat_id, member_id)
    return TelegramTemplateOut(
        scope=scope,
        chat_id=chat_id,
        member_id=member_id,
        body=body,
        item_line=item_line,
        default_body=default_body,
        default_item_line=default_item_line,
        base_body=base_body,
        base_item_line=base_item_line,
        body_placeholders=list(renewal_reminder.TEMPLATE_PLACEHOLDERS["body"]),
        item_placeholders=list(renewal_reminder.TEMPLATE_PLACEHOLDERS["item_line"]),
        # Chưa có mẫu riêng thì xem trước phải là mẫu SẼ dùng thay nó (mẫu chung, không
        # thì mẫu gốc của đúng loại người nhận), chứ không phải mẫu gốc của đại lý.
        preview=_preview_template(body or base_body, item_line or base_item_line, user.username),
        sample=_preview_sample(user.username),
        preview_real=(
            _render_sample(body or base_body, item_line or base_item_line, real)
            if real
            else None
        ),
        sample_real=real,
        overrides=_template_overrides(db, user),
        recipients=_recipient_options(db, user),
        audience=audience,
    )


def _preview_sample(owner_username: str) -> dict[str, Any]:
    """DỮ LIỆU MẪU cho bản xem trước — một nguồn duy nhất.

    Server dựng `preview` từ đây, và web cũng nhận nguyên bộ này để dựng lại lúc người
    dùng đang gõ. Hai nơi cùng một bộ số thì bản xem trước lúc gõ không "nhảy" khác đi
    sau khi bấm Lưu.
    """
    items = [
        {"email": "khach_a@gmail.com", "expiry": "06/08/2026 09:15", "days_left": "còn 2 ngày 20 giờ"},
        {"email": "khach_b@gmail.com", "expiry": "07/08/2026 14:00", "days_left": "còn 3 ngày"},
    ]
    return {
        "items": items,
        "count": len(items),
        "bucket": 3,
        "link": f"{get_settings().frontend_origin.rstrip('/')}/renewals",
        "owner": owner_username,
        "workspace": "Workspace 1",
    }


# Số email THẬT tối đa đem vào bản xem trước. Đủ thấy danh sách nhiều dòng trông thế
# nào mà không biến ô soạn mẫu thành một trang danh sách thứ hai.
PREVIEW_REAL_LIMIT = 5


def _preview_real_members(
    db: Session, user: User, scope: str, chat_id: int | None, member_id: UUID | None
) -> list[Member]:
    """Email THẬT rơi vào phạm vi đang sửa — gần hết hạn nhất trước.

    Lọc đúng như lúc gửi thật (`renewal_reminder._recipients_for`): chat của chính đại
    lý chỉ nhận email CHƯA chỉ định khách, người được mời nhận theo phạm vi đăng ký,
    khách được chỉ định chỉ nhận email của mình. Lọc khác đi thì bản xem trước "thật"
    lại vẽ ra một tin không bao giờ được gửi.
    """
    rows = (
        db.execute(
            select(Member)
            .where(
                Member.invited_by_user_id == user.id,
                Member.status.in_(("active", "pending")),
                Member.subscription_end_at.is_not(None),
            )
            .order_by(Member.subscription_end_at)
            .limit(200)
        )
        .scalars()
        .all()
    )
    if scope == "member":
        return [m for m in rows if m.id == member_id][:PREVIEW_REAL_LIMIT]
    if scope == "chat" and chat_id is not None:
        if user.telegram_chat_id == chat_id:
            keep = [m for m in rows if not m.notify_telegram_chat_id]
        else:
            subs = (
                db.execute(
                    select(TelegramSubscription).where(
                        TelegramSubscription.user_id == user.id,
                        TelegramSubscription.chat_id == chat_id,
                    )
                )
                .scalars()
                .all()
            )
            keep = (
                [m for m in rows if any(renewal_reminder.subscription_covers(s, m) for s in subs)]
                if subs
                else [m for m in rows if m.notify_telegram_chat_id == chat_id]
            )
        return keep[:PREVIEW_REAL_LIMIT]
    return rows[:PREVIEW_REAL_LIMIT]


def _preview_real_sample(
    db: Session, user: User, scope: str, chat_id: int | None, member_id: UUID | None
) -> dict[str, Any] | None:
    """Bộ dữ liệu THẬT cho bản xem trước thứ hai — `None` khi phạm vi chưa có email nào.

    Dữ liệu giả cho biết mẫu trông thế nào; dữ liệu thật cho biết mẫu ấy áp lên đúng
    những email mình đang có. `count` đếm số dòng thật sự hiện ra để tin xem trước
    không tự mâu thuẫn với chính danh sách bên dưới nó.
    """
    members = _preview_real_members(db, user, scope, chat_id, member_id)
    if not members:
        return None
    now = datetime.now(timezone.utc)
    settings = get_settings()
    buckets = settings.reminder_day_buckets()
    nearest = (members[0].subscription_end_at - now).total_seconds() / 86400
    esc = telegram.escape_html
    return {
        "items": [
            {
                "email": esc(m.email),
                "expiry": esc(renewal_reminder._fmt_dt(m.subscription_end_at)),
                "days_left": esc(renewal_reminder._fmt_left(m.subscription_end_at, now)),
            }
            for m in members
        ],
        "count": len(members),
        # Email còn hạn dài chưa thuộc mốc nào → lấy mốc lớn nhất, đúng mốc nó sẽ rơi vào.
        "bucket": renewal_reminder._bucket_for(nearest, buckets) or max(buckets),
        "link": f"{settings.frontend_origin.rstrip('/')}/renewals",
        "owner": esc(user.username),
        "workspace": esc(_workspace_name(db, members[0]) or "—"),
    }


def _workspace_name(db: Session, member: Member) -> str | None:
    ws = db.get(Workspace, member.workspace_id)
    return ws.name if ws else None


def _render_sample(body_tpl: str, line_tpl: str, sample: dict[str, Any]) -> str:
    """Dựng tin từ mẫu + MỘT bộ dữ liệu bất kỳ (giả hay thật) — khớp `buildPreview` bên web."""
    common = {"bucket": sample["bucket"], "owner": sample["owner"]}
    lines = "\n".join(
        renewal_reminder.render_template(
            line_tpl, {**item, **common, "workspace": sample["workspace"]}
        )
        for item in sample["items"]
    )
    return renewal_reminder.render_template(
        body_tpl,
        {**common, "items": lines, "count": sample["count"], "link": sample["link"]},
    )


def _preview_template(
    body: str | None, item_line: str | None, owner_username: str
) -> str:
    """Xem trước bằng DỮ LIỆU MẪU — người dùng thấy ngay tin thật trông thế nào."""
    return _render_sample(
        body or renewal_reminder.default_body("owner"),
        item_line or renewal_reminder.default_item_line("owner"),
        _preview_sample(owner_username),
    )


@router.post("/api/v1/telegram/notify-link", response_model=TelegramLinkOut)
def create_member_notify_link(
    payload: TelegramMemberLinkIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TelegramLinkOut:
    """Link "Thông báo" cho MỘT email — gửi cho khách để họ nhận nhắc gia hạn email đó.

    Dùng ngay sau khi mời thành công: đại lý bấm nút Thông báo trên dòng email → gửi
    link → khách bấm Start. Khách không phải gõ địa chỉ nên không gõ sai, và link
    không lộ bất kỳ email nào khác.

    Quyền: chỉ email THUỘC người gọi (super-admin thấy tất cả) — dùng chung bộ lọc
    visibility với các endpoint member khác.
    """
    _require_bot()
    bot = _safe_bot_username()
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không lấy được thông tin bot từ Telegram (kiểm tra token bot)",
        )
    stmt = select(Member).where(Member.id == payload.member_id)
    if not user.is_super_admin:
        stmt = stmt.where(Member.invited_by_user_id == user.id)
    member = db.execute(stmt).scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Email không tồn tại hoặc bạn không có quyền truy cập",
        )

    now = datetime.now(timezone.utc)
    # Mỗi email chỉ giữ 1 link đang hiệu lực: bấm lại nút = link mới, link cũ hết dùng.
    db.execute(
        delete(TelegramLinkToken).where(
            TelegramLinkToken.purpose == "invite_member",
            TelegramLinkToken.member_id == member.id,
        )
    )
    token = secrets.token_urlsafe(24)
    row = TelegramLinkToken(
        token=token,
        user_id=user.id,
        purpose="invite_member",
        member_id=member.id,
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
        row.member_ids = _owned_member_ids(db, user, payload.member_ids)
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
    invite = db.get(TelegramLinkToken, row.invite_token) if row.invite_token else None
    return TelegramSubscriptionOut(
        id=row.id,
        chat_id=row.chat_id,
        display_name=row.display_name,
        scope=row.scope,
        member_ids=list(row.member_ids or []),
        enabled=row.enabled,
        created_at=row.created_at,
        invite_label=invite.label if invite is not None else None,
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
            "<b>Thông báo thử</b> — bot nhắc gia hạn đang hoạt động bình thường.",
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
        # PHẢI dùng secret ĐANG HIỆU LỰC (env hoặc DB), không phải riêng env: token
        # nhập từ giao diện thì secret nằm trong DB, lấy nhầm env rỗng ⇒ Telegram gửi
        # update KHÔNG kèm secret ⇒ handler fail-closed chặn sạch, bot im lặng hoàn
        # toàn mà không có lỗi nào nhìn thấy được. (Bug thật, 2026-08-03.)
        telegram.set_webhook(url, telegram.webhook_secret())
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
