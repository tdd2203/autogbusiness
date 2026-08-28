"""SUẤT CÒN TRỐNG — một nguồn duy nhất, ai đọc cũng ra cùng con số.

Trang Mời thành viên hiện "còn N suất" để người dùng biết TRƯỚC khi add: hết chỗ
mà vẫn mời thì extension đi mua thêm suất trên ChatGPT bằng tiền thật, giá do
ChatGPT quyết. Nên con số này phải đếm lại trong DB mỗi lần đọc, và bốn nơi hiển
thị (`/workspaces/seats`, list workspace, member stats, `/auto-invite/targets`)
không được phép nói bốn số khác nhau.
"""

import uuid

from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_user,
    create_ws,
    login,
)


def _set_seat_total(ws_id: str, total: int | None) -> None:
    """Ghi thẳng `seat_total` (đời thật do task SYNC_BILLING scrape về)."""
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        ws = db.get(Workspace, uuid.UUID(ws_id))
        ws.seat_total = total
        db.commit()


def _add_member(ws_id: str, email: str, status: str) -> None:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        db.add(Member(workspace_id=uuid.UUID(ws_id), email=email, status=status))
        db.commit()


def _seats(client: TestClient, header: dict, ws_id: str) -> dict:
    r = client.get("/api/v1/workspaces/seats", headers=header)
    assert r.status_code == 200, r.text
    rows = [x for x in r.json() if x["workspace_id"] == ws_id]
    assert rows, r.text
    return rows[0]


def test_suat_trong_tru_ca_loi_moi_dang_cho(client: TestClient, auth_header: dict):
    """Lời mời đang CHỜ cũng đang nợ một suất → phải trừ vào chỗ trống.

    Đếm thiếu ở đây là mời mù vào chỗ không có: extension mở hộp "Mua suất người
    dùng và gửi lời mời" và tiêu tiền thật.
    """
    ws = create_ws(client, auth_header, "SEAT-WS")
    _set_seat_total(ws["id"], 3)
    _add_member(ws["id"], "a@example.com", "active")
    _add_member(ws["id"], "b@example.com", "pending")
    _add_member(ws["id"], "c@example.com", "removed")

    row = _seats(client, auth_header, ws["id"])
    assert row["seat_total"] == 3
    # active + pending = 2; email đã gỡ KHÔNG chiếm suất.
    assert row["seat_used"] == 2
    assert row["seat_left"] == 1


def test_chua_dong_bo_tong_suat_thi_con_lai_la_none(
    client: TestClient, auth_header: dict
):
    """`seat_total = None` (chưa từng sync) → `seat_left = None`, KHÔNG phải 0.

    Trả 0 là nói "hết suất" cho một workspace có thể đang trống trơn — người dùng
    tưởng phải mua thêm.
    """
    ws = create_ws(client, auth_header, "NEVER-SYNCED")
    _add_member(ws["id"], "a@example.com", "active")

    row = _seats(client, auth_header, ws["id"])
    assert row["seat_total"] is None
    assert row["seat_used"] == 1
    assert row["seat_left"] is None


def test_dung_suat_thi_con_lai_kep_ve_0(client: TestClient, auth_header: dict):
    """Đang dùng vượt tổng (overcommit) → "còn 0", không phải số âm."""
    ws = create_ws(client, auth_header, "OVER")
    _set_seat_total(ws["id"], 1)
    _add_member(ws["id"], "a@example.com", "active")
    _add_member(ws["id"], "b@example.com", "active")

    row = _seats(client, auth_header, ws["id"])
    assert row["seat_used"] == 2
    assert row["seat_left"] == 0


def test_bon_noi_hien_suat_cung_mot_con_so(client: TestClient, auth_header: dict):
    """`/seats`, list workspace, member stats và `/auto-invite/targets` khớp nhau.

    Cột `Workspace.seat_used` scrape được cố tình ĐẶT SAI ở đây (99) để bắt bất kỳ
    nhánh nào lỡ đọc thẳng cột đó thay vì đếm lại trong DB — đúng ca 2026-07-08
    (dashboard in "44/35" vì scrape cũ chưa refresh sau khi xoá 3 người).
    """
    ws = create_ws(client, auth_header, "AGREE")
    _set_seat_total(ws["id"], 10)
    for i in range(4):
        _add_member(ws["id"], f"m{i}@example.com", "active")
    _add_member(ws["id"], "p@example.com", "pending")

    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws["id"]))
        row.seat_used = 99
        db.commit()

    seats = _seats(client, auth_header, ws["id"])
    assert (seats["seat_used"], seats["seat_left"]) == (5, 5)

    listed = [
        x
        for x in client.get("/api/v1/workspaces", headers=auth_header).json()
        if x["id"] == ws["id"]
    ][0]
    assert listed["seat_used"] == 5

    stats = client.get(
        f"/api/v1/workspaces/{ws['id']}/members/stats", headers=auth_header
    ).json()
    assert (stats["seat_used"], stats["seat_left"]) == (5, 5)

    targets = client.get("/api/v1/auto-invite/targets", headers=auth_header).json()
    target = [x for x in targets["workspaces"] if x["workspace_id"] == ws["id"]]
    # Super-admin chỉ được 1 workspace đích (cũ nhất) — có mặt thì phải khớp.
    if target:
        assert (target[0]["seat_used"], target[0]["seat_left"]) == (5, 5)


def test_suat_tuoi_ngay_sau_khi_go_thanh_vien(client: TestClient, auth_header: dict):
    """Gỡ người xong đọc lại là thấy chỗ trống ngay, không chờ SYNC_BILLING."""
    ws = create_ws(client, auth_header, "FRESH")
    _set_seat_total(ws["id"], 5)
    _add_member(ws["id"], "a@example.com", "active")
    _add_member(ws["id"], "b@example.com", "active")
    assert _seats(client, auth_header, ws["id"])["seat_left"] == 3

    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.query(Member).filter(Member.email == "b@example.com").one()
        m.status = "removed"
        db.commit()

    assert _seats(client, auth_header, ws["id"])["seat_left"] == 4


def test_sub_admin_chi_thay_suat_workspace_duoc_gan(
    client: TestClient, auth_header: dict
):
    """Sub-admin thường chỉ thấy suất của workspace được gán."""
    mine = create_ws(client, auth_header, "MINE")
    other = create_ws(client, auth_header, "OTHER")
    user = create_user(client, auth_header, "seatsub", ["MEMBER_VIEW"])
    assign(client, auth_header, mine["id"], user["id"])
    header = bearer(login(client, "seatsub"))

    ids = {x["workspace_id"] for x in client.get(
        "/api/v1/workspaces/seats", headers=header
    ).json()}
    assert mine["id"] in ids
    assert other["id"] not in ids


def test_user_duoc_moi_moi_noi_thay_suat_moi_workspace(
    client: TestClient, auth_header: dict
):
    """User có cờ `invite_all_workspaces` add email được vào MỌI workspace nên phải
    thấy suất của mọi workspace — dù chưa được gán cái nào. Thiếu chỗ này thì trang
    Mời hiện "chưa biết tổng suất" cho đúng người dùng nó nhiều nhất."""
    ws = create_ws(client, auth_header, "ANYWHERE")
    _set_seat_total(ws["id"], 7)
    user = create_user(client, auth_header, "allws", ["MEMBER_VIEW", "MEMBER_INVITE"])

    from app.db import SessionLocal
    from app.models import User

    with SessionLocal() as db:
        row = db.get(User, uuid.UUID(user["id"]))
        row.invite_all_workspaces = True
        db.commit()

    header = bearer(login(client, "allws"))
    rows = client.get("/api/v1/workspaces/seats", headers=header).json()
    row = [x for x in rows if x["workspace_id"] == ws["id"]]
    assert row and row[0]["seat_left"] == 7


def test_seats_khong_nuot_thanh_uuid_hong(client: TestClient, auth_header: dict):
    """`/seats` phải khai báo TRƯỚC `/{workspace_id}`, nếu không FastAPI cố ép
    "seats" thành UUID → 422 thay vì trả danh sách."""
    r = client.get("/api/v1/workspaces/seats", headers=auth_header)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)
