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
    return WorkspaceMemberStats(
        total=active + pending,
        active=active,
        pending=pending,
        seat_total=ws.seat_total,
        # Dùng THẲNG số member active+pending thật trong DB — KHÔNG blend với
        # `ws.seat_used` (scrape từ trang billing ChatGPT, chỉ cập nhật khi chạy
        # SYNC_BILLING) vì scrape có thể lệch CẢ HAI CHIỀU: cũ/THẤP hơn (vừa mời
        # thêm, chưa kịp sync) hoặc cũ/CAO hơn (vừa xoá bớt, chưa kịp sync). DB
        # luôn là nguồn thật thời gian thực — max() trước đây chỉ chặn chiều thấp,
        # bỏ sót chiều cao (2026-07-08: "44/35" trong khi thực tế chỉ còn 41 active
        # sau khi xoá 3 người, do seat_used scrape cũ chưa refresh). Đồng bộ với
        # `effective_used` (invite.py) + `_apply_effective_seat_used` (crud.py).
        seat_used=active + pending,
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
