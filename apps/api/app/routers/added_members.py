"""Tab 'Email đã add' — theo dõi thanh toán cho tài khoản phụ.

Gom các Member do 1 user đã add (invited_by_user_id) xuyên suốt mọi workspace,
chỉ những email còn tồn tại trong team (status != 'removed'), kèm trạng thái
đã/chưa thanh toán cho admin. Tài khoản phụ tự duyệt thanh toán cho email mình add;
super-admin có thể xem theo từng tài khoản phụ (query ?user_id=).
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.audit import log_event
from app.deps import get_current_user, get_session
from app.models import Member, User
from app.schemas import (
    AddedMemberOut,
    MemberMarkPaidIn,
    MemberRevokeOwnerIn,
    MemberTransferOwnerIn,
)

router = APIRouter(prefix="/api/v1/added-members", tags=["added-members"])


@router.get("", response_model=list[AddedMemberOut])
def list_added_members(
    user_id: UUID | None = None,
    unassigned: bool = False,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[AddedMemberOut]:
    """Danh sách email user đã add (còn tồn tại) + trạng thái thanh toán.

    - Sub-admin: luôn chỉ thấy email do CHÍNH MÌNH add (bỏ qua user_id/unassigned).
    - Super-admin:
        ?user_id=<id>   → xem riêng 1 tài khoản phụ
        ?unassigned=true → xem "email còn lại" (CHƯA có chủ) — super-admin quản lý
        bỏ trống         → tất cả email đã có chủ (add qua dashboard)
    """
    if user.is_super_admin:
        target_user_id = user_id
    else:
        target_user_id = user.id
        unassigned = False  # sub-admin không xem pool email còn lại

    stmt = (
        select(Member)
        .options(selectinload(Member.workspace), selectinload(Member.invited_by))
        .where(Member.status != "removed")
        .order_by(Member.created_at.desc())
    )
    if unassigned:
        # Email còn lại: chưa gán cho ai → super-admin quản lý.
        stmt = stmt.where(Member.invited_by_user_id.is_(None))
    elif target_user_id is not None:
        stmt = stmt.where(Member.invited_by_user_id == target_user_id)
    # else: super-admin xem mặc định → TẤT CẢ member còn tồn tại (kể cả email
    # còn lại chưa chủ) để quản lý đầy đủ + gán/chuyển quyền sở hữu. Owner hiển
    # thị qua invited_by_username (None = chưa chủ).

    rows: list[AddedMemberOut] = []
    for member in db.execute(stmt).scalars():
        out = AddedMemberOut.model_validate(member)
        out.workspace_name = member.workspace.name if member.workspace else None
        out.invited_by_username = (
            member.invited_by.username if member.invited_by else None
        )
        rows.append(out)
    return rows


@router.post("/mark-paid", response_model=dict)
def mark_members_paid(
    body: MemberMarkPaidIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Duyệt (hoặc huỷ) thanh toán cho nhiều email cùng lúc.

    Sub-admin chỉ được thao tác trên email mình đã add; super-admin thao tác được
    mọi email. Email không thuộc quyền sẽ bị bỏ qua (không tính vào count).
    """
    members = list(
        db.execute(select(Member).where(Member.id.in_(body.member_ids))).scalars()
    )
    now = datetime.now(timezone.utc)
    new_status = "paid" if body.paid else "unpaid"
    updated_ids: list[str] = []
    for member in members:
        if not user.is_super_admin and member.invited_by_user_id != user.id:
            continue
        member.payment_status = new_status
        member.paid_at = now if body.paid else None
        member.paid_marked_by_id = user.id if body.paid else None
        updated_ids.append(str(member.id))

    if updated_ids:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_PAYMENT_MARKED",
            result="OK",
            target_type="MEMBER",
            target_id=updated_ids[0] if len(updated_ids) == 1 else None,
            data={
                "paid": body.paid,
                "count": len(updated_ids),
                "member_ids": updated_ids,
            },
            commit=False,
        )
        db.commit()
    return {"count": len(updated_ids), "paid": body.paid}


@router.post("/revoke-owner", response_model=dict)
def revoke_members_owner(
    body: MemberRevokeOwnerIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Super-admin THU HỒI quyền sở hữu nhiều email → về 'email còn lại' (NULL).

    Chỉ super-admin. Email sau thu hồi không còn thuộc tài khoản phụ nào, super-admin
    quản lý (xem qua ?unassigned=true) và có thể gán lại nếu cần.
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được thu hồi quyền sở hữu",
        )
    members = list(
        db.execute(select(Member).where(Member.id.in_(body.member_ids))).scalars()
    )
    revoked_ids: list[str] = []
    for member in members:
        if member.invited_by_user_id is None:
            continue
        member.invited_by_user_id = None
        revoked_ids.append(str(member.id))

    if revoked_ids:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_OWNER_REVOKED",
            result="OK",
            target_type="MEMBER",
            target_id=revoked_ids[0] if len(revoked_ids) == 1 else None,
            data={"count": len(revoked_ids), "member_ids": revoked_ids},
            commit=False,
        )
        db.commit()
    return {"count": len(revoked_ids)}


@router.post("/transfer-owner", response_model=dict)
def transfer_members_owner(
    body: MemberTransferOwnerIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Super-admin chuyển quyền sở hữu nhiều email sang `target_user_id`.

    - 'Thu hồi về admin': frontend truyền target = id của super-admin đang thao tác.
    - 'Chuyển cho sub-admin': target = id sub-admin đích.
    Chỉ super-admin. Email không thay đổi (đã đúng chủ) bị bỏ qua khỏi count.
    """
    if not user.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ super-admin được chuyển quyền sở hữu",
        )
    target = db.get(User, body.target_user_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tài khoản nhận quyền sở hữu không tồn tại",
        )
    members = list(
        db.execute(select(Member).where(Member.id.in_(body.member_ids))).scalars()
    )
    changed_ids: list[str] = []
    for member in members:
        if member.invited_by_user_id == body.target_user_id:
            continue
        member.invited_by_user_id = body.target_user_id
        changed_ids.append(str(member.id))

    if changed_ids:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=user.id,
            actor_label=user.email,
            action="MEMBER_OWNER_TRANSFERRED",
            result="OK",
            target_type="MEMBER",
            target_id=changed_ids[0] if len(changed_ids) == 1 else None,
            data={
                "count": len(changed_ids),
                "target_user_id": str(body.target_user_id),
                "target_username": target.username,
                "member_ids": changed_ids,
            },
            commit=False,
        )
        db.commit()
    return {
        "count": len(changed_ids),
        "target_user_id": str(body.target_user_id),
        "target_username": target.username,
    }
