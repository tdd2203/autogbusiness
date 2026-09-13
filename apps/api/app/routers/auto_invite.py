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

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import PLATFORM_GPT, User, Workspace, WorkspaceAssignment
from app.permissions import Permission
from app.schemas import Platform
from app.services import email_home, seats

router = APIRouter(prefix="/api/v1/auto-invite", tags=["auto-invite"])

# Ngưỡng "đã từng sử dụng" và thứ tự ưu tiên giữa các không gian nay sống ở
# `services/email_home.py`, dùng chung với chốt chặn ở các cửa mời. Giữ tên cũ ở đây
# cho người gọi cũ.
MIN_USAGE_DAYS_FOR_HISTORY = email_home.MIN_USAGE_DAYS_FOR_HISTORY


def _resolve_eligible_workspaces(
    db: Session, user: User, platform: str = PLATFORM_GPT
) -> list[Workspace]:
    """Danh sách workspace ĐÍCH được phép add email MỚI (theo cấu hình nút ⚙️):

    - super-admin: 1 workspace cũ nhất (giữ nguyên hành vi — mời riêng thì vào thẳng
      từng không gian, KHÔNG phân phối ngẫu nhiên ở trang này);
    - `invite_all_workspaces`: MỌI workspace (kể cả tạo mới sau này);
    - còn lại ("chỉ định"): các workspace được gán qua workspace_assignments.

    LUÔN lọc theo MỘT nhánh, mặc định 'gpt'. Trang Mời chọn NGẪU NHIÊN một đích cho
    mỗi email mới — trộn hai nhánh vào cùng danh sách thì một email ChatGPT có thể
    rơi vào team Canva, mất tiền và mất chỗ ở cả hai bên. Client cũ không gửi tham số
    nên vẫn chỉ thấy nhánh ChatGPT y như trước.
    """
    stmt = (
        select(Workspace)
        .where(Workspace.platform == platform)
        .order_by(Workspace.created_at.asc())
    )
    if user.is_super_admin:
        return list(db.execute(stmt.limit(1)).scalars().all())
    if user.invite_all_workspaces:
        return list(db.execute(stmt).scalars().all())
    stmt = stmt.join(
        WorkspaceAssignment, WorkspaceAssignment.workspace_id == Workspace.id
    ).where(WorkspaceAssignment.user_id == user.id)
    return list(db.execute(stmt).scalars().all())


def _resolve_workspace(
    db: Session, user: User, platform: str = PLATFORM_GPT
) -> Workspace | None:
    """Workspace ĐÍCH đầu tiên của người dùng (tương thích endpoint `/target` cũ)."""
    ws = _resolve_eligible_workspaces(db, user, platform)
    return ws[0] if ws else None




@router.get("/target", response_model=dict)
def get_target_workspace(
    platform: Platform = Query(default="gpt", description="Nhánh: 'gpt' | 'canva'"),
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Trả workspace cố định của người dùng (id + tên + ghế đã dùng/tổng) để trang Mời
    thành viên hiển thị khối "CỐ ĐỊNH" và biết mời vào đâu. 404 nếu chưa được cấp."""
    ws = _resolve_workspace(db, user, platform)
    if ws is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Bạn chưa được cấp không gian làm việc nào.",
        )
    # Suất lấy từ nguồn dùng chung `app.services.seats` — cùng con số với list
    # workspace, `GET /workspaces/seats` và thống kê thành viên.
    return seats.seat_snapshot(db, [ws])[0]


@router.get("/targets", response_model=dict)
def get_target_workspaces(
    platform: Platform = Query(default="gpt", description="Nhánh: 'gpt' | 'canva'"),
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Danh sách workspace ĐÍCH của người dùng cho email MỚI (id + tên + ghế) + cờ
    `all_workspaces`. Trang Mời thành viên chọn ngẫu nhiên 1 phần tử cho mỗi email mới.
    Danh sách rỗng → chưa được cấp / bị tạm ngưng (FE hiện thông báo tạm ngưng)."""
    workspaces = _resolve_eligible_workspaces(db, user, platform)
    return {
        "all_workspaces": bool(user.invite_all_workspaces) and not user.is_super_admin,
        # Suất kèm ở đây chỉ để tương thích người gọi cũ và cho lần vẽ ĐẦU TIÊN.
        # Danh sách đích được cache 5′ ở FE (cấu hình ít đổi) nên KHÔNG được coi
        # đây là nguồn suất — trang Mời đọc suất tươi từ `GET /workspaces/seats`.
        "workspaces": seats.seat_snapshot(db, workspaces),
    }


class EmailHistoryIn(BaseModel):
    emails: list[str]
    # Nhánh đang mời. Mặc định 'gpt' để client cũ giữ nguyên hành vi; lịch sử chỉ
    # được trả trong CÙNG nhánh, nếu không một email từng dùng workspace ChatGPT sẽ
    # kéo lệnh mời Canva về đúng workspace ChatGPT đó.
    platform: Platform = "gpt"


@router.post("/email-history", response_model=dict)
def get_email_history(
    body: EmailHistoryIn,
    db: Session = Depends(get_session),
    user: User = Depends(require_permission(Permission.MEMBER_INVITE)),
) -> dict:
    """Với danh sách email dán vào, trả những workspace mà email ĐÃ CÓ MẶT (do CHÍNH
    tài khoản này mời — cơ chế chủ sở hữu: chỉ chủ cũ mới mời lại được). Trang Mời
    thành viên dùng để hiện cột "Không gian" + cho chọn lại workspace cũ; mặc định là
    workspace ĐANG GIỮ HẠN của email, sau đó mới tới lần dùng dài nhất.

    "Thời gian đã sử dụng" 1 workspace = span của Member row đó: `joined_at` →
    `removed_at` (hoặc `now` nếu còn active). Mỗi (workspace, email) chỉ có 1 Member
    row (unique constraint) nên đây chính là lần tham gia dài nhất. Chưa từng vào
    (`joined_at` NULL) thì `usage_days = null` chứ không phải 0.

    NỚI 2026-07-20: email ĐÃ HẾT HẠN (`subscription_end_at <= now`) là "email cũ vô
    chủ" → lịch sử workspace hiện cho BẤT KỲ AI mời lại (không chỉ chủ cũ), để luôn
    trỏ về đúng workspace cũ email từng dùng. Email CÒN HẠN vẫn chỉ chủ cũ thấy (khớp
    [[invite-owner-lock]] mặt còn-hạn).

    NỚI 2026-09-12: bản ghi mà email ĐANG NGỒI (`active`/`pending`) LUÔN là lịch sử,
    bất kể hạn hay số ngày đã dùng, và mang cờ `holds_seat`. Trang Mời cho cả mẻ email
    vào chung một không gian chọn ở dải suất, nên nó phải biết email nào KHÔNG đi
    theo được: email đang ngồi chỗ khác mà bị kéo sang đích chung là cả nhóm ăn 409
    (`_assert_single_workspace`) và không ai trong nhóm được mời. Bản ghi đã `removed`
    thì không có cờ này.

    THÊM 2026-09-13: `home_workspace_id` = KHÔNG GIAN CŨ mà email phải được mời lại
    vào, kể cả khi email đã rời đội. Trước đó email đã rời đi theo đích chung của cả
    mẻ, và khách cũ của CHATGPT PRO rơi vào GPT1 (ca `cmsgpshp`). Chọn bằng
    `services/email_home.py` — đúng hàm mà các cửa mời dùng để chặn, nên trang ghim
    chỗ nào thì backend nhận đúng chỗ đó. `default_workspace_id` giữ nghĩa cũ (nơi
    mạnh nhất, kể cả chỗ tài khoản này không mời vào được).

    NỚI 2026-09-06: bản ghi CÓ HẠN SỬ DỤNG (còn hay hết) LUÔN là lịch sử, kể cả khi
    email chưa kịp vào workspace lần nào. Trước đây đòi `joined_at` NOT NULL + đủ 30
    ngày nên một email vừa chuyển hạn sang nhưng lệnh mời hỏng (chưa vào được lần
    nào) bị coi là email MỚI → trang Mời bốc ngẫu nhiên một workspace được gán và
    đẩy khách sang chỗ khác, trong khi tiền vẫn nằm ở workspace cũ. Ngưỡng 30 ngày
    giờ chỉ còn áp cho bản ghi KHÔNG có hạn sử dụng. Quyền workspace không cản: mời
    lại email mình sở hữu vào đúng workspace cũ vẫn chạy dù tài khoản không còn được
    gán workspace đó (`_assert_invite_workspace_access`)."""
    places = email_home.email_places(db, user, body.emails, body.platform)
    result: dict[str, dict] = {}
    # Một email hỏi quyền của một không gian đúng một lần cho cả danh sách dán vào.
    access_cache: dict[str, bool] = {}
    for email, ranked in places.items():
        home = email_home.pick_home(db, user, ranked, access_cache)
        result[email] = {
            "default_workspace_id": ranked[0].workspace_id,
            "home_workspace_id": home.workspace_id if home is not None else None,
            "workspaces": [p.as_dict() for p in ranked],
        }
    return {"emails": result}
