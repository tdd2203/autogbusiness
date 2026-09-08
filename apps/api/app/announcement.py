"""Luật của ĐỢT THÔNG BÁO ép đọc — phần tính toán thuần, không đụng DB.

Một đợt = một bài hướng dẫn + ngày bắt đầu + số ngày kéo dài. Trong khung ngày đó,
ai vào web cũng bị giữ ở bài đó `lock_seconds` giây rồi mới đóng được, mỗi ngày
đúng một lần (đã đọc ngày nào lưu ở `announcement_views`, theo tài khoản).

Khung ngày tính theo LỊCH GIỜ VN chứ không theo máy người dùng: đợt "5 ngày từ 8/9"
phải kết thúc cùng lúc với mọi người, không phụ thuộc máy ai lệch múi giờ. Ai vào
muộn thì gặp ít lần hơn — đây là khoảng thời gian chung, không phải hạn mức mỗi
người (chốt user 8/9/2026).

Tách khỏi router để test được bằng ngày giả, không cần dựng DB — xem
`tests/test_announcement.py`.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")

DEFAULT_DAYS = 5
DEFAULT_LOCK_SECONDS = 15

# Trần cho giá trị super-admin gõ vào. Không phải để cãi với người dùng mà để một
# lần gõ nhầm (5000 giây, 900 ngày) không khoá cả dashboard tới sang năm.
MAX_DAYS = 60
MAX_LOCK_SECONDS = 120


def vn_day(now: datetime | None = None) -> date:
    """Hôm nay theo giờ Việt Nam."""
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(VN_TZ).date()


def day_key(day: date) -> str:
    """Ngày dạng "2026-09-08" — đúng chuỗi mà web dùng làm khoá 'đã đọc hôm nay'."""
    return day.isoformat()


def clamp_days(raw: int) -> int:
    return max(1, min(MAX_DAYS, int(raw)))


def clamp_lock_seconds(raw: int) -> int:
    return max(0, min(MAX_LOCK_SECONDS, int(raw)))


@dataclass(frozen=True)
class CampaignState:
    """Đợt thông báo nhìn từ MỘT ngày cụ thể."""

    # Hôm nay có ép đọc không. False khi đợt tắt, chưa hẹn ngày, chưa tới ngày,
    # hoặc đã hết khung.
    active: bool
    guide_id: str | None
    lock_seconds: int
    days: int
    start_day: date | None
    # Ngày CUỐI còn ép đọc (đã tính cả ngày này), None khi chưa hẹn ngày.
    end_day: date | None
    # Hôm nay là ngày thứ mấy của đợt (1..days), None khi ngoài khung. Chỉ để hiện
    # cho admin biết đợt chạy tới đâu.
    day_index: int | None
    # Khoá phân biệt đợt: đổi bài hay dời ngày bắt đầu là sang đợt khác, ai đọc đợt
    # cũ vẫn phải đọc đợt mới. None khi chưa đủ dữ liệu để thành một đợt.
    campaign: str | None


def campaign_state(
    *,
    enabled: bool,
    guide_id: str | None,
    start_day: date | None,
    days: int,
    lock_seconds: int,
    today: date,
) -> CampaignState:
    """Đợt đang ở trạng thái nào vào ngày `today`."""
    days = clamp_days(days)
    lock_seconds = clamp_lock_seconds(lock_seconds)
    guide_id = (guide_id or "").strip() or None
    end_day = start_day + timedelta(days=days - 1) if start_day else None
    campaign = f"{guide_id}:{day_key(start_day)}" if guide_id and start_day else None

    index: int | None = None
    if start_day is not None and start_day <= today and end_day is not None and today <= end_day:
        index = (today - start_day).days + 1

    return CampaignState(
        active=bool(enabled and campaign and index is not None),
        guide_id=guide_id,
        lock_seconds=lock_seconds,
        days=days,
        start_day=start_day,
        end_day=end_day,
        day_index=index,
        campaign=campaign,
    )
