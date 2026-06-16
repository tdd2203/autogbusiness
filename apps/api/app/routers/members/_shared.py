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


def _compute_subscription_end(
    start: datetime, months: int | None
) -> datetime | None:
    if months is None or months <= 0:
        return None
    return start + timedelta(days=months * SUBSCRIPTION_DAYS_PER_MONTH)


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
