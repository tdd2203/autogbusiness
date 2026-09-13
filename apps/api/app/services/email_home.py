"""KHÔNG GIAN CŨ CỦA EMAIL: email từng dùng không gian nào thì mời lại vào đúng đó.

Chốt user 13/9/2026, ca `cmsgpshp`: khách cũ của CHATGPT PRO bị mời vào GPT1. Từ 12/9
trang Mời dồn cả mẻ email vào MỘT không gian chọn sẵn, và chỉ email đang ngồi (active/
pending) mới được giữ ở chỗ cũ — email đã rời đội thì đi theo đích chung. Đại lý đó
chỉ được gán GPT1 nên khách rơi thẳng vào GPT1: trả 354.700đ cho 28 ngày theo mốc chốt
của GPT1, trong khi về đúng CHATGPT PRO chỉ là 147.100đ tới mốc chốt ở đó.

File này là chỗ DUY NHẤT trả lời "email này thuộc không gian nào", dùng chung cho:
  * `/auto-invite/email-history` → trang Mời ghim email về đúng chỗ (`home_workspace_id`);
  * `assert_invite_into_home` ở mọi cửa tạo lời mời → client cũ, lịch sử chưa kịp tải
    xong lúc bấm Mời, hay một cửa nào sau này quên ghim đều không lọt được.
Hai bên đọc cùng một hàm nên trang không bao giờ ghim một chỗ mà backend lại chặn.

THỨ TỰ ƯU TIÊN khi email có mặt ở nhiều nơi: đang ngồi > đang giữ hạn > dùng lâu nhất
> rời đi gần nhất. Chỉ xét những nơi người mời MỜI VÀO ĐƯỢC: bản ghi do chính họ mời
(được mời lại dù không còn được gán, xem `_assert_invite_workspace_access`) hoặc không
gian họ được gán. Chỗ cũ nằm ngoài tầm với thì không ghim — ghim vào là trang gửi lệnh
vào một nơi backend trả 404, email không vào được đâu cả.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.deps import user_can_access_workspace
from app.models import Member, User, Workspace

# ── THAM SỐ CỦA LUẬT — đổi ở đây, logic và câu từ chối tự đọc theo ────────────────

#: Bật luật "email cũ mời lại vào đúng không gian cũ" ở các cửa tạo lời mời. Tắt thì
#: lịch sử vẫn trả `home_workspace_id` cho trang Mời, chỉ bỏ chốt chặn ở backend.
HOME_LOCK_ENABLED = True

#: Super-admin được mời email sang không gian khác chỗ cũ (chủ động dời khách, chữa
#: một lần mời nhầm). Đại lý thì không.
SUPER_ADMIN_EXEMPT = True

#: Bản ghi KHÔNG có hạn sử dụng chỉ được coi là "đã từng dùng" khi ở lại từ ngần này
#: ngày (user 2026-07-19: "đã sử dụng tối thiểu 30 ngày"). Bản ghi có hạn, hay đang
#: ngồi, thì luôn tính.
MIN_USAGE_DAYS_FOR_HISTORY = 30

_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


def _as_utc(value: datetime | None) -> datetime | None:
    """Mốc thời gian về UTC có tzinfo. Dữ liệu cũ trong DB có dòng naive, trừ thẳng
    hai kiểu khác nhau là TypeError giữa lúc đang dán email."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class Place:
    """Một không gian mà email từng có mặt (mỗi cặp email + không gian một bản ghi)."""

    workspace_id: str
    name: str
    #: `joined_at` → `removed_at` (hoặc bây giờ). None = chưa từng vào lần nào.
    usage_days: int | None
    #: Hạn còn ở tương lai: tiền của email đang nằm ở đây, kể cả bản ghi đã `removed`.
    holds_subscription: bool
    #: Đang `active`/`pending` ở đây: chỗ DUY NHẤT mời lại được
    #: (`_assert_single_workspace`).
    holds_seat: bool
    #: Bản ghi do chính người đang mời mời vào.
    owned: bool
    #: Lần cuối email còn ở đây — chỉ để hai nơi ngang nhau không đổi thứ tự giữa hai
    #: lần hỏi (trang ghim theo lần hỏi trước, backend chặn theo lần hỏi sau).
    last_seen: datetime

    def rank(self) -> tuple:
        return (
            1 if self.holds_seat else 0,
            1 if self.holds_subscription else 0,
            self.usage_days or 0,
            self.last_seen,
            self.workspace_id,
        )

    def as_dict(self) -> dict:
        return {
            "workspace_id": self.workspace_id,
            "name": self.name,
            "usage_days": self.usage_days,
            "holds_subscription": self.holds_subscription,
            "holds_seat": self.holds_seat,
        }


def email_places(
    db: Session,
    user: User,
    emails: list[str],
    platform: str,
    *,
    now: datetime | None = None,
) -> dict[str, list[Place]]:
    """Các không gian mỗi email từng có mặt, xếp theo thứ tự ưu tiên (đầu = mạnh nhất).

    Người mời thấy: bản ghi CỦA CHÍNH MÌNH (còn hay hết hạn), và bản ghi ĐÃ HẾT HẠN
    của bất kỳ ai (email cũ, chủ cũ không còn giữ được lâu). Email còn hạn của đại lý
    khác thì không lộ ra ([[invite-owner-lock]]).

    Chỉ trong CÙNG NHÁNH: email từng dùng workspace ChatGPT không kéo lệnh mời Canva về
    workspace đó."""
    wanted = {e.strip().lower() for e in emails if e and e.strip()}
    if not wanted:
        return {}
    now = datetime.now(timezone.utc) if now is None else now
    rows = db.execute(
        select(
            func.lower(Member.email).label("email"),
            Member.workspace_id,
            Workspace.name,
            Member.joined_at,
            Member.removed_at,
            Member.subscription_end_at,
            Member.status,
            Member.invited_by_user_id,
        )
        .join(Workspace, Workspace.id == Member.workspace_id)
        .where(
            func.lower(Member.email).in_(wanted),
            Workspace.platform == platform,
            or_(
                Member.invited_by_user_id == user.id,
                and_(
                    Member.subscription_end_at.isnot(None),
                    Member.subscription_end_at <= now,
                ),
            ),
        )
    ).all()

    by_email: dict[str, dict[str, Place]] = {}
    for r in rows:
        joined = _as_utc(r.joined_at)
        removed = _as_utc(r.removed_at)
        end_at = _as_utc(r.subscription_end_at)
        usage_days = None if joined is None else max(0, ((removed or now) - joined).days)
        holds_seat = r.status in ("active", "pending")
        # Ngưỡng 30 ngày chỉ áp cho bản ghi KHÔNG có hạn và email đã rời đi. Bản ghi có
        # hạn là chỗ tiền của email đang nằm (còn hạn) hoặc từng nằm (hết hạn) — mời
        # lại phải trỏ về đúng đó dù dùng ngắn hay chưa vào lần nào.
        if (
            not holds_seat
            and end_at is None
            and (usage_days is None or usage_days < MIN_USAGE_DAYS_FOR_HISTORY)
        ):
            continue
        place = Place(
            workspace_id=str(r.workspace_id),
            name=r.name,
            usage_days=usage_days,
            holds_subscription=end_at is not None and end_at > now,
            holds_seat=holds_seat,
            owned=r.invited_by_user_id == user.id,
            last_seen=now if holds_seat else (removed or joined or _EPOCH),
        )
        # Mỗi cặp (email, không gian) chỉ có 1 bản ghi; `prev` chỉ để phòng dữ liệu cũ
        # lẫn hoa/thường trong cột email.
        bucket = by_email.setdefault(r.email, {})
        prev = bucket.get(place.workspace_id)
        if prev is None or place.rank() > prev.rank():
            bucket[place.workspace_id] = place

    return {
        email: sorted(bucket.values(), key=Place.rank, reverse=True)
        for email, bucket in by_email.items()
        if bucket
    }


def pick_home(
    db: Session,
    user: User,
    ranked: list[Place],
    access_cache: dict[str, bool] | None = None,
) -> Place | None:
    """Không gian cũ của email: nơi mạnh nhất trong số người mời MỜI VÀO ĐƯỢC."""
    cache = {} if access_cache is None else access_cache
    for place in ranked:
        if place.owned:
            return place
        if place.workspace_id not in cache:
            cache[place.workspace_id] = user_can_access_workspace(
                db, user, UUID(place.workspace_id)
            )
        if cache[place.workspace_id]:
            return place
    return None


def assert_invite_into_home(
    db: Session, user: User, emails: list[str], workspace: Workspace
) -> None:
    """Chặn mời email vào không gian KHÁC chỗ cũ của nó. 409, cả lô không ai được mời.

    Email chưa từng có mặt ở đâu (hoặc chỗ cũ nằm ngoài tầm với) thì không bị chặn —
    đích do người mời chọn."""
    if not HOME_LOCK_ENABLED or not emails:
        return
    if SUPER_ADMIN_EXEMPT and user.is_super_admin:
        return
    places = email_places(db, user, emails, workspace.platform)
    target = str(workspace.id)
    cache: dict[str, bool] = {}
    for email in emails:
        ranked = places.get(email.strip().lower())
        if not ranked:
            continue
        home = pick_home(db, user, ranked, cache)
        if home is not None and home.workspace_id != target:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Email {email} từng dùng ở không gian {home.name} — chỉ mời lại "
                    f"được vào đúng không gian đó."
                ),
            )
