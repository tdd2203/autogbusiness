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

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.deps import get_session, require_permission
from app.models import PLATFORM_GPT, Member, User, Workspace, WorkspaceAssignment
from app.permissions import Permission
from app.schemas import Platform
from app.services import seats

router = APIRouter(prefix="/api/v1/auto-invite", tags=["auto-invite"])

# Ngưỡng tối thiểu để coi email "đã từng sử dụng" 1 workspace và hiện cột chọn lại
# (user 2026-07-19: "đã sử dụng tối thiểu 30 ngày"). Tính theo lần tham gia dài nhất.
MIN_USAGE_DAYS_FOR_HISTORY = 30


def _as_utc(value: datetime | None) -> datetime | None:
    """Mốc thời gian về UTC có tzinfo. Dữ liệu cũ trong DB có dòng naive, trừ thẳng
    hai kiểu khác nhau là TypeError giữa lúc đang dán email."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _history_rank(entry: dict) -> tuple[int, int, int]:
    """Thứ tự ưu tiên workspace trong lịch sử của 1 email: workspace email ĐANG NGỒI
    đứng trên hết, rồi tới workspace ĐANG GIỮ HẠN, cuối cùng mới là dùng lâu nhất.

    Đang ngồi (`holds_seat`) là chỗ DUY NHẤT mời lại được: 1 email chỉ ở 1 không gian,
    mời sang chỗ khác là backend từ chối cả lô (`_assert_single_workspace`). Giữ hạn
    nghĩa là tiền của email đang nằm ở đó — mời lại chỗ khác thì hạn được dời sang
    theo, nhưng vẫn nên mặc định về đúng chỗ cũ."""
    return (
        1 if entry.get("holds_seat") else 0,
        1 if entry.get("holds_subscription") else 0,
        entry.get("usage_days") or 0,
    )


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
    thì không có cờ này — nó đi theo đích chung được, hạn cũ dời sang cùng.

    NỚI 2026-09-06: bản ghi CÓ HẠN SỬ DỤNG (còn hay hết) LUÔN là lịch sử, kể cả khi
    email chưa kịp vào workspace lần nào. Trước đây đòi `joined_at` NOT NULL + đủ 30
    ngày nên một email vừa chuyển hạn sang nhưng lệnh mời hỏng (chưa vào được lần
    nào) bị coi là email MỚI → trang Mời bốc ngẫu nhiên một workspace được gán và
    đẩy khách sang chỗ khác, trong khi tiền vẫn nằm ở workspace cũ. Ngưỡng 30 ngày
    giờ chỉ còn áp cho bản ghi KHÔNG có hạn sử dụng. Quyền workspace không cản: mời
    lại email mình sở hữu vào đúng workspace cũ vẫn chạy dù tài khoản không còn được
    gán workspace đó (`_assert_invite_workspace_access`)."""
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
            Member.status,
        )
        .join(Workspace, Workspace.id == Member.workspace_id)
        .where(
            func.lower(Member.email).in_(wanted),
            Workspace.platform == body.platform,
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

    # email -> workspace_id -> {name, usage_days, holds_subscription, holds_seat}. Mỗi cặp
    # (email, workspace) chỉ có 1 Member row nên không có chuyện trùng, `prev` chỉ để
    # phòng dữ liệu cũ lẫn hoa/thường trong cột email.
    by_email: dict[str, dict[str, dict]] = {}
    for r in rows:
        joined = _as_utc(r.joined_at)
        end_at = _as_utc(r.subscription_end_at)
        # Chưa từng vào workspace (`joined_at` NULL: lời mời hỏng, hoặc vừa chuyển hạn
        # sang mà lệnh mời chưa chạy xong) → không có số ngày sử dụng để khoe, nhưng
        # VẪN là lịch sử của email.
        usage_days = (
            None
            if joined is None
            else max(0, ((_as_utc(r.removed_at) or now) - joined).days)
        )
        # Email ĐANG NGỒI ở workspace này (đã vào đội, hoặc đang chờ nhận lời mời).
        # Đây là chỗ DUY NHẤT mời lại được, nên không có ngưỡng nào cản nó cả: một
        # email vừa được mời hôm qua, chưa có hạn, vẫn phải lộ ra ở đây.
        holds_seat = r.status in ("active", "pending")
        # Ngưỡng 30 ngày chỉ còn áp cho bản ghi KHÔNG có hạn sử dụng và email đã rời
        # đi — nó vốn là tiện ích "chọn lại workspace đã dùng lâu". Bản ghi CÓ hạn thì
        # workspace đó là chỗ tiền của email đang nằm (còn hạn) hoặc từng nằm (hết
        # hạn), mời lại phải trỏ về đúng đó dù dùng ngắn hay chưa vào lần nào.
        if (
            not holds_seat
            and end_at is None
            and (usage_days is None or usage_days < MIN_USAGE_DAYS_FOR_HISTORY)
        ):
            continue
        ws_id = str(r.workspace_id)
        entry = {
            "workspace_id": ws_id,
            "name": r.name,
            "usage_days": usage_days,
            # Đang giữ hạn = workspace phải mời lại vào, kể cả bản ghi đã `removed`.
            "holds_subscription": end_at is not None and end_at > now,
            # Đang ngồi = KHÔNG được kéo sang không gian khác, backend chặn cứng.
            "holds_seat": holds_seat,
        }
        bucket = by_email.setdefault(r.email, {})
        prev = bucket.get(ws_id)
        if prev is None or _history_rank(entry) > _history_rank(prev):
            bucket[ws_id] = entry

    result: dict[str, dict] = {}
    for email, bucket in by_email.items():
        workspaces = sorted(bucket.values(), key=_history_rank, reverse=True)
        if not workspaces:
            continue
        result[email] = {
            "default_workspace_id": workspaces[0]["workspace_id"],
            "workspaces": workspaces,
        }
    return {"emails": result}
