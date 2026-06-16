"""Chức năng: MEMBER OWNERSHIP (gán/thu hồi chủ sở hữu member).

⚠️ ĐỌC `ownership.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.

Endpoints (super-admin only):
  - PATCH /{member_id}/owner → set_member_owner   (gán/thu hồi 1 member)
  - POST  /assign-owner      → bulk_assign_owner   (gán hàng loạt cho 1 user)
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_super_admin
from app.models import Member, User
from app.schemas import MemberBulkAssignOwnerIn, MemberSetOwnerIn, MemberOut

from ._shared import router, _get_workspace_or_404


@router.patch("/{member_id}/owner", response_model=MemberOut)
def set_member_owner(
    workspace_id: UUID,
    member_id: UUID,
    body: MemberSetOwnerIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Member:
    """Admin gán/THU HỒI chủ sở hữu 1 member (sửa khi gán nhầm).

    invited_by_user_id=None → thu hồi (member về 'chưa có chủ').
    Chỉ super-admin (admin có toàn quyền điều chỉnh sở hữu).
    """
    _get_workspace_or_404(db, workspace_id)
    member = db.execute(
        select(Member).where(
            Member.id == member_id, Member.workspace_id == workspace_id
        )
    ).scalar_one_or_none()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Member không tồn tại"
        )

    if body.invited_by_user_id is not None:
        target = db.get(User, body.invited_by_user_id)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Tài khoản gán làm chủ không tồn tại",
            )

    before = member.invited_by_user_id
    member.invited_by_user_id = body.invited_by_user_id
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="MEMBER_OWNER_CHANGED",
        result="SUCCESS",
        target_type="MEMBER",
        target_id=str(member.id),
        data={
            "workspace_id": str(workspace_id),
            "email": member.email,
            "before": str(before) if before else None,
            "after": str(body.invited_by_user_id) if body.invited_by_user_id else None,
        },
        commit=False,
    )
    db.commit()
    db.refresh(member)
    return member


@router.post("/assign-owner", response_model=dict)
def bulk_assign_owner(
    workspace_id: UUID,
    body: MemberBulkAssignOwnerIn,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> dict:
    """Admin gán hàng loạt member cho 1 user (vd quy đám member cũ cho hdh2102).

    Loại trừ: email trong `exclude_emails` (owner + danh sách Excel) và — nếu
    skip_verified_domain — email thuộc verified_domain của workspace.
    only_unassigned=True chỉ đụng member CHƯA có chủ. Chỉ super-admin.
    """
    ws = _get_workspace_or_404(db, workspace_id)
    target = db.get(User, body.target_user_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tài khoản gán làm chủ không tồn tại",
        )

    exclude = {e.strip().lower() for e in body.exclude_emails if e.strip()}
    dom = (ws.verified_domain or "").strip().lower()

    stmt = select(Member).where(
        Member.workspace_id == workspace_id, Member.status != "removed"
    )
    if body.only_unassigned:
        stmt = stmt.where(Member.invited_by_user_id.is_(None))
    members = list(db.execute(stmt).scalars())

    assigned = 0
    skipped_excluded = 0
    skipped_domain = 0
    skipped_owner = 0
    for m in members:
        email = m.email.lower()
        # Chủ sở hữu workspace (role 'owner') KHÔNG bao giờ thuộc về sub-admin.
        if m.chatgpt_role == "owner":
            skipped_owner += 1
            continue
        if email in exclude:
            skipped_excluded += 1
            continue
        if body.skip_verified_domain and dom and email.endswith("@" + dom):
            skipped_domain += 1
            continue
        if m.invited_by_user_id == body.target_user_id:
            continue
        m.invited_by_user_id = body.target_user_id
        assigned += 1

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="MEMBER_BULK_OWNER_ASSIGN",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(workspace_id),
        data={
            "target_user_id": str(body.target_user_id),
            "assigned": assigned,
            "skipped_excluded": skipped_excluded,
            "skipped_domain": skipped_domain,
            "skipped_owner": skipped_owner,
            "candidates": len(members),
        },
        commit=False,
    )
    db.commit()
    return {
        "assigned": assigned,
        "skipped_excluded": skipped_excluded,
        "skipped_domain": skipped_domain,
        "skipped_owner": skipped_owner,
        "candidates": len(members),
        "target_user_id": str(body.target_user_id),
    }
