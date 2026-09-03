"""Chức năng: CẤU HÌNH ĐÍCH MỜI theo từng user (nút ⚙️ trang "Mời thành viên").

Super-admin đặt, cho MỖI sub-admin, được add email MỚI vào workspace nào:
  - "Toàn bộ"  → cờ `users.invite_all_workspaces = True` (mọi workspace, kể cả tạo
                 mới sau này); các record `workspace_assignments` KHÔNG bị đụng tới.
  - "Chỉ định" → cờ = False + reconcile `workspace_assignments` khớp danh sách chọn.
    Danh sách RỖNG là hợp lệ: gỡ hết assignment → user đó TẠM NGƯNG (trang Mời không
    còn đích nào nên hiện thông báo tạm ngưng; mọi endpoint theo workspace cũng 404).

Đích email MỚI (trang Mời) chọn NGẪU NHIÊN 1 workspace trong tập đã bật. Email cũ/gia
hạn giữ workspace lịch sử — không qua đây. Dùng chung bảng `workspace_assignments` với
màn "Assign" ở trang Workspaces (giữ credit_budget của record sẵn có khi reconcile).

Endpoints (super-admin only):
  - GET /api/v1/invite-config/users            → danh sách sub-admin + cấu hình
  - PUT /api/v1/invite-config/users/{user_id}  → đặt cờ + reconcile assignment
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import get_session, require_super_admin
from app.models import User, Workspace, WorkspaceAssignment

router = APIRouter(prefix="/api/v1/invite-config", tags=["invite-config"])


class InviteConfigUserOut(BaseModel):
    user_id: UUID
    email: str
    username: str
    is_active: bool
    all_workspaces: bool
    workspace_ids: list[UUID]


class InviteConfigUpdate(BaseModel):
    all_workspaces: bool = False
    workspace_ids: list[UUID] = []


@router.get("/users", response_model=list[InviteConfigUserOut])
def list_invite_config(
    db: Session = Depends(get_session),
    _: User = Depends(require_super_admin),
) -> list[InviteConfigUserOut]:
    """Mỗi sub-admin (không phải super-admin): cờ Toàn bộ + các workspace đã gán."""
    users = (
        db.execute(
            select(User)
            .where(User.is_super_admin.is_(False))
            .order_by(User.created_at.asc())
        )
        .scalars()
        .all()
    )
    assignments = db.execute(
        select(WorkspaceAssignment.user_id, WorkspaceAssignment.workspace_id)
    ).all()
    ws_by_user: dict[UUID, list[UUID]] = {}
    for uid, wid in assignments:
        ws_by_user.setdefault(uid, []).append(wid)
    return [
        InviteConfigUserOut(
            user_id=u.id,
            email=u.email,
            username=u.username,
            is_active=u.is_active,
            all_workspaces=bool(u.invite_all_workspaces),
            workspace_ids=ws_by_user.get(u.id, []),
        )
        for u in users
    ]


@router.put("/users/{user_id}", response_model=InviteConfigUserOut)
def update_invite_config(
    user_id: UUID,
    body: InviteConfigUpdate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> InviteConfigUserOut:
    """Đặt cấu hình đích mời cho 1 sub-admin.

    - Toàn bộ: set cờ = True. KHÔNG đụng workspace_assignments (cờ đã bao trùm mọi ws;
      giữ nguyên credit_budget/visibility đã cấu hình ở màn Assign).
    - Chỉ định: set cờ = False + reconcile assignment khớp `workspace_ids` (thêm mới với
      budget 0, gỡ những cái bỏ chọn). Record sẵn có giữ nguyên credit_budget.
    """
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User không tồn tại"
        )
    if target.is_super_admin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Super-admin đã có quyền mọi workspace, không cần cấu hình",
        )

    flag_changed = bool(target.invite_all_workspaces) != bool(body.all_workspaces)
    target.invite_all_workspaces = bool(body.all_workspaces)
    db.add(target)

    existing = {
        a.workspace_id: a
        for a in db.execute(
            select(WorkspaceAssignment).where(WorkspaceAssignment.user_id == user_id)
        )
        .scalars()
        .all()
    }

    added: list[UUID] = []
    removed: list[UUID] = []
    if not body.all_workspaces:
        wanted = set(body.workspace_ids)
        # Bỏ workspace không tồn tại (tránh tạo record rác + FK lỗi).
        valid = {
            wid
            for (wid,) in db.execute(
                select(Workspace.id).where(Workspace.id.in_(wanted))
            ).all()
        }
        wanted &= valid
        for wid in wanted - existing.keys():
            db.add(
                WorkspaceAssignment(
                    workspace_id=wid, user_id=user_id, assigned_by_id=actor.id
                )
            )
            added.append(wid)
        for wid, a in existing.items():
            if wid not in wanted:
                db.delete(a)
                removed.append(wid)

    for wid in added:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=actor.id,
            actor_label=actor.email,
            action="WORKSPACE_ASSIGNED",
            result="SUCCESS",
            target_type="WORKSPACE",
            target_id=str(wid),
            data={"user_id": str(user_id), "user_email": target.email, "via": "invite_config"},
            commit=False,
        )
    for wid in removed:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=actor.id,
            actor_label=actor.email,
            action="WORKSPACE_UNASSIGNED",
            result="SUCCESS",
            target_type="WORKSPACE",
            target_id=str(wid),
            data={"user_id": str(user_id), "via": "invite_config"},
            commit=False,
        )
    if flag_changed:
        log_event(
            db,
            actor_type="ADMIN",
            actor_id=actor.id,
            actor_label=actor.email,
            action="INVITE_ALL_WORKSPACES_SET",
            result="SUCCESS",
            target_type="USER",
            target_id=str(user_id),
            data={"user_email": target.email, "all_workspaces": bool(body.all_workspaces)},
            commit=False,
        )
    db.commit()
    db.refresh(target)

    current_ws = [
        wid
        for (wid,) in db.execute(
            select(WorkspaceAssignment.workspace_id).where(
                WorkspaceAssignment.user_id == user_id
            )
        ).all()
    ]
    return InviteConfigUserOut(
        user_id=target.id,
        email=target.email,
        username=target.username,
        is_active=target.is_active,
        all_workspaces=bool(target.invite_all_workspaces),
        workspace_ids=current_ws,
    )
