"""Chức năng: THÔNG BÁO HỆ THỐNG ép đọc — đợt bắt mọi người xem một bài hướng dẫn.

  - GET  /api/v1/announcement        → hôm nay có phải đọc gì không (mọi user)
  - POST /api/v1/announcement/seen   → đã ngồi đủ số giây, ghi nhận cho hôm nay
  - GET  /api/v1/admin/announcement  → cấu hình đợt + đã bao nhiêu người đọc
  - PUT  /api/v1/admin/announcement  → lưu cấu hình (chỉ super-admin)

Cấu hình nằm ở DB (`announcement_settings`, singleton id=1) chứ không phải hằng số
trong code: đợt thông báo là chuyện của tuần này, sửa code + deploy cho mỗi lần
muốn nhắc một chuyện thì thực tế không ai làm.

Backend KHÔNG biết bài hướng dẫn gồm những gì — danh sách bài nằm trong bundle web
(`apps/web/src/lib/guides`). Ở đây chỉ giữ ID bài, ngày chạy và số giây giữ popup.

Luật khung ngày ở `app/announcement.py` (hàm thuần, test không cần DB).
"""

from datetime import date, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.announcement import (
    DEFAULT_DAYS,
    DEFAULT_LOCK_SECONDS,
    MAX_DAYS,
    MAX_LOCK_SECONDS,
    CampaignState,
    campaign_state,
    day_key,
    vn_day,
)
from app.audit import log_event
from app.deps import get_current_user, get_session, require_super_admin
from app.models import AnnouncementSettings, AnnouncementView, User

router = APIRouter(prefix="/api/v1", tags=["announcement"])


class AnnouncementOut(BaseModel):
    """Thứ web cần để quyết định có ép đọc lượt này không."""

    active: bool
    guide_id: str | None = None
    lock_seconds: int = DEFAULT_LOCK_SECONDS
    # Ngày (giờ VN) theo ĐỒNG HỒ SERVER. Web bám ngày này chứ không tự tính từ máy
    # người dùng: máy lệch múi giờ mà tự tính thì "hôm nay" của họ lệch một ngày so
    # với khung đợt, thành ra bị ép thêm hoặc thoát sớm một ngày.
    day: str
    seen_today: bool = False
    campaign: str | None = None


class AnnouncementAdminOut(AnnouncementOut):
    enabled: bool = False
    start_day: date | None = None
    end_day: date | None = None
    days: int = DEFAULT_DAYS
    # Hôm nay là ngày thứ mấy của đợt (1..days); None khi đợt chưa chạy hoặc đã hết.
    day_index: int | None = None
    max_days: int = MAX_DAYS
    max_lock_seconds: int = MAX_LOCK_SECONDS
    # Bao nhiêu tài khoản đã đọc xong trong đợt này: hôm nay / cả đợt.
    seen_today_count: int = 0
    seen_total_count: int = 0
    updated_at: datetime | None = None
    updated_by: str | None = None


class AnnouncementIn(BaseModel):
    enabled: bool = False
    guide_id: str | None = None
    # Bỏ trống + bật đợt ⇒ chạy từ HÔM NAY (xem `save_announcement`).
    start_day: date | None = None
    days: int = Field(default=DEFAULT_DAYS)
    lock_seconds: int = Field(default=DEFAULT_LOCK_SECONDS)


def _row(db: Session) -> AnnouncementSettings | None:
    return db.get(AnnouncementSettings, 1)


def _state(row: AnnouncementSettings | None, today: date) -> CampaignState:
    if row is None:
        return campaign_state(
            enabled=False,
            guide_id=None,
            start_day=None,
            days=DEFAULT_DAYS,
            lock_seconds=DEFAULT_LOCK_SECONDS,
            today=today,
        )
    return campaign_state(
        enabled=bool(row.enabled),
        guide_id=row.guide_id,
        start_day=row.start_day,
        days=row.days,
        lock_seconds=row.lock_seconds,
        today=today,
    )


def _seen_today(db: Session, user_id, campaign: str | None, day: str) -> bool:
    if not campaign:
        return False
    found = db.execute(
        select(AnnouncementView.id).where(
            AnnouncementView.user_id == user_id,
            AnnouncementView.campaign == campaign,
            AnnouncementView.day == day,
        )
    ).first()
    return found is not None


@router.get("/announcement", response_model=AnnouncementOut)
def get_announcement(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AnnouncementOut:
    """Hôm nay người này có bị ép đọc gì không.

    Trả `active=False` là tuyệt đại đa số ngày — web gọi mỗi lần vào, nên câu này
    phải nhẹ: một lần đọc bảng cấu hình, và chỉ khi có đợt mới hỏi thêm bảng lượt
    đọc.
    """
    today = vn_day()
    state = _state(_row(db), today)
    day = day_key(today)
    return AnnouncementOut(
        active=state.active,
        guide_id=state.guide_id if state.active else None,
        lock_seconds=state.lock_seconds,
        day=day,
        seen_today=_seen_today(db, user.id, state.campaign, day) if state.active else False,
        campaign=state.campaign if state.active else None,
    )


@router.post("/announcement/seen", response_model=AnnouncementOut)
def mark_announcement_seen(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AnnouncementOut:
    """Ghi nhận người này đã đọc xong thông báo của HÔM NAY.

    Web gọi khi đồng hồ giữ popup chạy hết, không phải lúc mở popup: mở ra rồi F5
    ngay thì chưa tính, mở lại vẫn bị giữ — đó mới là "ép đọc".

    Đợt không chạy thì không ghi gì, chỉ trả về trạng thái. Gọi lại nhiều lần vô
    hại (khoá duy nhất user+đợt+ngày, đụng thì bỏ qua).
    """
    today = vn_day()
    state = _state(_row(db), today)
    day = day_key(today)
    if state.active and state.campaign:
        db.execute(
            pg_insert(AnnouncementView)
            .values(user_id=user.id, campaign=state.campaign, day=day)
            .on_conflict_do_nothing(constraint="uq_announcement_view_day")
        )
        db.commit()
    return AnnouncementOut(
        active=state.active,
        guide_id=state.guide_id if state.active else None,
        lock_seconds=state.lock_seconds,
        day=day,
        seen_today=state.active,
        campaign=state.campaign if state.active else None,
    )


def _render_admin(db: Session, viewer: User) -> AnnouncementAdminOut:
    today = vn_day()
    row = _row(db)
    state = _state(row, today)
    day = day_key(today)

    seen_today_count = 0
    seen_total_count = 0
    if state.campaign:
        seen_total_count = int(
            db.execute(
                select(func.count())
                .select_from(AnnouncementView)
                .where(AnnouncementView.campaign == state.campaign)
            ).scalar_one()
        )
        seen_today_count = int(
            db.execute(
                select(func.count())
                .select_from(AnnouncementView)
                .where(
                    AnnouncementView.campaign == state.campaign,
                    AnnouncementView.day == day,
                )
            ).scalar_one()
        )

    updated_by = None
    if row is not None and row.updated_by_id is not None:
        editor = db.get(User, row.updated_by_id)
        updated_by = editor.email if editor else None

    return AnnouncementAdminOut(
        active=state.active,
        # Khác endpoint của user: admin phải thấy bài đã chọn KỂ CẢ khi đợt đang
        # tắt hay chưa tới ngày, bằng không mở bảng cài đặt ra thấy trống trơn.
        guide_id=state.guide_id,
        lock_seconds=state.lock_seconds,
        day=day,
        # Của CHÍNH người đang mở bảng — admin cũng là một người đọc như mọi người.
        seen_today=_seen_today(db, viewer.id, state.campaign, day),
        campaign=state.campaign,
        enabled=bool(row.enabled) if row is not None else False,
        start_day=state.start_day,
        end_day=state.end_day,
        days=state.days,
        day_index=state.day_index,
        seen_today_count=seen_today_count,
        seen_total_count=seen_total_count,
        updated_at=row.updated_at if row is not None else None,
        updated_by=updated_by,
    )


@router.get("/admin/announcement", response_model=AnnouncementAdminOut)
def get_announcement_settings(
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> AnnouncementAdminOut:
    return _render_admin(db, user)


@router.put("/admin/announcement", response_model=AnnouncementAdminOut)
def save_announcement_settings(
    body: AnnouncementIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_super_admin),
) -> AnnouncementAdminOut:
    """Lưu cấu hình đợt. Hiệu lực NGAY cho lượt vào web tiếp theo của mọi người.

    Bật đợt mà bỏ trống ngày bắt đầu thì hiểu là "chạy từ hôm nay" — người bật
    đang muốn thông báo bây giờ, bắt họ gõ lại ngày hôm nay là thừa một bước dễ gõ
    nhầm.
    """
    today = vn_day()
    row = _row(db)
    before = (
        None
        if row is None
        else {
            "enabled": bool(row.enabled),
            "guide_id": row.guide_id,
            "start_day": row.start_day.isoformat() if row.start_day else None,
            "days": row.days,
            "lock_seconds": row.lock_seconds,
        }
    )
    if row is None:
        row = AnnouncementSettings(id=1)
        db.add(row)

    guide_id = (body.guide_id or "").strip() or None
    start_day = body.start_day
    if body.enabled and start_day is None:
        start_day = today

    # Kẹp về khoảng cho phép ngay ở backend: giao diện đã chặn nhưng backend không
    # được tin giao diện (cùng lý do như hạn mức thao tác).
    state = campaign_state(
        enabled=body.enabled,
        guide_id=guide_id,
        start_day=start_day,
        days=body.days,
        lock_seconds=body.lock_seconds,
        today=today,
    )

    row.enabled = body.enabled
    row.guide_id = guide_id
    row.start_day = start_day
    row.days = state.days
    row.lock_seconds = state.lock_seconds
    row.updated_by_id = user.id
    db.flush()

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=user.id,
        actor_label=user.email,
        action="ANNOUNCEMENT_SETTINGS_UPDATED",
        target_type="SETTINGS",
        target_id="announcement",
        data={
            "enabled": row.enabled,
            "guide_id": row.guide_id,
            "start_day": row.start_day.isoformat() if row.start_day else None,
            "days": row.days,
            "lock_seconds": row.lock_seconds,
            "before": before,
        },
        commit=False,
    )
    db.commit()
    return _render_admin(db, user)
