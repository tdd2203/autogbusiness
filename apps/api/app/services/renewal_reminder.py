"""Nhắc gia hạn tự động qua Telegram — quét hạn dùng → gộp tin → gửi → ghi nhật ký.

⚠️ ĐỌC TRƯỚC: `docs/Notifications/Renewal_Reminder_Telegram.md` (nghiệp vụ + lịch sử)
và `app/routers/members/EXPIRY_RULES.md` (hạn dùng là NGUỒN CHÂN LÝ — module này chỉ
ĐỌC `subscription_end_at`, tuyệt đối không tự tính lại hạn).

NGUYÊN LÝ (học từ dự án Tele_Bot — jobs/promotion_expiry_notifier + notification_policy):
  1. QUÉT   : tìm email sắp hết hạn trong cửa sổ mốc lớn nhất (mặc định 3 ngày).
  2. GIÀNH  : mỗi (email × người nhận × mốc) chèn 1 hàng `telegram_notifications` với
              `dedupe_key` UNIQUE + ON CONFLICT DO NOTHING. Đây là TOÀN BỘ cơ chế chống
              trùng: job chạy lại 100 lần cũng chỉ ra đúng 1 tin cho mỗi mốc.
  3. GỘP    : các hàng pending cùng (người nhận, mốc) gộp thành MỘT tin nhắn nhiều dòng
              — đại lý có 20 email đến hạn nhận 1 tin, không phải 20 tin.
  4. GỬI    : lỗi VĨNH VIỄN (bị chặn / chưa /start) → 'blocked', thôi thử lại. Lỗi TẠM
              (mạng, 429) → 'failed' + tăng `attempts`, tick sau tự gửi lại tới 3 lần.

AI NHẬN (theo thứ tự ưu tiên, xem `_recipients_for`):
  - CHỈ ĐỊNH riêng của email (`members.notify_telegram_*`) — nếu đã resolve được chat_id
    thì tin gửi cho người đó **thay cho** đại lý (đúng nghĩa "chỉ định").
  - Ngược lại: ĐẠI LÝ đã add email (`members.invited_by_user_id`) nếu đã liên kết bot.
  - Luôn kèm: các chat trong `TELEGRAM_ADMIN_CHAT_ID` nhận BẢN TỔNG HỢP (trừ email của
    tài khoản gắn cờ `is_test` — tránh nhiễu số liệu/thông báo thử nghiệm).

KHUNG GIỜ: quét chỉ chạy trong giờ `RENEWAL_REMINDER_HOUR` (giờ VN) → không nhắn lúc
nửa đêm. Việc GỬI (kể cả retry) chạy mọi tick.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import (
    Member,
    TelegramContact,
    TelegramNotification,
    User,
    Workspace,
)
from app.services import telegram

logger = logging.getLogger(__name__)

EVENT_RENEWAL = "renewal_reminder"
# Số lần thử lại tối đa cho lỗi TẠM trước khi bỏ cuộc (giống _BATCH retry của Tele_Bot).
MAX_ATTEMPTS = 3
# Trần số hàng xử lý mỗi tick — chặn trường hợp tồn đọng lớn làm nghẽn tick nền.
FLUSH_LIMIT = 500

# Serialize các lượt chạy TRONG CÙNG process: tick nền (mỗi 5′) và nút "Chạy nhắc
# ngay" của super-admin có thể rơi vào nhau → hai lượt `flush_pending` cùng chọn một
# tập hàng 'pending' ⇒ người nhận bị nhắn TRÙNG (đúng thứ tính năng này phải tránh).
# Giả định: API chạy 1 worker uvicorn (Dockerfile CMD). Nếu sau này chạy nhiều
# worker/replica thì khoá tiến-trình này KHÔNG đủ — phải đổi sang khoá cấp DB
# (vd `SELECT … FOR UPDATE SKIP LOCKED` khi lấy hàng pending).
_TICK_LOCK = threading.Lock()


# ── Thời gian địa phương ──────────────────────────────────────────────────────


def local_tz() -> timezone:
    """Múi giờ hiển thị/chốt giờ gửi. Offset CỐ ĐỊNH (VN không có DST) nên chính xác
    tuyệt đối mà không cần tzdata — image slim thường thiếu gói này."""
    return timezone(timedelta(hours=get_settings().renewal_reminder_utc_offset))


def to_local(value: datetime) -> datetime:
    return value.astimezone(local_tz())


def _fmt_dt(value: datetime) -> str:
    return to_local(value).strftime("%d/%m/%Y %H:%M")


def _fmt_left(end_at: datetime, now: datetime) -> str:
    """'còn 2 ngày 3 giờ' / 'còn 5 giờ' / 'còn 20 phút' — độ chính xác giảm dần."""
    delta = end_at - now
    total_minutes = max(0, int(delta.total_seconds() // 60))
    days, rem_minutes = divmod(total_minutes, 24 * 60)
    hours, minutes = divmod(rem_minutes, 60)
    if days:
        return f"còn {days} ngày {hours} giờ" if hours else f"còn {days} ngày"
    if hours:
        return f"còn {hours} giờ {minutes} phút" if minutes else f"còn {hours} giờ"
    return f"còn {minutes} phút"


# ── Chỉ định người nhận theo từng email ───────────────────────────────────────


def normalize_target(raw: str | None) -> tuple[str | None, int | None]:
    """Chuẩn hoá ô 'người nhận chỉ định' → (giá trị lưu, chat_id nếu nhập ID số).

    Chấp nhận: '@username', 'username', 't.me/username', hoặc ID số ('123456789').
    Trả (None, None) khi xoá chỉ định. Raise ValueError nếu không hợp lệ.
    """
    text = (raw or "").strip()
    if not text:
        return None, None
    if text.lower().startswith(("https://t.me/", "http://t.me/", "t.me/")):
        text = text.rsplit("/", 1)[-1]
    text = text.lstrip("@").strip()
    if not text:
        raise ValueError("Người nhận không hợp lệ")
    if text.lstrip("-").isdigit():
        chat_id = int(text)
        if chat_id == 0:
            raise ValueError("ID Telegram không hợp lệ")
        return str(chat_id), chat_id
    # Quy tắc username Telegram: 5–32 ký tự, chữ/số/gạch dưới.
    cleaned = text.lower()
    if not (5 <= len(cleaned) <= 32) or not all(c.isalnum() or c == "_" for c in cleaned):
        raise ValueError(
            "Chỉ nhận @username Telegram (5–32 ký tự, chữ/số/gạch dưới) hoặc ID số"
        )
    return f"@{cleaned}", None


def resolve_assignee_chat_id(db: Session, member: Member) -> int | None:
    """chat_id của người được CHỈ ĐỊNH cho email này, hoặc None nếu chưa sẵn sàng.

    @username chỉ khớp được sau khi người đó bấm /start bot (bảng `telegram_contacts`)
    — đó là ràng buộc của Telegram, không phải lựa chọn thiết kế. Khớp xong thì LƯU
    LẠI vào `notify_telegram_chat_id` để lần sau khỏi tra.
    """
    if member.notify_telegram_chat_id:
        return member.notify_telegram_chat_id
    target = (member.notify_telegram_target or "").strip()
    if not target.startswith("@"):
        return None
    contact = db.execute(
        select(TelegramContact).where(
            TelegramContact.username == target[1:].lower(),
            TelegramContact.blocked_at.is_(None),
        )
    ).scalar_one_or_none()
    if not contact:
        return None
    member.notify_telegram_chat_id = contact.chat_id
    db.add(member)
    return contact.chat_id


# ── Quét & giành chỗ ──────────────────────────────────────────────────────────


def _bucket_for(days_left: float, buckets: list[int]) -> int | None:
    """Mốc nhắc hiện tại = mốc NHỎ NHẤT còn áp dụng được.

    Ví dụ buckets=[3,1]: còn 2.4 ngày → mốc 3; còn 0.8 ngày → mốc 1. Vì thời gian
    chỉ trôi một chiều, một email đã rơi vào mốc 1 sẽ không bao giờ quay lại mốc 3
    → không có nguy cơ gửi trùng nội dung ở hai mốc khác nhau trong cùng một ngày.
    """
    applicable = [b for b in buckets if days_left <= b]
    return min(applicable) if applicable else None


def _dedupe_key(member_id: UUID, bucket: int, chat_id: int) -> str:
    return f"{EVENT_RENEWAL}:{member_id}:{bucket}d:{chat_id}"


def _recipients_for(
    db: Session,
    member: Member,
    owner: User | None,
    admin_chat_ids: list[int],
    blocked_chats: set[int],
) -> list[tuple[int, str, UUID | None]]:
    """Danh sách (chat_id, recipient_kind, user_id) sẽ nhận nhắc cho email này.

    `blocked_chats` = những chat đã chặn bot → bỏ qua hẳn, không tạo tin để rồi
    gửi thất bại mỗi mốc. Họ /start lại thì webhook xoá dấu chặn và nhận lại bình thường.
    """
    out: list[tuple[int, str, UUID | None]] = []

    assignee_chat = resolve_assignee_chat_id(db, member)
    if assignee_chat and assignee_chat not in blocked_chats:
        out.append((assignee_chat, "assignee", None))
    # CỐ Ý rơi xuống nhánh đại lý khi người được chỉ định chưa khớp được HOẶC đã chặn
    # bot: thà đại lý nhận rồi tự nhắc khách còn hơn không ai biết email sắp hết hạn.
    elif (
        owner is not None
        and owner.is_active
        and owner.telegram_chat_id
        and owner.telegram_notify_enabled
        and owner.telegram_chat_id not in blocked_chats
    ):
        # Chưa chỉ định (hoặc chỉ định chưa khớp được) → đại lý nhận, không mất tin.
        out.append((owner.telegram_chat_id, "owner", owner.id))

    if not (owner is not None and owner.is_test):
        for admin_chat in admin_chat_ids:
            if admin_chat in blocked_chats:
                continue
            if all(admin_chat != chat for chat, _, _ in out):
                out.append((admin_chat, "admin", None))
    return out


def scan_and_claim(db: Session, now: datetime | None = None) -> dict:
    """Tìm email sắp hết hạn → tạo hàng 'pending' (chống trùng bằng dedupe_key).

    Idempotent tuyệt đối: gọi bao nhiêu lần trong cùng một mốc cũng chỉ tạo tin một
    lần. Trả thống kê để endpoint/admin quan sát được job có chạy hay không.
    """
    settings = get_settings()
    now = now or datetime.now(timezone.utc)
    buckets = settings.reminder_day_buckets()
    horizon = now + timedelta(days=max(buckets))
    # Nhóm digest lấy từ cấu hình ĐANG HIỆU LỰC (.env hoặc bảng telegram_settings
    # super-admin nhập ở Dashboard) — xem services/telegram.runtime_config.
    admin_chat_ids = telegram.admin_chat_ids()

    rows = db.execute(
        select(Member, User)
        .outerjoin(User, User.id == Member.invited_by_user_id)
        .where(
            Member.status.in_(("active", "pending")),
            Member.subscription_end_at.is_not(None),
            Member.subscription_end_at > now,
            Member.subscription_end_at <= horizon,
        )
    ).all()

    # Ai đã chặn bot thì thôi tạo tin cho họ (1 truy vấn/lượt quét, xem _recipients_for).
    blocked_chats = set(
        db.execute(
            select(TelegramContact.chat_id).where(TelegramContact.blocked_at.is_not(None))
        )
        .scalars()
        .all()
    )

    claimed = 0
    considered = 0
    for member, owner in rows:
        days_left = (member.subscription_end_at - now).total_seconds() / 86400
        bucket = _bucket_for(days_left, buckets)
        if bucket is None:
            continue
        considered += 1
        for chat_id, kind, user_id in _recipients_for(
            db, member, owner, admin_chat_ids, blocked_chats
        ):
            stmt = (
                pg_insert(TelegramNotification)
                .values(
                    id=uuid4(),
                    event_type=EVENT_RENEWAL,
                    dedupe_key=_dedupe_key(member.id, bucket, chat_id),
                    member_id=member.id,
                    user_id=user_id,
                    chat_id=chat_id,
                    recipient_kind=kind,
                    days_bucket=bucket,
                    status="pending",
                    attempts=0,
                )
                .on_conflict_do_nothing(index_elements=["dedupe_key"])
                # RETURNING: chỉ trả hàng khi THỰC SỰ chèn được. Đếm theo đây thay vì
                # `rowcount` — rowcount của INSERT…ON CONFLICT qua driver trả -1
                # ("không xác định") nên đếm sai (bug thấy khi chạy test 2026-08-03).
                .returning(TelegramNotification.id)
            )
            claimed += len(db.execute(stmt).fetchall())
    db.commit()
    if claimed:
        logger.info(
            "[tele-reminder] quét %d email đến mốc nhắc → tạo %d tin mới", considered, claimed
        )
    return {"scanned": len(rows), "due": considered, "claimed": claimed}


# ── Dựng nội dung ─────────────────────────────────────────────────────────────


def _render_message(
    kind: str,
    bucket: int,
    items: list[tuple[Member, str | None, str | None]],
    now: datetime,
) -> list[str]:
    """Dựng (một hoặc nhiều) tin HTML cho 1 người nhận. `items` = (member, tên
    workspace, username chủ sở hữu)."""
    esc = telegram.escape_html
    settings = get_settings()
    link = f"{settings.frontend_origin.rstrip('/')}/renewals"

    lines: list[str] = []
    for member, workspace_name, owner_username in items:
        end_at = member.subscription_end_at
        left = _fmt_left(end_at, now) if end_at else ""
        base = f"• <code>{esc(member.email)}</code> — hết hạn {esc(_fmt_dt(end_at))} ({esc(left)})"
        if kind == "admin":
            owner_text = owner_username or "chưa có chủ"
            base += f"\n   chủ: {esc(owner_text)} · {esc(workspace_name or '—')}"
        lines.append(base)

    if kind == "admin":
        header = f"📋 <b>Tổng hợp sắp hết hạn</b> — còn ≤{bucket} ngày · {len(items)} email"
        footer = f"Xử lý tại: {esc(link)}"
    elif kind == "assignee":
        header = f"⏰ <b>Tài khoản ChatGPT sắp hết hạn</b> — còn ≤{bucket} ngày"
        footer = "Vui lòng liên hệ nơi bạn đã mua để gia hạn trước khi hết hạn."
    else:
        header = f"⏰ <b>Nhắc gia hạn</b> — {len(items)} email còn ≤{bucket} ngày"
        footer = (
            f"Gia hạn tại: {esc(link)}\n"
            "<i>Hết hạn là hệ thống tự gỡ email khỏi workspace (không có ân hạn).</i>"
        )
    return telegram.split_html_lines(header, lines, footer)


# ── Gửi & retry ───────────────────────────────────────────────────────────────


def flush_pending(db: Session, now: datetime | None = None) -> dict:
    """Gửi mọi tin đang chờ (gộp theo người nhận) + thử lại tin lỗi tạm."""
    now = now or datetime.now(timezone.utc)
    pending = (
        db.execute(
            select(TelegramNotification)
            .where(
                or_(
                    TelegramNotification.status == "pending",
                    and_(
                        TelegramNotification.status == "failed",
                        TelegramNotification.attempts < MAX_ATTEMPTS,
                    ),
                )
            )
            .order_by(TelegramNotification.created_at)
            .limit(FLUSH_LIMIT)
        )
        .scalars()
        .all()
    )
    if not pending:
        return {"sent": 0, "failed": 0, "blocked": 0, "skipped": 0}

    member_ids = {n.member_id for n in pending if n.member_id}
    detail: dict[UUID, tuple[Member, str | None, str | None]] = {}
    if member_ids:
        for member, workspace_name, owner_username in db.execute(
            select(Member, Workspace.name, User.username)
            .outerjoin(Workspace, Workspace.id == Member.workspace_id)
            .outerjoin(User, User.id == Member.invited_by_user_id)
            .where(Member.id.in_(member_ids))
        ).all():
            detail[member.id] = (member, workspace_name, owner_username)

    groups: dict[tuple[int, str, int], list[TelegramNotification]] = {}
    stats = {"sent": 0, "failed": 0, "blocked": 0, "skipped": 0}

    for notif in pending:
        row = detail.get(notif.member_id) if notif.member_id else None
        member = row[0] if row else None
        # Đã gia hạn (hạn đẩy ra khỏi mốc) / đã bị gỡ trong lúc chờ → tin không còn
        # đúng nữa. Đánh dấu 'skipped' thay vì gửi thông tin sai.
        if (
            member is None
            or member.subscription_end_at is None
            or member.status not in ("active", "pending")
            or member.subscription_end_at <= now
            or (member.subscription_end_at - now).total_seconds() / 86400 > notif.days_bucket
        ):
            notif.status = "skipped"
            notif.error = "hạn đã thay đổi trước khi gửi"
            db.add(notif)
            stats["skipped"] += 1
            continue
        groups.setdefault((notif.chat_id, notif.recipient_kind, notif.days_bucket), []).append(
            notif
        )

    for (chat_id, kind, bucket), notifs in groups.items():
        items = [detail[n.member_id] for n in notifs if n.member_id in detail]
        items.sort(key=lambda it: it[0].subscription_end_at or now)
        messages = _render_message(kind, bucket, items, now)
        try:
            last_message_id = 0
            for text in messages:
                last_message_id = telegram.send_message(chat_id, text).message_id
        except telegram.TelegramError as exc:
            permanent = exc.permanent
            for notif in notifs:
                notif.attempts += 1
                notif.error = f"{exc.code}: {exc.description}"[:1000]
                notif.status = "blocked" if permanent else "failed"
                db.add(notif)
            stats["blocked" if permanent else "failed"] += len(notifs)
            if exc.code in ("blocked", "not_started"):
                _mark_contact_blocked(db, chat_id, now)
            logger.warning(
                "[tele-reminder] gửi tới %s thất bại (%s): %s", chat_id, exc.code, exc.description
            )
            continue

        for notif in notifs:
            notif.status = "sent"
            notif.attempts += 1
            notif.sent_at = now
            notif.error = None
            notif.telegram_message_id = last_message_id or None
            db.add(notif)
        stats["sent"] += len(notifs)

    db.commit()
    if stats["sent"] or stats["failed"] or stats["blocked"]:
        logger.info("[tele-reminder] gửi xong: %s", stats)
    return stats


def _mark_contact_blocked(db: Session, chat_id: int, now: datetime) -> None:
    """Ghi nhận chat đã chặn bot → lượt quét sau bỏ qua họ (xem `_recipients_for`).

    TẠO hàng nếu chưa có: một chat có thể được CHỈ ĐỊNH bằng ID số mà chưa từng
    /start bot, khi đó không có sẵn hàng liên hệ nào để đánh dấu — mà đây đúng là
    ca cần nhớ nhất (gửi tiếp cũng chỉ nhận 403 mãi).
    """
    contact = db.get(TelegramContact, chat_id)
    if contact is None:
        contact = TelegramContact(chat_id=chat_id, started_at=now, last_seen_at=now)
        db.add(contact)
    if contact.blocked_at is None:
        contact.blocked_at = now
        db.add(contact)


# ── Điểm vào của job nền ──────────────────────────────────────────────────────


def in_send_window(now: datetime) -> bool:
    """True nếu 'bây giờ' đang trong GIỜ gửi (giờ địa phương)."""
    return to_local(now).hour == get_settings().renewal_reminder_hour


def run_tick(db: Session, now: datetime | None = None, *, force_scan: bool = False) -> dict:
    """1 nhịp job nền: quét (chỉ trong khung giờ, hoặc khi `force_scan`) rồi gửi.

    `force_scan=True` dùng cho nút 'Chạy ngay' của super-admin — bỏ qua khung giờ để
    kiểm tra cấu hình tức thì; vẫn chống trùng nên bấm nhiều lần không gây spam.

    Chạy dưới `_TICK_LOCK` để tick nền và nút 'Chạy ngay' không gửi chồng nhau.
    """
    now = now or datetime.now(timezone.utc)
    with _TICK_LOCK:
        scanned = {"scanned": 0, "due": 0, "claimed": 0}
        if force_scan or in_send_window(now):
            scanned = scan_and_claim(db, now)
        sent = flush_pending(db, now)
    return {**scanned, **sent}
