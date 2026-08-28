"""Chức năng: WORKSPACE CRUD (tạo / đọc / cập nhật) + extension whoami/info.

⚠️ ĐỌC `crud.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
Docs ghi lịch sử lỗi, business rule và ý tưởng cải tiến — code chỉ là "how".

Endpoints (đăng ký lên router dùng chung từ `_shared`):
  - GET   /whoami          → extension_whoami
  - POST  /extension-info  → update_extension_info
  - GET   /seats           → list_workspace_seats
  - GET   ""               → list_workspaces
  - POST  ""               → create_workspace
  - GET   /{workspace_id}  → get_workspace
  - PATCH /{workspace_id}  → update_workspace
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.deps import (
    assert_workspace_access,
    get_current_user,
    get_session,
    require_extension_workspace,
    require_super_admin,
)
from app.models import (
    User,
    Workspace,
    WorkspaceAssignment,
    WorkspaceSettings,
)
from app.schemas import (
    ExtensionInfoIn,
    WorkspaceCreate,
    WorkspaceOut,
    WorkspaceSeatsOut,
    WorkspaceUpdate,
    WorkspaceWithKey,
)
from app.services import seats

from ._shared import (
    router,
    _generate_api_key,
    _get_workspace_or_404,
    _normalize_domain,
)


@router.get("/whoami", response_model=WorkspaceOut)
def extension_whoami(
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> Workspace:
    """Extension dùng để verify X-API-KEY hợp lệ + lấy thông tin workspace tương ứng.

    `seat_used` tính LẠI như dashboard (`_apply_effective_seat_used`) chứ không
    trả cột thô: popup extension in "Seat: x/y" nên phải khớp với con số admin
    đang nhìn trên dashboard, không được là số scrape cũ của lần sync nào đó.
    """
    _apply_effective_seat_used(db, [workspace])
    return workspace


@router.post("/extension-info", response_model=WorkspaceOut)
def update_extension_info(
    body: ExtensionInfoIn,
    db: Session = Depends(get_session),
    workspace: Workspace = Depends(require_extension_workspace),
) -> Workspace:
    """Extension báo ChatGPT user đang đăng nhập trên browser."""
    if body.email is not None:
        workspace.chatgpt_user_email = body.email.strip().lower() or None
    if body.name is not None:
        workspace.chatgpt_user_name = body.name.strip() or None
    db.add(workspace)
    db.commit()
    db.refresh(workspace)
    return workspace


def _apply_effective_seat_used(db: Session, workspaces: list[Workspace]) -> None:
    """Ghi đè `seat_used` (chỉ trong-memory, để hiển thị) = số member THẬT trong DB.

    Phép đếm nằm ở `app.services.seats` — nguồn suất DÙNG CHUNG của mọi nơi hiển
    thị (list workspace, /seats, member stats, targets trang Mời). Đừng đếm tay
    lại ở đây: `Workspace.seat_used` scrape từ trang billing chỉ cập nhật khi chạy
    SYNC_BILLING nên lệch được CẢ HAI CHIỀU (2026-07-08: billing báo 44 trong khi
    vừa xoá 3 người chỉ còn 41 thật).

    KHÔNG persist: các endpoint GET không commit nên thay đổi này bị rollback khi
    session đóng.
    """
    if not workspaces:
        return
    counts = seats.seat_used_map(db, [ws.id for ws in workspaces])
    for ws in workspaces:
        ws.seat_used = counts.get(ws.id, 0)


@router.get("/seats", response_model=list[WorkspaceSeatsOut])
def list_workspace_seats(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """Ảnh chụp SUẤT của mọi workspace người dùng có thể nhìn/mời vào.

    Endpoint RẺ và chuyên dụng: chỉ 2 truy vấn (danh sách workspace + 1 câu đếm
    gộp), không kéo theo hoá đơn/cấu hình như `GET /workspaces`. Dashboard poll
    nhịp ngắn vào đây để mọi chỗ hiện suất (trang Mời, danh sách không gian, thống
    kê thành viên) cùng đọc MỘT con số và cùng tươi — thay vì mỗi trang tự nhớ một
    bản chụp lúc mở.

    Phạm vi rộng hơn `GET /workspaces` một chút: user có cờ `invite_all_workspaces`
    được add email vào MỌI workspace nên phải thấy suất của mọi workspace, dù chưa
    được gán cái nào.
    """
    stmt = select(Workspace).order_by(Workspace.created_at.desc())
    if not (user.is_super_admin or user.invite_all_workspaces):
        stmt = stmt.join(
            WorkspaceAssignment,
            WorkspaceAssignment.workspace_id == Workspace.id,
        ).where(WorkspaceAssignment.user_id == user.id)
    return seats.seat_snapshot(db, list(db.execute(stmt).scalars()))


@router.get("", response_model=list[WorkspaceOut])
def list_workspaces(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[Workspace]:
    stmt = select(Workspace).order_by(Workspace.created_at.desc())
    # Sub-admin chỉ thấy workspace được gán (super-admin thấy tất cả).
    if not user.is_super_admin:
        stmt = stmt.join(
            WorkspaceAssignment,
            WorkspaceAssignment.workspace_id == Workspace.id,
        ).where(WorkspaceAssignment.user_id == user.id)
    workspaces = list(db.execute(stmt).scalars())
    _apply_effective_seat_used(db, workspaces)
    return workspaces


@router.post("", response_model=WorkspaceWithKey, status_code=status.HTTP_201_CREATED)
def create_workspace(
    body: WorkspaceCreate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    if body.chatgpt_id:
        existing = db.execute(
            select(Workspace).where(Workspace.chatgpt_id == body.chatgpt_id)
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Workspace với chatgpt_id này đã tồn tại",
            )

    ws = Workspace(
        name=body.name,
        chatgpt_id=body.chatgpt_id,
        plan=body.plan,
        seat_total=body.seat_total,
        verified_domain=_normalize_domain(body.verified_domain),
        extension_api_key=_generate_api_key(),
        created_by_id=actor.id,
    )
    db.add(ws)
    db.flush()

    db.add(WorkspaceSettings(workspace_id=ws.id))

    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_CREATED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        data={"name": ws.name, "chatgpt_id": ws.chatgpt_id, "plan": ws.plan},
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws


@router.get("/{workspace_id}", response_model=WorkspaceOut)
def get_workspace(
    workspace_id: UUID,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Workspace:
    ws = _get_workspace_or_404(db, workspace_id)
    assert_workspace_access(db, user, workspace_id)
    _apply_effective_seat_used(db, [ws])
    return ws


@router.patch("/{workspace_id}", response_model=WorkspaceOut)
def update_workspace(
    workspace_id: UUID,
    body: WorkspaceUpdate,
    db: Session = Depends(get_session),
    actor: User = Depends(require_super_admin),
) -> Workspace:
    ws = _get_workspace_or_404(db, workspace_id)
    changes: dict = {}

    for field in ("name", "chatgpt_id", "plan", "seat_total", "chatgpt_locale"):
        new_val = getattr(body, field)
        if new_val is not None and new_val != getattr(ws, field):
            changes[field] = {"before": getattr(ws, field), "after": new_val}
            setattr(ws, field, new_val)

    # bank_fee_percent: cho phép cả set lẫn XOÁ (gửi null/0 = bỏ tính phí theo %,
    # quay lại phí nhập tay từng hoá đơn) → phải đọc theo model_fields_set chứ không
    # dựa vào "khác None" như vòng lặp trên.
    if "bank_fee_percent" in body.model_fields_set:
        new_pct = body.bank_fee_percent or None
        if new_pct != ws.bank_fee_percent:
            changes["bank_fee_percent"] = {
                "before": ws.bank_fee_percent,
                "after": new_pct,
            }
            ws.bank_fee_percent = new_pct

    # verified_domain: cho phép cả set lẫn xoá (gửi "" để xoá). Chuẩn hoá trước
    # khi so sánh. Chỉ áp dụng khi client thực sự gửi field này.
    if "verified_domain" in body.model_fields_set:
        new_domain = _normalize_domain(body.verified_domain)
        if new_domain != ws.verified_domain:
            changes["verified_domain"] = {
                "before": ws.verified_domain,
                "after": new_domain,
            }
            ws.verified_domain = new_domain

    if not changes:
        return ws

    db.add(ws)
    log_event(
        db,
        actor_type="ADMIN",
        actor_id=actor.id,
        actor_label=actor.email,
        action="WORKSPACE_UPDATED",
        result="SUCCESS",
        target_type="WORKSPACE",
        target_id=str(ws.id),
        data=changes,
        commit=False,
    )
    db.commit()
    db.refresh(ws)
    return ws
