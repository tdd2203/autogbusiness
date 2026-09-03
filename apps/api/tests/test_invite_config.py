"""Cấu hình đích mời theo user (nút ⚙️ trang Mời thành viên).

Phủ: GET liệt kê sub-admin + mặc định, PUT "Chỉ định" reconcile assignment (dùng chung
bảng với màn Assign), PUT "Toàn bộ" set cờ, chuyển chế độ, bỏ chọn hết để TẠM NGƯNG,
gate super-admin, chặn cấu hình super-admin, và cờ invite_all_workspaces cho phép truy
cập mọi workspace.
"""

from uuid import UUID

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.deps import user_can_access_workspace
from app.models import User


def _sub_admin(client: TestClient, auth_header: dict, *, n: str = "sub") -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": f"{n}@example.com",
            "username": n,
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE"],
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    login = client.post(
        "/api/v1/auth/login", json={"identifier": n, "password": "SubPassword123!"}
    )
    return {"id": resp.json()["id"], "token": login.json()["access_token"]}


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _create_ws(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post("/api/v1/workspaces", json={"name": name}, headers=auth_header)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _config_of(client: TestClient, auth_header: dict, user_id: str) -> dict:
    rows = client.get("/api/v1/invite-config/users", headers=auth_header).json()
    return next(r for r in rows if r["user_id"] == user_id)


# ---------- GET defaults ----------


def test_list_defaults(client: TestClient, auth_header: dict) -> None:
    sub = _sub_admin(client, auth_header)
    row = _config_of(client, auth_header, sub["id"])
    assert row["all_workspaces"] is False
    assert row["workspace_ids"] == []


# ---------- PUT "Chỉ định" reconcile ----------


def test_specific_reconcile_add_and_remove(client: TestClient, auth_header: dict) -> None:
    ws1 = _create_ws(client, auth_header, "WS 1")
    ws2 = _create_ws(client, auth_header, "WS 2")
    sub = _sub_admin(client, auth_header)

    # Gán ws1 + ws2
    resp = client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": [ws1["id"], ws2["id"]]},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    row = _config_of(client, auth_header, sub["id"])
    assert set(row["workspace_ids"]) == {ws1["id"], ws2["id"]}

    # Dùng chung bảng với màn Assign: /assignments cũng thấy sub trong ws1
    assigns = client.get(
        f"/api/v1/workspaces/{ws1['id']}/assignments", headers=auth_header
    ).json()
    assert any(a["user_id"] == sub["id"] for a in assigns)

    # Bỏ ws2 → chỉ còn ws1
    client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": [ws1["id"]]},
        headers=auth_header,
    )
    row = _config_of(client, auth_header, sub["id"])
    assert set(row["workspace_ids"]) == {ws1["id"]}


def test_clear_all_pauses_invite(client: TestClient, auth_header: dict) -> None:
    """Bỏ chọn hết workspace = tạm ngưng: hết assignment, `/targets` rỗng nên trang
    Mời hiện thông báo tạm ngưng thay vì cho add email mới."""
    ws1 = _create_ws(client, auth_header, "WS Pause")
    sub = _sub_admin(client, auth_header)
    client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": [ws1["id"]]},
        headers=auth_header,
    )

    resp = client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": []},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["workspace_ids"] == []

    row = _config_of(client, auth_header, sub["id"])
    assert row["all_workspaces"] is False
    assert row["workspace_ids"] == []

    targets = client.get(
        "/api/v1/auto-invite/targets", headers=_bearer(sub["token"])
    ).json()
    assert targets["all_workspaces"] is False
    assert targets["workspaces"] == []

    db = SessionLocal()
    try:
        u = db.get(User, UUID(sub["id"]))
        assert not user_can_access_workspace(db, u, UUID(ws1["id"]))
    finally:
        db.close()


# ---------- PUT "Toàn bộ" ----------


def test_all_workspaces_flag_and_access(client: TestClient, auth_header: dict) -> None:
    ws1 = _create_ws(client, auth_header, "WS A")
    ws2 = _create_ws(client, auth_header, "WS B")
    sub = _sub_admin(client, auth_header)

    resp = client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": True, "workspace_ids": []},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    row = _config_of(client, auth_header, sub["id"])
    assert row["all_workspaces"] is True

    # Cờ cho phép truy cập MỌI workspace dù không có record assignment.
    db = SessionLocal()
    try:
        u = db.get(User, UUID(sub["id"]))
        assert user_can_access_workspace(db, u, UUID(ws1["id"]))
        assert user_can_access_workspace(db, u, UUID(ws2["id"]))
    finally:
        db.close()


def test_switch_all_to_specific_clears_flag(client: TestClient, auth_header: dict) -> None:
    ws1 = _create_ws(client, auth_header, "WS X")
    sub = _sub_admin(client, auth_header)
    client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": True, "workspace_ids": []},
        headers=auth_header,
    )
    client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": [ws1["id"]]},
        headers=auth_header,
    )
    row = _config_of(client, auth_header, sub["id"])
    assert row["all_workspaces"] is False
    assert set(row["workspace_ids"]) == {ws1["id"]}


# ---------- Guards ----------


def test_sub_admin_forbidden(client: TestClient, auth_header: dict) -> None:
    sub = _sub_admin(client, auth_header)
    assert client.get(
        "/api/v1/invite-config/users", headers=_bearer(sub["token"])
    ).status_code == 403
    assert client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": True, "workspace_ids": []},
        headers=_bearer(sub["token"]),
    ).status_code == 403


def test_cannot_configure_super_admin(client: TestClient, auth_header: dict) -> None:
    me = client.get("/api/v1/auth/me", headers=auth_header).json()
    resp = client.put(
        f"/api/v1/invite-config/users/{me['id']}",
        json={"all_workspaces": True, "workspace_ids": []},
        headers=auth_header,
    )
    assert resp.status_code == 400, resp.text
