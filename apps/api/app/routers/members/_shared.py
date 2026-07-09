"""Shared router + helpers cho package `members`.

Mọi sub-module (core.py, remove.py, ...) import `router` và các helper từ đây để
đăng ký endpoint lên CÙNG một APIRouter
(prefix `/api/v1/workspaces/{workspace_id}/members`).

Đây KHÔNG phải nơi chứa business logic của 1 chức năng cụ thể — chỉ những thứ
dùng chung giữa nhiều chức năng (lookup workspace, visibility filter). Mỗi chức
năng có module + file docs (.md) riêng.
"""

from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.models import Member, User, Workspace

router = APIRouter(
    prefix="/api/v1/workspaces/{workspace_id}/members", tags=["members"]
)

# Subscription tracking: 1 tháng = 30 ngày cứng (theo spec user). Đặt const để
# tránh magic number rải rác. ChatGPT bill day 11 của tháng → admin set
# subscription_months cho từng member, end_at = created_at + months × 30 days.
SUBSCRIPTION_DAYS_PER_MONTH = 30

# Ân hạn sau khi hết hạn: chỉ tự xoá email khi đã quá hạn >= 1 GIỜ mà không gia hạn
# (theo yêu cầu user). Dùng CHUNG cho cả endpoint `cleanup-expired` (remove.py) lẫn
# scheduler nền (main.py) để 2 nơi luôn cùng rule — xem remove.md §4.
SUBSCRIPTION_GRACE_AFTER_EXPIRY = timedelta(hours=1)


def _end_from_purchase(
    purchased_at: datetime, months: int | None
) -> datetime | None:
    """Hạn = MỐC NEO (ngày gia hạn / ngày add đầu tiên / ngày mua) + months×30 ngày
    CHÍNH XÁC (giữ nguyên giờ tới giây, KHÔNG chốt cuối ngày, KHÔNG dư dù 1 giây).

    Quy tắc DUY NHẤT cho hạn dùng (yêu cầu user 2026-07-06):
    **Ngày hết hạn = Ngày gia hạn + 30×tháng**. Ngày gia hạn (mốc neo) lưu ở
    `subscription_purchased_at`; INVITE set = giờ gửi lệnh mời (chính xác tới giây),
    SYNC lần đầu set = giờ ghi nhận, modal Đổi hạn set = ngày mua admin nhập.

    Ví dụ neo 5/7 10:15:38, gói 1 tháng → 4/8 10:15:38 (đúng 30 ngày). Dùng CHUNG
    cho invite / reconcile / subscription — không còn nhánh chốt-cuối-ngày (bỏ mô
    hình `-1` ngày cũ vốn cho ra 3/8 23:59:59)."""
    if months is None or months <= 0:
        return None
    return purchased_at + timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)


def _extend_subscription_end(
    current_end: datetime, months: int | None
) -> datetime | None:
    """GIA HẠN: cộng tiếp từ hạn hiện tại (đã là mốc cuối ngày 23:59:59) → cộng
    ĐÚNG months×30 ngày, KHÔNG chốt lại (giữ nguyên 23:59:59). Không dư ngày.

    Ví dụ current_end=3/8 23:59:59, gia hạn 1 tháng → 2/9 23:59:59 (thêm đúng 30 ngày).
    """
    if months is None or months <= 0:
        return None
    return current_end + timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)


def _get_workspace_or_404(db: Session, workspace_id: UUID) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if not ws:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace không tồn tại"
        )
    return ws


def _visibility_filter(stmt: Select, user: User) -> Select:
    """Sub-admin chỉ thấy member họ invite. Super-admin thấy tất cả."""
    if user.is_super_admin:
        return stmt
    return stmt.where(Member.invited_by_user_id == user.id)


def _member_or_404_visible(
    db: Session, workspace_id: UUID, member_id: UUID, user: User
) -> Member:
    stmt = select(Member).where(
        Member.id == member_id, Member.workspace_id == workspace_id
    )
    stmt = _visibility_filter(stmt, user)
    member = db.execute(stmt).scalar_one_or_none()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member không tồn tại hoặc bạn không có quyền truy cập",
        )
    return member
