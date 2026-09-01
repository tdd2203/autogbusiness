"""Chức năng: NGUỒN SUẤT (seat) DÙNG CHUNG cho toàn hệ thống.

Trước file này mỗi nơi tự viết lại câu đếm suất: `crud._apply_effective_seat_used`,
`stats.member_stats`, `auto_invite._seat_used_map`, `invite._seat_hint` và
`invite._assert_seat_available`. Năm bản sao cùng một quy tắc là năm cơ hội lệch
nhau — đã xảy ra (2026-07-08: dashboard "44/35" vì một nhánh còn blend `max()` với
số scrape cũ). Mọi nơi cần con số suất phải gọi vào đây, không tự viết `func.count`.

Hai con số, hai nguồn KHÁC nhau:

- `seat_total` = cột `Workspace.seat_total`, SCRAPE từ ChatGPT (task SYNC_BILLING
  hoặc hộp "Quản lý suất"). Chỉ đổi khi chạy sync → có thể CŨ. Không suy ra được
  từ DB, cũng KHÔNG được lấy từ hoá đơn (xem test_seat_total_source.py).
- `seat_used` = ĐẾM LẠI TRONG DB mỗi lần đọc, KHÔNG dùng cột `Workspace.seat_used`
  (scrape, lệch được cả hai chiều: vừa mời thêm chưa kịp sync thì THẤP, vừa xoá bớt
  chưa kịp sync thì CAO). DB là nguồn thật thời gian thực.

`seat_used` đếm member CHƯA bị gỡ = `active` + `pending`: lời mời đang chờ cũng nợ
một suất vì người ta bấm nhận lúc nào cũng được. Riêng guard chặn mời
(`active_used`) chỉ đếm `active` — xem docstring hàm đó.

Nhánh Canva có thêm SUẤT GIỮ CHỖ CHO CHỦ ĐỘI: 50 suất của gói đã kể cả chủ đội, mà
chủ đội chỉ vào bảng `members` sau khi CANVA_SYNC quét trang People. Xem
`owner_reserve_map`.
"""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import PLATFORM_CANVA, Member, Workspace

# Trần overcommit khi mời: cho phép vượt `seat_total` tới +50% rồi mới chặn, vì
# `seat_total` là số scrape có thể cũ — chặn đúng bằng nó sẽ khoá oan lúc admin vừa
# mua thêm suất mà chưa sync.
SEAT_OVERCOMMIT_RATIO = 1.5


def seat_used_map(db: Session, workspace_ids: list[UUID]) -> dict[UUID, int]:
    """workspace_id -> số member CHƯA bị gỡ (active + pending). Một truy vấn gộp.

    Workspace không có member nào vắng mặt trong map trả về — người gọi tự `.get(id, 0)`
    hoặc dùng `seat_used()` cho một workspace.
    """
    if not workspace_ids:
        return {}
    rows = db.execute(
        select(Member.workspace_id, func.count(Member.id))
        .where(Member.workspace_id.in_(workspace_ids), Member.status != "removed")
        .group_by(Member.workspace_id)
    ).all()
    return {wid: int(n) for wid, n in rows}


def seat_used(db: Session, workspace_id: UUID, *, exclude_emails: list[str] | None = None) -> int:
    """Số suất đang bị chiếm ở 1 workspace = member `active` + `pending`.

    `exclude_emails` loại vài email ra khỏi phép đếm — luồng mời cần nó để không
    đếm hai lần chính những email của lệnh mời đang chạy (đếm thừa ⇒ mua thừa suất
    bằng tiền thật, xem `invite._seat_hint`).
    """
    stmt = (
        select(func.count(Member.id))
        .where(Member.workspace_id == workspace_id, Member.status != "removed")
    )
    lowered = [e.strip().lower() for e in (exclude_emails or []) if e]
    if lowered:
        stmt = stmt.where(Member.email.notin_(lowered))
    return int(db.execute(stmt).scalar_one() or 0)


def pending_count(db: Session, workspace_id: UUID, *, exclude_emails: list[str] | None = None) -> int:
    """Riêng số lời mời đang CHỜ nhận. Extension cần tách con số này ra khỏi
    `seat_used` để tính nợ suất khi đối chiếu với "đã gán" của ChatGPT (chỉ đếm
    người ĐÃ tham gia)."""
    stmt = (
        select(func.count(Member.id))
        .where(Member.workspace_id == workspace_id, Member.status == "pending")
    )
    lowered = [e.strip().lower() for e in (exclude_emails or []) if e]
    if lowered:
        stmt = stmt.where(Member.email.notin_(lowered))
    return int(db.execute(stmt).scalar_one() or 0)


def active_used(db: Session, workspace_id: UUID) -> int:
    """Riêng member ĐÃ THAM GIA (`active`) — mẫu số của guard chặn mời.

    Guard cố tình KHÔNG cộng `pending`: lời mời chờ chưa chiếm suất thật trên
    ChatGPT (đo trên production 24/8/2026), cộng vào sẽ chặn oan lúc workspace đang
    có nhiều lời mời treo. Hiển thị thì ngược lại — cộng `pending` cho an toàn.
    """
    return int(
        db.execute(
            select(func.count(Member.id)).where(
                Member.workspace_id == workspace_id, Member.status == "active"
            )
        ).scalar_one()
        or 0
    )


def owner_reserve_map(db: Session, workspaces: list[Workspace]) -> dict[UUID, int]:
    """workspace_id -> suất phải GIỮ CHỖ cho chủ đội Canva (1 hoặc 0).

    Gói Canva có 50 suất và chủ đội ngồi một trong số đó (user chốt 2026-09-01).
    Chủ đội chỉ vào bảng `members` sau khi CANVA_SYNC quét được trang People —
    trước lần sync đầu, hay khi sync hỏng, không giữ chỗ thì dashboard báo thừa
    một suất và guard mời cho tràn thêm một người: Canva từ chối tại chỗ sau khi
    đã trừ tiền khách.

    Trả 0 khi đã có dòng member vai trò `owner` chưa bị gỡ — lúc đó họ nằm sẵn
    trong `seat_used`, cộng thêm nữa là đếm hai lần. Nhánh GPT luôn 0: tổng suất
    bên đó scrape từ billing, chủ đội đã nằm trong danh sách quét về.
    """
    canva_ids = [ws.id for ws in workspaces if ws.platform == PLATFORM_CANVA]
    if not canva_ids:
        return {}
    have_owner = set(
        db.execute(
            select(Member.workspace_id)
            .where(
                Member.workspace_id.in_(canva_ids),
                Member.status != "removed",
                Member.chatgpt_role == "owner",
            )
            .distinct()
        ).scalars()
    )
    return {wid: (0 if wid in have_owner else 1) for wid in canva_ids}


def owner_reserve(db: Session, workspace: Workspace) -> int:
    """Bản một workspace của `owner_reserve_map`."""
    return owner_reserve_map(db, [workspace]).get(workspace.id, 0)


def seat_left(seat_total: int | None, used: int) -> int | None:
    """Suất còn TRỐNG để hiển thị. `None` khi workspace chưa từng sync `seat_total`
    (chưa biết tổng thì không được đoán bừa là 0 — người dùng sẽ tưởng hết suất).
    Âm được kẹp về 0: đang overcommit thì "còn 0", không phải "còn -3"."""
    if seat_total is None:
        return None
    return max(seat_total - used, 0)


def seat_snapshot(db: Session, workspaces: list[Workspace]) -> list[dict]:
    """Ảnh chụp suất của nhiều workspace cho endpoint/hiển thị — hai truy vấn gộp.

    `seat_used` trả về ĐÃ CỘNG suất giữ chỗ của chủ đội Canva, nên có thể lớn hơn số
    dòng trong bảng thành viên đúng 1 — chủ đội là người chiếm suất thật nhưng chưa
    chắc đã nằm trong danh sách quét về.
    """
    used = seat_used_map(db, [ws.id for ws in workspaces])
    reserve = owner_reserve_map(db, workspaces)
    out: list[dict] = []
    for ws in workspaces:
        u = used.get(ws.id, 0) + reserve.get(ws.id, 0)
        out.append(
            {
                "workspace_id": str(ws.id),
                "name": ws.name,
                "platform": ws.platform,
                "seat_total": ws.seat_total,
                "seat_used": u,
                "seat_left": seat_left(ws.seat_total, u),
            }
        )
    return out
