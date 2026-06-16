"""Chức năng: WORKSPACE ASSIGNMENT (gán / gỡ quyền sở hữu workspace cho sub-admin).

⚠️ ĐỌC `assignment.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET    /{workspace_id}/assignments            → list_workspace_assignments
  - POST   /{workspace_id}/assignments            → assign_user_to_workspace
  - DELETE /{workspace_id}/assignments/{user_id}  → unassign_user_from_workspace
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_super_admin
from app.models import User, WorkspaceAssignment
from app.schemas import WorkspaceAssignmentCreate, WorkspaceAssignmentOut

from ._shared import router, _get_workspace_or_404


@router.get("/{workspace_id}/assignments", response_model=list[WorkspaceAssignmentOut])
def list_workspace_assignments(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> list[WorkspaceAssignmentOut]:
    """Danh sách sub-admin được gán workspace này (super-admin only)."""
    _get_workspace_or_404(db, workspace_id)
    rows = db.execute(
        select(WorkspaceAssignment, User)
        .join(User, User.id == WorkspaceAssignment.user_id)
        .where(WorkspaceAssignment.workspace_id == workspace_id)
        .order_by(WorkspaceAssignment.created_at.desc())
    ).all()
    return [
        WorkspaceAssignmentOut(
            user_id=u.id,
            email=u.email,
            username=u.username,
            is_active=u.is_active,
            created_at=a.created_at,
        )
        for a, u in rows
    ]


@router.post(
    "/{workspace_id}/assignments",
    response_model=WorkspaceAssignmentOut,
    status_code=status.HTTP_201_CREATED,
)
def assign_user_to_workspace(
    workspace_id: UUID,
    body: WorkspaceAssignmentCreate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> WorkspaceAssignmentOut:
    """Gán quyền sở hữu workspace cho 1 sub-admin (idempotent). Super-admin only."""
    _get_workspace_or_404(db, workspace_id)
    target = db.get(User, body.user_id)
    if not target:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User không tồn tại"
        )
    if target.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Super-admin đã có quyền mọi workspace, không cần gán",
        )

    existing = db.execute(
        select(WorkspaceAssignment).where(
            WorkspaceAssignment.workspace_id == workspace_id,
            WorkspaceAssignment.user_id == target.id,
        )
    ).scalar_one_or_none()
    if existing:
        return WorkspaceAssignmentOut(
            user_id=target.id,
            email=target.email,
            username=target.username,
            is_active=target.is_active,
            created_at=existing.created_at,
        )

    assignment = WorkspaceAssignment(
        workspace_id=workspace_id,
        user_id=target.id,
        assigned_by_id=actor.id,
    )
    db.add(assignment)
    db.flush()
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_ASSIGNED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"user_id": str(target.id), "user_email": target.email},
        commit=False,
    )
    db.commit()
    db.refresh(assignment)
    return WorkspaceAssignmentOut(
        user_id=target.id,
        email=target.email,
        username=target.username,
        is_active=target.is_active,
        created_at=assignment.created_at,
    )


@router.delete(
    "/{workspace_id}/assignments/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
def unassign_user_from_workspace(
    workspace_id: UUID,
    user_id: UUID,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> None:
    """Gỡ quyền sở hữu workspace của 1 user. Super-admin only."""
    _get_workspace_or_404(db, workspace_id)
    assignment = db.execute(
        select(WorkspaceAssignment).where(
            WorkspaceAssignment.workspace_id == workspace_id,
            WorkspaceAssignment.user_id == user_id,
        )
    ).scalar_one_or_none()
    if not assignment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Assignment không tồn tại"
        )
    db.delete(assignment)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_UNASSIGNED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={"user_id": str(user_id)},
        commit=False,
    )
    db.commit()
