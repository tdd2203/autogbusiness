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

LINK `{link}` (xem `link_text`): link về dashboard CHỈ gửi cho người đăng nhập được —
đại lý đã liên kết Telegram và nhóm admin hệ thống. Khách cuối / người theo dõi không
có tài khoản web nên nhận TRANG GIA HẠN RIÊNG do đại lý đặt (`telegram_templates.
renew_url`, theo từng phạm vi mẫu), hoặc câu "liên hệ người bán để gia hạn" khi đại lý
chưa đặt. Quyết định theo NGƯỜI NHẬN chứ không theo mẫu — nếu không, một mẫu chung có
`{link}` do đại lý soạn sẽ đẩy link đăng nhập thẳng tới khách của họ.

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
    TelegramSubscription,
    TelegramTemplate,
    User,
    Workspace,
)
from app.permissions import Permission
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


def resolve_assignee_chat_id(db: Session, member: Member, *, persist: bool = True) -> int | None:
    """chat_id của người được CHỈ ĐỊNH cho email này, hoặc None nếu chưa sẵn sàng.

    @username chỉ khớp được sau khi người đó bấm /start bot (bảng `telegram_contacts`)
    — đó là ràng buộc của Telegram, không phải lựa chọn thiết kế. Khớp xong thì LƯU
    LẠI vào `notify_telegram_chat_id` để lần sau khỏi tra.

    `persist=False` cho người gọi CHỈ ĐỌC (endpoint GET xem trước mẫu): vẫn khớp
    @username y hệt lúc gửi thật, nhưng không nhét sửa đổi vào session của một request
    không hề commit — sửa đổi đó chỉ chờ autoflush rồi bị rollback lúc đóng session.
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
    if persist:
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


def subscription_covers(sub: TelegramSubscription, member: Member) -> bool:
    """Người nhận này có nhận thông báo của email đó không.

    scope='all' phủ cả email THÊM SAU NÀY (đúng nghĩa 'toàn bộ thông báo của tài
    khoản'); scope='selected' chỉ phủ đúng danh sách đã chọn."""
    if sub.scope != "selected":
        return True
    return str(member.id) in (sub.member_ids or [])


def _recipients_for(
    db: Session,
    member: Member,
    owner: User | None,
    admin_chat_ids: list[int],
    blocked_chats: set[int],
    subscriptions: list[TelegramSubscription],
) -> list[tuple[int, str, UUID | None]]:
    """Danh sách (chat_id, recipient_kind, user_id) sẽ nhận nhắc cho email này.

    `blocked_chats` = những chat đã chặn bot → bỏ qua hẳn, không tạo tin để rồi
    gửi thất bại mỗi mốc. Họ /start lại thì webhook xoá dấu chặn và nhận lại bình thường.

    `subscriptions` = danh sách phát của CHỦ TÀI KHOẢN (người khác được mời qua link).
    Họ nhận SONG SONG với người được chỉ định theo email — đó là hai khái niệm khác
    nhau: chỉ định = khách cuối của đúng email đó; đăng ký = nhân viên/đối tác theo dõi
    giúp chủ tài khoản.
    """
    out: list[tuple[int, str, UUID | None]] = []

    def add(chat_id: int, kind: str, user_id: UUID | None) -> None:
        if chat_id in blocked_chats:
            return
        if any(chat_id == existing for existing, _, _ in out):
            return  # một người trùng nhiều vai → chỉ nhận 1 tin
        out.append((chat_id, kind, user_id))

    assignee_chat = resolve_assignee_chat_id(db, member)
    if assignee_chat and assignee_chat not in blocked_chats:
        add(assignee_chat, "assignee", None)
    # CỐ Ý rơi xuống nhánh đại lý khi người được chỉ định chưa khớp được HOẶC đã chặn
    # bot: thà đại lý nhận rồi tự nhắc khách còn hơn không ai biết email sắp hết hạn.
    elif (
        owner is not None
        and owner.is_active
        and owner.telegram_chat_id
        and owner.telegram_notify_enabled
    ):
        # Chưa chỉ định (hoặc chỉ định chưa khớp được) → đại lý nhận, không mất tin.
        add(owner.telegram_chat_id, "owner", owner.id)

    for sub in subscriptions:
        if subscription_covers(sub, member):
            add(sub.chat_id, "subscriber", sub.user_id)

    if not (owner is not None and owner.is_test):
        for admin_chat in admin_chat_ids:
            add(admin_chat, "admin", None)
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

    # Danh sách phát của từng chủ tài khoản — nạp 1 lần rồi tra theo owner (tránh
    # N+1 khi quét hàng nghìn email).
    subs_by_user: dict[UUID, list[TelegramSubscription]] = {}
    for sub in (
        db.execute(
            select(TelegramSubscription).where(TelegramSubscription.enabled.is_(True))
        )
        .scalars()
        .all()
    ):
        subs_by_user.setdefault(sub.user_id, []).append(sub)

    claimed = 0
    considered = 0
    for member, owner in rows:
        days_left = (member.subscription_end_at - now).total_seconds() / 86400
        bucket = _bucket_for(days_left, buckets)
        if bucket is None:
            continue
        considered += 1
        for chat_id, kind, user_id in _recipients_for(
            db,
            member,
            owner,
            admin_chat_ids,
            blocked_chats,
            subs_by_user.get(owner.id, []) if owner is not None else [],
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


def _dashboard_link() -> str:
    return f"{get_settings().frontend_origin.rstrip('/')}/renewals"


# Chữ thay vào `{link}` khi người nhận KHÔNG đăng nhập được dashboard và đại lý chưa
# đặt trang gia hạn riêng. KHÔNG để trống: mẫu tự soạn thường viết "Gia hạn tại:
# {link}", bỏ trống thì khách đọc được một câu cụt.
SELLER_CONTACT = "liên hệ người bán để gia hạn"


def link_text(kind: str, *, registered: bool, renew_url: str | None) -> str:
    """Giá trị thay vào `{link}` cho MỘT người nhận.

    Link dashboard chỉ có nghĩa với người MỞ ĐƯỢC trang `/renewals`: đại lý do
    super-admin cấp quyền, đã liên kết Telegram — và nhóm admin hệ thống. Gửi nó cho
    khách cuối là đưa họ tới trang đăng nhập mà họ không có tài khoản; gửi cho một tài
    khoản mới tự đăng ký, chưa được cấp quyền, thì cũng chỉ ra màn hình từ chối. Cả hai
    trường hợp nhận TRANG GIA HẠN RIÊNG của đại lý (`telegram_templates.renew_url`),
    hoặc câu chỉ dẫn liên hệ người bán khi đại lý chưa đặt.

    `registered` xét theo CHAT chứ không theo vai: một người vừa là đại lý vừa được mời
    theo dõi tài khoản khác thì vẫn đăng nhập được, link dashboard vẫn đúng với họ.
    """
    if kind == "admin" or registered:
        return _dashboard_link()
    return (renew_url or "").strip() or SELLER_CONTACT


# Biến dùng được trong mẫu tự soạn. Đổi/ thêm ở đây thì SỬA LUÔN bảng hướng dẫn trong
# giao diện (i18n `telegram.tplPlaceholders`) — người dùng chỉ biết qua chỗ đó.
TEMPLATE_PLACEHOLDERS = {
    "body": ("items", "count", "bucket", "link", "owner"),
    "item_line": ("email", "expiry", "days_left", "bucket", "owner", "workspace"),
}


def default_item_line(kind: str = "owner") -> str:
    line = "• <code>{email}</code> — hết hạn {expiry} ({days_left})"
    if kind == "admin":
        line += "\n   chủ: {owner} · {workspace}"
    return line


def default_body(kind: str = "owner") -> str:
    """Mẫu GỐC theo từng loại người nhận — cũng là mẫu hiện ra để người dùng sửa."""
    if kind == "admin":
        return (
            "📋 <b>Tổng hợp sắp hết hạn</b> — còn ≤{bucket} ngày · {count} email\n\n"
            "{items}\n\n"
            "Xử lý tại: {link}"
        )
    if kind == "subscriber":
        return (
            "⏰ <b>Nhắc gia hạn</b> (tài khoản {owner}) — {count} email còn ≤{bucket} ngày\n\n"
            "{items}\n\n"
            "Bạn nhận tin này vì được mời theo dõi thông báo của tài khoản trên."
        )
    if kind == "assignee":
        # `{link}` chứ không phải câu cố định: đại lý đặt trang gia hạn riêng thì khách
        # thấy đúng trang đó; chưa đặt thì `link_text` trả về SELLER_CONTACT nên câu
        # chốt vẫn là lời nhắn liên hệ người bán như trước.
        return (
            "⏰ <b>Tài khoản ChatGPT sắp hết hạn</b> — còn ≤{bucket} ngày\n\n"
            "{items}\n\n"
            "👉 {link}"
        )
    return (
        "⏰ <b>Nhắc gia hạn</b> — {count} email còn ≤{bucket} ngày\n\n"
        "{items}\n\n"
        "Gia hạn tại: {link}"
    )


def render_template(template: str, values: dict[str, object]) -> str:
    """Thay biến `{ten}` bằng giá trị. KHÔNG dùng str.format để dấu `{` `}` người dùng
    gõ lung tung (emoji kaomoji, JSON…) không làm vỡ toàn bộ tin."""
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def unknown_placeholders(template: str, allowed: tuple[str, ...]) -> list[str]:
    """Các biến `{lạ}` trong mẫu — API chặn ngay lúc lưu để người dùng biết mình gõ sai
    thay vì phát hiện khi tin đã gửi thiếu nội dung."""
    import re

    found = re.findall(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", template or "")
    return sorted({name for name in found if name not in allowed})


Tpl = tuple[str | None, str | None, str | None]


class TemplateStore:
    """Mẫu tự soạn (thân tin, dòng email, TRANG GIA HẠN) của các chủ tài khoản liên
    quan, tra theo phạm vi.

    Nạp một lượt rồi tra nhiều lần: một đợt flush có thể dựng hàng chục tin, mà mỗi tin
    lại cần biết "chat này / email này có mẫu riêng không".
    """

    def __init__(self, rows: list[TelegramTemplate]) -> None:
        self._all: dict[UUID, Tpl] = {}
        self._chat: dict[tuple[UUID, int], Tpl] = {}
        self._member: dict[UUID, Tpl] = {}
        for row in rows:
            value = (row.body, row.item_line, row.renew_url)
            if row.scope == "chat" and row.chat_id is not None:
                self._chat[(row.user_id, row.chat_id)] = value
            elif row.scope == "member" and row.member_id is not None:
                self._member[row.member_id] = value
            else:
                self._all[row.user_id] = value

    # Mẫu theo EMAIL chỉ áp cho đúng người mà nó được soạn cho: khách được chỉ định của
    # email đó, hoặc chính đại lý khi email chưa chỉ định ai. Đó đúng là hai vế `if/elif`
    # của `_recipients_for` (chỉ một trong hai nhận tin về một email), cũng là hai giá trị
    # `telegram._template_audience` trả về cho phạm vi 'member'. Người theo dõi KHÔNG nằm
    # trong đó: họ xem giúp cả tài khoản, mẫu nhắm vào khách của một email áp cho họ là
    # sai người — họ đã có mẫu riêng theo người nhận.
    MEMBER_SCOPE_KINDS = frozenset({"assignee", "owner"})

    def pick(
        self, kind: str, owner_ids: set[UUID], chat_id: int, member_ids: list[UUID]
    ) -> Tpl | None:
        """Mẫu áp cho MỘT tin: cụ thể hơn thì thắng — email > người nhận > tất cả.

        Digest của nhóm admin hệ thống KHÔNG bao giờ dùng mẫu tự soạn: đó là bản tổng
        hợp toàn hệ thống, mẫu gốc của nó có thêm dòng `chủ · workspace` để phân biệt
        email của đại lý nào. Chặn theo `kind` chứ không chỉ theo số lượng chủ tài khoản
        — hệ thống ít đại lý thì digest thường chỉ gồm email của MỘT chủ, và khi đó mẫu
        của chủ đó sẽ chiếm luôn tin admin (bảng "Ai nhận tin nào" hứa ngược lại).

        Tin gộp email của NHIỀU chủ tài khoản (người theo dõi nhiều tài khoản) cũng dùng
        mẫu gốc: lấy mẫu của một chủ áp cho email của chủ khác là sai.

        Mẫu theo email chỉ áp khi tin nói về ĐÚNG email đó. Tin gộp nhiều email thì
        không có cách nào áp một thân tin riêng cho từng dòng, nên rơi xuống mẫu của
        người nhận rồi tới mẫu chung.
        """
        if kind == "admin":
            return None
        if len(owner_ids) != 1:
            return None
        owner_id = next(iter(owner_ids))
        if len(member_ids) == 1 and kind in self.MEMBER_SCOPE_KINDS:
            by_member = self._member.get(member_ids[0])
            if by_member is not None:
                return by_member
        return self._chat.get((owner_id, chat_id)) or self._all.get(owner_id)


def _render_message(
    kind: str,
    bucket: int,
    items: list[tuple[Member, str | None, str | None, UUID | None]],
    now: datetime,
    custom: Tpl | None = None,
    *,
    registered: bool = False,
) -> list[str]:
    """Dựng (một hoặc nhiều) tin HTML cho 1 người nhận.

    `items` = (member, tên workspace, username chủ sở hữu, id chủ sở hữu).
    `custom` = (body, item_line, renew_url) tự soạn đã chọn sẵn cho tin này — xem
    `TemplateStore.pick`. Truyền (None, None, url) để buộc dùng mẫu gốc mà GIỮ trang
    gia hạn (đường lui khi mẫu tự soạn hỏng HTML — lỗi ở chữ nghĩa, không phải ở link).
    `{link}` không bao giờ rơi về link dashboard cho khách dù mẫu là gì: `link_text`
    quyết định theo NGƯỜI NHẬN.
    `registered` = chat này thuộc một tài khoản dashboard đang hoạt động.
    """
    esc = telegram.escape_html
    link = link_text(kind, registered=registered, renew_url=custom[2] if custom else None)
    body_tpl = (custom[0] if custom else None) or default_body(kind)
    line_tpl = (custom[1] if custom else None) or default_item_line(kind)

    owners = sorted({owner for _, _, owner, _ in items if owner})
    owner_text = ", ".join(owners) if owners else "chưa có chủ"

    lines: list[str] = []
    for member, workspace_name, owner_username, _ in items:
        end_at = member.subscription_end_at
        lines.append(
            render_template(
                line_tpl,
                {
                    "email": esc(member.email),
                    "expiry": esc(_fmt_dt(end_at)) if end_at else "—",
                    "days_left": esc(_fmt_left(end_at, now)) if end_at else "—",
                    "bucket": bucket,
                    "owner": esc(owner_username or "chưa có chủ"),
                    "workspace": esc(workspace_name or "—"),
                },
            )
        )

    # `{items}` là chỗ bung danh sách — tách thân tin ra header/footer quanh nó để tin
    # dài vẫn cắt được thành nhiều phần mà không mất ngữ cảnh (split_html_lines).
    rendered_body = render_template(
        body_tpl,
        {
            "items": "\x00ITEMS\x00",
            "count": len(items),
            "bucket": bucket,
            "link": esc(link),
            "owner": esc(owner_text),
        },
    )
    if "\x00ITEMS\x00" in rendered_body:
        header, _, footer = rendered_body.partition("\x00ITEMS\x00")
    else:
        # Mẫu quên `{items}` → vẫn phải liệt kê email, nếu không tin thành vô nghĩa.
        header, footer = rendered_body, ""
    return telegram.split_html_lines(header.rstrip("\n"), lines, footer.strip("\n"))


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
    detail: dict[UUID, tuple[Member, str | None, str | None, UUID | None]] = {}
    if member_ids:
        for member, workspace_name, owner_username, owner_id in db.execute(
            select(Member, Workspace.name, User.username, User.id)
            .outerjoin(Workspace, Workspace.id == Member.workspace_id)
            .outerjoin(User, User.id == Member.invited_by_user_id)
            .where(Member.id.in_(member_ids))
        ).all():
            detail[member.id] = (member, workspace_name, owner_username, owner_id)

    # Mẫu tự soạn của các chủ tài khoản liên quan (thường 1–2 hàng).
    owner_ids = {row[3] for row in detail.values() if row[3]}
    templates = TemplateStore(
        list(
            db.execute(select(TelegramTemplate).where(TelegramTemplate.user_id.in_(owner_ids)))
            .scalars()
            .all()
        )
        if owner_ids
        else []
    )

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

    # Chat nào MỞ ĐƯỢC trang gia hạn → chỉ những chat này mới nhận link về web (xem
    # `link_text`). Điều kiện là tài khoản còn hoạt động VÀ có quyền vào trang đó —
    # `/renewals` gác bằng MEMBER_VIEW, nên một tài khoản tự đăng ký chưa được
    # super-admin cấp quyền mà nhận link thì bấm vào chỉ ra màn hình từ chối.
    # Tra theo chat_id chứ không theo vai người nhận: một đại lý được người khác mời
    # theo dõi vẫn là người có tài khoản, link vẫn đúng với họ.
    # Một truy vấn cho cả đợt flush, KHÔNG hỏi theo từng nhóm.
    registered_chats = (
        {
            chat_id
            for chat_id, is_super_admin, perms in db.execute(
                select(User.telegram_chat_id, User.is_super_admin, User.permissions).where(
                    User.telegram_chat_id.in_({chat_id for chat_id, _, _ in groups}),
                    User.is_active.is_(True),
                )
            ).all()
            if is_super_admin or Permission.MEMBER_VIEW.value in (perms or [])
        }
        if groups
        else set()
    )

    for (chat_id, kind, bucket), notifs in groups.items():
        registered = chat_id in registered_chats
        items = [detail[n.member_id] for n in notifs if n.member_id in detail]
        items.sort(key=lambda it: it[0].subscription_end_at or now)
        custom = templates.pick(
            kind,
            {oid for _, _, _, oid in items if oid},
            chat_id,
            [member.id for member, _, _, _ in items],
        )
        messages = _render_message(kind, bucket, items, now, custom, registered=registered)
        try:
            last_message_id = _send_all(chat_id, messages)
        except telegram.TelegramError as exc:
            # HTML hỏng trong MẪU TỰ SOẠN → Telegram từ chối cả tin. Gửi lại bằng MẪU
            # GỐC: lỗi soạn thảo của một người không được phép làm mất thông báo (và
            # người nhận thì chẳng biết đường nào mà sửa).
            if _is_markup_error(exc) and custom:
                try:
                    last_message_id = _send_all(
                        chat_id,
                        # Giữ nguyên trang gia hạn: hỏng là hỏng thân tin, không phải link.
                        _render_message(
                            kind,
                            bucket,
                            items,
                            now,
                            (None, None, custom[2]),
                            registered=registered,
                        ),
                    )
                    logger.warning(
                        "[tele-reminder] mẫu tự soạn lỗi HTML (%s) → đã gửi bằng mẫu gốc",
                        exc.description,
                    )
                    exc = None  # type: ignore[assignment]
                except telegram.TelegramError as fallback_exc:
                    exc = fallback_exc
            if exc is not None:
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
                    "[tele-reminder] gửi tới %s thất bại (%s): %s",
                    chat_id,
                    exc.code,
                    exc.description,
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


def _send_all(chat_id: int, messages: list[str]) -> int:
    """Gửi lần lượt các phần của một tin (đã cắt theo giới hạn 4096 ký tự)."""
    last_message_id = 0
    for text in messages:
        last_message_id = telegram.send_message(chat_id, text).message_id
    return last_message_id


def _is_markup_error(exc: telegram.TelegramError) -> bool:
    """Telegram từ chối vì HTML sai (thẻ không đóng, ký tự < chưa thoát…)."""
    text = (exc.description or "").lower()
    return "can't parse entities" in text or "unsupported start tag" in text


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
