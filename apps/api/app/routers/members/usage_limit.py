"""Chức năng: SET USAGE LIMIT (đặt giới hạn tín dụng/tháng hàng loạt + DUYỆT + NGÂN SÁCH).

⚠️ ĐỌC `usage_limit.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Đặt giới hạn tín dụng/tháng cho member trên trang ChatGPT
/admin/billing/manage_member_usage_limit ("Ghi đè mỗi người dùng"). Mỗi member =
1 task SET_USAGE_LIMIT.

Quy tắc nghiệp vụ (2026-06-24):
  - super-admin: tạo task chạy NGAY (approval_status=NULL), không ràng buộc ngân sách.
  - sub-admin: (1) cần quyền MEMBER_SET_USAGE_LIMIT; (2) tổng giới hạn đặt cho member
    của mình KHÔNG vượt `credit_budget` admin cấp cho mình trong workspace đó (mặc
    định 0); (3) MỌI lệnh phải super-admin DUYỆT (approval_status='pending') mới chạy.

Endpoints:
  - GET  /usage-limit-budget     → my_usage_limit_budget   (caller's ngân sách)
  - POST /bulk-set-usage-limit   → bulk_set_usage_limit
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    get_session,
    require_permission,
)
from app.models import Member, QueueItem, User, WorkspaceAssignment
from app.permissions import Permission
from app.sse import publish_task_event
from app.schemas import MemberBulkSetUsageLimitIn, MemberUsageLimitBudgetOut

from ._shared import router, _get_workspace_or_404, _visibility_filter


def _credit_budget(db: Session, workspace_id: UUID, user_id: UUID) -> int:
    """Ngân sách tín dụng admin cấp cho sub-admin này trong workspace này (0 nếu chưa cấp)."""
    row = db.execute(
        select(WorkspaceAssignment.credit_budget).where(
            WorkspaceAssignment.workspace_id == workspace_id,
            WorkspaceAssignment.user_id == user_id,
        )
    ).scalar_one_or_none()
    return int(row or 0)


def _committed_credits(
    db: Session,
    workspace_id: UUID,
    user: User,
    overrides: dict[UUID, int] | None = None,
) -> int:
    """Tổng tín dụng sub-admin đã CAM KẾT cho member của mình trong workspace.

    Với mỗi member active mình quản (visibility):
      - nếu có trong `overrides` (giá trị của lệnh đang xét) → dùng override
      - elif đang có yêu cầu SET_USAGE_LIMIT 'pending' (chờ duyệt) → dùng giá trị đó
      - else → usage_limit_credits hiện tại (NULL = 0)
    Đếm cả 'pending' để sub-admin không lách bằng nhiều lệnh nhỏ vượt tổng ngân sách.
    """
    overrides = overrides or {}

    # Member active sub-admin quản trong ws.
    stmt = select(Member).where(
        Member.workspace_id == workspace_id,
        Member.status == "active",
    )
    stmt = _visibility_filter(stmt, user)
    members = list(db.execute(stmt).scalars())

    # Yêu cầu đang chờ duyệt của chính sub-admin trong ws → {member_id: limit_credits}.
    pending_rows = db.execute(
        select(QueueItem).where(
            QueueItem.workspace_id == workspace_id,
            QueueItem.type == "SET_USAGE_LIMIT",
            QueueItem.approval_status == "pending",
            QueueItem.created_by_id == user.id,
        )
    ).scalars()
    pending_by_member: dict[UUID, int] = {}
    for it in pending_rows:
        p = it.payload or {}
        mid = p.get("member_id")
        lc = p.get("limit_credits")
        if mid and lc is not None:
            try:
                pending_by_member[UUID(str(mid))] = int(lc)
            except (ValueError, TypeError):
                continue

    total = 0
    for m in members:
        if m.id in overrides:
            total += overrides[m.id]
        elif m.id in pending_by_member:
            total += pending_by_member[m.id]
        else:
            total += m.usage_limit_credits or 0
    return total


@router.get("/usage-limit-budget", response_model=MemberUsageLimitBudgetOut)
def my_usage_limit_budget(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_VIEW)),
) -> MemberUsageLimitBudgetOut:
    """Ngân sách tín dụng của caller trong workspace (modal đặt giới hạn hiển thị)."""
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    if user.is_super_admin:
        return MemberUsageLimitBudgetOut(unlimited=True)
    budget = _credit_budget(db, workspace_id, user.id)
    used = _committed_credits(db, workspace_id, user)
    return MemberUsageLimitBudgetOut(
        unlimited=False,
        budget=budget,
        used=used,
        remaining=max(0, budget - used),
    )


@router.post("/bulk-set-usage-limit", status_code=status.HTTP_202_ACCEPTED)
def bulk_set_usage_limit(
    workspace_id: UUID,
    body: MemberBulkSetUsageLimitIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_SET_USAGE_LIMIT)),
) -> dict:
    """Đặt giới hạn tín dụng/tháng hàng loạt → 1 SET_USAGE_LIMIT task / member.

    super-admin: task chạy ngay. sub-admin: task ở trạng thái chờ duyệt
    (approval_status='pending') + tổng giới hạn không vượt ngân sách được cấp.
    """
    _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)

    # desired[email_lower] = mức RIÊNG cho email đó (chế độ items).
    desired: dict[str, int] = {}
    for it in body.items:
        e = it.email.strip().lower()
        if e:
            desired[e] = it.limit_credits

    emails_lower = {e.strip().lower() for e in body.emails if e.strip()}

    if body.limit_credits is None and not desired:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cần limit_credits (mức chung) hoặc items (mức riêng) để đặt giới hạn",
        )

    all_emails = emails_lower | set(desired.keys())

    conds = []
    if body.member_ids:
        conds.append(Member.id.in_(body.member_ids))
    if all_emails:
        conds.append(func.lower(Member.email).in_(all_emails))
    if not conds:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cần ít nhất 1 member_id hoặc email để đặt giới hạn",
        )

    stmt = select(Member).where(
        Member.workspace_id == workspace_id,
        Member.status == "active",
        or_(*conds),
    )
    stmt = _visibility_filter(stmt, user)
    targets = {m.id: m for m in db.execute(stmt).scalars()}

    # Tính target từng member (mức riêng ưu tiên mức chung). None = không có mục tiêu.
    member_targets: dict[UUID, int] = {}
    no_target: list[str] = []
    for member in targets.values():
        target = desired.get(member.email.lower(), body.limit_credits)
        if target is None:
            no_target.append(member.email)
            continue
        member_targets[member.id] = target

    needs_approval = not user.is_super_admin

    # NGÂN SÁCH (chỉ sub-admin): tổng cam kết sau lệnh này không vượt ngân sách.
    if needs_approval:
        budget = _credit_budget(db, workspace_id, user.id)
        committed = _committed_credits(
            db, workspace_id, user, overrides=member_targets
        )
        if committed > budget:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Vượt ngân sách: tổng giới hạn sau lệnh = {committed} tín dụng, "
                    f"ngân sách được cấp = {budget}. Giảm bớt hoặc xin admin tăng ngân sách."
                ),
            )

    enqueued: list[str] = []
    already: list[str] = []
    for member in targets.values():
        target = member_targets.get(member.id)
        if target is None:
            continue
        # Bỏ qua member đã đúng mức rồi (chỉ khi không cần duyệt — nếu sub-admin đặt
        # đúng mức cũ thì cũng coi như no-op, không tạo task chờ duyệt thừa).
        if member.usage_limit_credits == target:
            already.append(member.email)
            continue
        queue_item = QueueItem(
            type="SET_USAGE_LIMIT",
            status="PENDING",
            approval_status="pending" if needs_approval else None,
            workspace_id=workspace_id,
            payload={
                "member_id": str(member.id),
                "email": member.email,
                "limit_credits": target,
                "old_limit_credits": member.usage_limit_credits,
            },
            created_by_id=user.id,
        )
        db.add(queue_item)
        db.flush()
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action=(
                "MEMBER_USAGE_LIMIT_REQUESTED"
                if needs_approval
                else "MEMBER_BULK_SET_USAGE_LIMIT_QUEUED"
            ),
            result="PENDING",
            target_type="MEMBER",
            target_id=str(member.id),
            data={
                "workspace_id": str(workspace_id),
                "email": member.email,
                "old_limit_credits": member.usage_limit_credits,
                "limit_credits": target,
                "queue_item_id": str(queue_item.id),
                "needs_approval": needs_approval,
            },
            commit=False,
        )
        enqueued.append(member.email)

    if enqueued:
        db.commit()
        # Chỉ task KHÔNG cần duyệt mới sẵn sàng cho extension; task chờ duyệt thì
        # extension không pick (pick_next lọc approval_status), publish để super-admin
        # thấy "có yêu cầu chờ duyệt" trên dashboard.
        for email in enqueued:
            publish_task_event(
                workspace_id,
                {
                    "type": "task-available" if not needs_approval else "approval-pending",
                    "task_type": "SET_USAGE_LIMIT",
                    "email": email,
                },
            )

    matched_lower = {m.email.lower() for m in targets.values()}
    skipped = sorted(all_emails - matched_lower)
    return {
        "workspace_id": str(workspace_id),
        "count": len(enqueued),
        "emails": enqueued,
        "already": already,
        "no_target": no_target,
        "skipped": skipped,
        "pending_approval": needs_approval and len(enqueued) > 0,
    }
