"""Chức năng: MEMBER STATS & LIST (thống kê + liệt kê thành viên).

⚠️ ĐỌC `stats.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoints (query-only):
  - GET /stats  → member_stats
  - GET ""      → list_members
"""

from uuid import UUID

from fastapi import Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.deps import assert_workspace_access, get_session, require_permission
from app.models import Member, User
from app.permissions import Permission
from app.schemas import MemberOut, SubscriptionCycleOut, WorkspaceMemberStats
from app.services import seats

from ._shared import router, _get_workspace_or_404, _visibility_filter


@router.get("/stats", response_model=WorkspaceMemberStats)
def member_stats(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
) -> WorkspaceMemberStats:
    """Thống kê member cho user được gán: tổng số (toàn workspace) + seat + số do
    mình mời. `total/active/pending` KHÔNG lọc theo visibility để user biết tổng
    số người trong workspace; `own_count` là member do user hiện tại mời."""
    ws = _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)

    def _count(*conds) -> int:
        return (
            db.execute(
                select(func.count(Member.id)).where(
                    Member.workspace_id == workspace_id, *conds
                )
            ).scalar_one()
            or 0
        )

    active = _count(Member.status == "active")
    pending = _count(Member.status == "pending")
    own_count = _count(
        Member.status != "removed", Member.invited_by_user_id == user.id
    )
    used = seats.seat_used(db, workspace_id)
    return WorkspaceMemberStats(
        total=active + pending,
        active=active,
        pending=pending,
        seat_total=ws.seat_total,
        # Số suất đang chiếm lấy từ nguồn DÙNG CHUNG `app.services.seats` (đếm lại
        # trong DB, KHÔNG blend với cột `ws.seat_used` scrape được — scrape lệch cả
        # hai chiều, 2026-07-08: "44/35" trong khi thực tế chỉ còn 41). Cùng một
        # hàm với list workspace, `GET /workspaces/seats` và targets trang Mời nên
        # bốn chỗ không thể nói bốn con số khác nhau.
        seat_used=used,
        seat_left=seats.seat_left(ws.seat_total, used),
        own_count=own_count,
    )


@router.get("", response_model=list[MemberOut])
def list_members(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
    include_removed: bool = False,
) -> list[MemberOut]:
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    stmt = (
        select(Member)
        # Kèm chu kỳ gia hạn để modal "Chi tiết thành viên" hiện mục "Kỳ thanh toán"
        # GIỐNG tab "Email đã add" / trang "Gia hạn" (cùng component MemberDetailModal).
        # selectinload gom 1 truy vấn cho MỌI member → tránh N+1 khi workspace đông người.
        # Xem [[multi-cycle-payment-display]].
        .options(selectinload(Member.subscription_cycles))
        .where(Member.workspace_id == workspace_id)
        .order_by(Member.created_at.desc())
    )
    if not include_removed:
        stmt = stmt.where(Member.status != "removed")
    stmt = _visibility_filter(stmt, user)
    # MemberOut.cycles KHÔNG tự map từ Member.subscription_cycles (khác tên) → đổ tay
    # y hệt added_members.list_added_members để hai nơi cùng dữ liệu chu kỳ.
    rows: list[MemberOut] = []
    for member in db.execute(stmt).scalars():
        out = MemberOut.model_validate(member)
        out.cycles = [
            SubscriptionCycleOut.model_validate(c)
            for c in member.subscription_cycles
        ]
        rows.append(out)
    return rows
