"""Chức năng: TRANG "MỜI THÀNH VIÊN" (phía người dùng) — resolve workspace CỐ ĐỊNH.

Mô hình (chốt user 2026-07-17): mỗi người dùng được super-admin CẤP cố định 1 workspace.
Trang Mời thành viên KHÔNG cho chọn workspace — chỉ hiện workspace được cấp ("CỐ ĐỊNH")
rồi mời mọi email vào đó. Vì thế phần backend duy nhất cần THÊM là 1 endpoint resolve
"workspace của tôi"; toàn bộ luồng mời/duyệt phí TÁI SỬ DỤNG endpoint bulk-invite sẵn có
(`/api/v1/workspaces/{id}/members/bulk-invite` + `/invite-preview`).

Cập nhật 2026-07-19: đích không còn CỐ ĐỊNH 1 workspace. Super-admin cấu hình (nút ⚙️,
router `invite_config`) mỗi user được add email MỚI vào "Toàn bộ" (cờ
`users.invite_all_workspaces`) hay "Chỉ định" (bảng `workspace_assignments`). Endpoint
`/targets` trả danh sách đích; FE chọn ngẫu nhiên 1 phần tử cho mỗi email mới. Email
cũ/gia hạn giữ workspace lịch sử (`/email-history`) — không đổi.

Cập nhật 2026-07-20: mở trang Mời cho sub-admin — 3 endpoint gate quyền MEMBER_INVITE
(không còn super-admin only). Cấu hình đích (nút ⚙️, router `invite_config`) vẫn
super-admin only.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import Member, User, Workspace, WorkspaceAssignment
from app.permissions import Permission

router = APIRouter(prefix="/api/v1/auto-invite", tags=["auto-invite"])

# Ngưỡng tối thiểu để coi email "đã từng sử dụng" 1 workspace và hiện cột chọn lại
# (user 2026-07-19: "đã sử dụng tối thiểu 30 ngày"). Tính theo lần tham gia dài nhất.
MIN_USAGE_DAYS_FOR_HISTORY = 30


def _resolve_eligible_workspaces(db: Session, user: User) -> list[Workspace]:
    """Danh sách workspace ĐÍCH được phép add email MỚI (theo cấu hình nút ⚙️):

    - super-admin: 1 workspace cũ nhất (giữ nguyên hành vi — mời riêng thì vào thẳng
      từng không gian, KHÔNG phân phối ngẫu nhiên ở trang này);
    - `invite_all_workspaces`: MỌI workspace (kể cả tạo mới sau này);
    - còn lại ("chỉ định"): các workspace được gán qua workspace_assignments.

    Trang Mời thành viên chọn NGẪU NHIÊN 1 phần tử trong danh sách này cho mỗi email
    mới (email cũ/gia hạn dùng workspace lịch sử — không qua đây).
    """
    stmt = select(Workspace).order_by(Workspace.created_at.asc())
    if user.is_super_admin:
        return list(db.execute(stmt.limit(1)).scalars().all())
    if user.invite_all_workspaces:
        return list(db.execute(stmt).scalars().all())
    stmt = stmt.join(
        WorkspaceAssignment, WorkspaceAssignment.workspace_id == Workspace.id
    ).where(WorkspaceAssignment.user_id == user.id)
    return list(db.execute(stmt).scalars().all())


def _resolve_workspace(db: Session, user: User) -> Workspace | None:
    """Workspace ĐÍCH đầu tiên của người dùng (tương thích endpoint `/target` cũ)."""
    ws = _resolve_eligible_workspaces(db, user)
    return ws[0] if ws else None


def _seat_used_map(db: Session, workspace_ids: list) -> dict:
    """workspace_id (str) -> số member CHƯA bị gỡ (khớp cách hiển thị seat_used)."""
    if not workspace_ids:
        return {}
    rows = db.execute(
        select(Member.workspace_id, func.count())
        .where(Member.workspace_id.in_(workspace_ids), Member.status != "removed")
        .group_by(Member.workspace_id)
    ).all()
    return {str(wid): int(n) for wid, n in rows}


@router.get("/target", response_model=dict)
def get_target_workspace(
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Trả workspace cố định của người dùng (id + tên + ghế đã dùng/tổng) để trang Mời
    thành viên hiển thị khối "CỐ ĐỊNH" và biết mời vào đâu. 404 nếu chưa được cấp."""
    ws = _resolve_workspace(db, user)
    if ws is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Bạn chưa được cấp không gian làm việc nào.",
        )
    # Ghế đã dùng = số member CHƯA bị gỡ (khớp cách hiển thị seat_used ở list workspace).
    seat_used = int(
        db.execute(
            select(func.count())
            .select_from(Member)
            .where(Member.workspace_id == ws.id, Member.status != "removed")
        ).scalar_one()
    )
    return {
        "workspace_id": str(ws.id),
        "name": ws.name,
        "seat_used": seat_used,
        "seat_total": ws.seat_total,
    }


@router.get("/targets", response_model=dict)
def get_target_workspaces(
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Danh sách workspace ĐÍCH của người dùng cho email MỚI (id + tên + ghế) + cờ
    `all_workspaces`. Trang Mời thành viên chọn ngẫu nhiên 1 phần tử cho mỗi email mới.
    Danh sách rỗng → chưa được cấp không gian nào (FE hiện thông báo)."""
    workspaces = _resolve_eligible_workspaces(db, user)
    seat_used = _seat_used_map(db, [w.id for w in workspaces])
    return {
        "all_workspaces": bool(user.invite_all_workspaces) and not user.is_super_admin,
        "workspaces": [
            {
                "workspace_id": str(w.id),
                "name": w.name,
                "seat_used": seat_used.get(str(w.id), 0),
                "seat_total": w.seat_total,
            }
            for w in workspaces
        ],
    }


class EmailHistoryIn(BaseModel):
    emails: list[str]


@router.post("/email-history", response_model=dict)
def get_email_history(
    body: EmailHistoryIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Với danh sách email dán vào, trả những workspace mà email ĐÃ TỪNG THAM GIA
    (do CHÍNH tài khoản này mời — cơ chế chủ sở hữu: chỉ chủ cũ mới mời lại được) và
    đã dùng tối thiểu `MIN_USAGE_DAYS_FOR_HISTORY` ngày. Trang Mời thành viên dùng để
    hiện cột "Không gian" + cho chọn lại workspace cũ (mặc định = lần dùng dài nhất).

    "Thời gian đã sử dụng" 1 workspace = span của Member row đó: `joined_at` →
    `removed_at` (hoặc `now` nếu còn active). Mỗi (workspace, email) chỉ có 1 Member
    row (unique constraint) nên đây chính là lần tham gia dài nhất. Chỉ xét member
    đã THẬT SỰ tham gia (`joined_at` NOT NULL) — pending chưa vào thì chưa có usage.

    NỚI 2026-07-20: email ĐÃ HẾT HẠN (`subscription_end_at <= now`) là "email cũ vô
    chủ" → lịch sử workspace hiện cho BẤT KỲ AI mời lại (không chỉ chủ cũ), để luôn
    trỏ về đúng workspace cũ email từng dùng. Email CÒN HẠN vẫn chỉ chủ cũ thấy (khớp
    [[invite-owner-lock]] mặt còn-hạn). Email chưa từng tham gia / <30 ngày KHÔNG
    xuất hiện → FE cho vào workspace đích do admin gán."""
    wanted = {e.strip().lower() for e in body.emails if e and e.strip()}
    if not wanted:
        return {"emails": {}}

    now = datetime.now(timezone.utc)
    rows = db.execute(
        select(
            func.lower(Member.email).label("email"),
            Member.workspace_id,
            Workspace.name,
            Member.joined_at,
            Member.removed_at,
            Member.subscription_end_at,
        )
        .join(Workspace, Workspace.id == Member.workspace_id)
        .where(
            func.lower(Member.email).in_(wanted),
            Member.joined_at.isnot(None),
            or_(
                # Lịch sử của CHÍNH mình (còn hạn hay hết hạn đều thấy).
                Member.invited_by_user_id == user.id,
                # HOẶC email đã HẾT HẠN (vô chủ) → ai cũng thấy workspace cũ.
                and_(
                    Member.subscription_end_at.isnot(None),
                    Member.subscription_end_at <= now,
                ),
            ),
        )
    ).all()

    # email -> workspace_id -> {name, usage_days} (giữ span dài nhất nếu trùng).
    by_email: dict[str, dict[str, dict]] = {}
    for r in rows:
        end = r.removed_at or now
        joined = r.joined_at
        if joined.tzinfo is None:
            joined = joined.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        usage_days = max(0, (end - joined).days)
        # Ngưỡng 30 ngày chỉ áp cho email CÒN HẠN (tính năng "chọn lại workspace" tiện
        # lợi). Email đã HẾT HẠN (vô chủ) LUÔN hiện workspace cũ dù dùng ngắn — để mời
        # lại luôn trỏ về đúng không gian cũ (yêu cầu user 2026-07-20). Re-invite reset
        # joined_at nên usage có thể =0, không được để ngưỡng chặn.
        is_expired = (
            r.subscription_end_at is not None
            and (
                r.subscription_end_at.replace(tzinfo=timezone.utc)
                if r.subscription_end_at.tzinfo is None
                else r.subscription_end_at
            )
            <= now
        )
        if not is_expired and usage_days < MIN_USAGE_DAYS_FOR_HISTORY:
            continue
        ws_id = str(r.workspace_id)
        bucket = by_email.setdefault(r.email, {})
        prev = bucket.get(ws_id)
        if prev is None or usage_days > prev["usage_days"]:
            bucket[ws_id] = {
                "workspace_id": ws_id,
                "name": r.name,
                "usage_days": usage_days,
            }

    result: dict[str, dict] = {}
    for email, bucket in by_email.items():
        workspaces = sorted(
            bucket.values(), key=lambda w: w["usage_days"], reverse=True
        )
        if not workspaces:
            continue
        result[email] = {
            "default_workspace_id": workspaces[0]["workspace_id"],
            "workspaces": workspaces,
        }
    return {"emails": result}
