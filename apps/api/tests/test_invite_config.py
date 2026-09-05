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


# ---------- Ranh giới nhánh ChatGPT / Canva ----------


def _canva_ws(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces", json={"name": name, "platform": "canva"}, headers=auth_header
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_saving_gpt_config_keeps_canva_targets(
    client: TestClient, auth_header: dict
) -> None:
    """Lưu cấu hình nhánh ChatGPT KHÔNG được gỡ đích Canva của đại lý.

    Màn hình ChatGPT không bày team Canva ra để tick, nên nếu lượt lưu tính cả nhánh
    kia là "bỏ chọn" thì mỗi lần chỉnh ChatGPT là đại lý mất sạch Canva và trang Mời
    Canva báo tạm ngưng (sự cố 3/9/2026).
    """
    gpt1 = _create_ws(client, auth_header, "GPT 1")
    gpt2 = _create_ws(client, auth_header, "GPT 2")
    canva = _canva_ws(client, auth_header, "Canva Team")
    sub = _sub_admin(client, auth_header, n="hai-nhanh")

    # Cấp Canva ở nhánh Canva, cấp GPT 1 ở nhánh ChatGPT.
    assert client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={
            "all_workspaces": False,
            "workspace_ids": [canva["id"]],
            "platform": "canva",
        },
        headers=auth_header,
    ).status_code == 200
    assert client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": [gpt1["id"]], "platform": "gpt"},
        headers=auth_header,
    ).status_code == 200

    # Đổi đích ChatGPT sang GPT 2 — Canva phải còn nguyên.
    resp = client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": [gpt2["id"]], "platform": "gpt"},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert set(resp.json()["workspace_ids"]) == {gpt2["id"]}

    rows = client.get(
        "/api/v1/invite-config/users?platform=canva", headers=auth_header
    ).json()
    canva_row = next(r for r in rows if r["user_id"] == sub["id"])
    assert set(canva_row["workspace_ids"]) == {canva["id"]}, "đích Canva bị gỡ oan"

    # Trang Mời nhánh Canva của đại lý phải thấy lại đích đó.
    targets = client.get(
        "/api/v1/auto-invite/targets?platform=canva", headers=_bearer(sub["token"])
    ).json()
    assert [w["workspace_id"] for w in targets["workspaces"]] == [canva["id"]]


def test_gpt_config_only_lists_gpt_targets(client: TestClient, auth_header: dict) -> None:
    """Đọc cấu hình một nhánh chỉ trả đích của nhánh đó — id lạc nhánh gửi lên bị bỏ."""
    canva = _canva_ws(client, auth_header, "Canva Team 2")
    sub = _sub_admin(client, auth_header, n="loc-nhanh")

    resp = client.put(
        f"/api/v1/invite-config/users/{sub['id']}",
        json={"all_workspaces": False, "workspace_ids": [canva["id"]], "platform": "gpt"},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["workspace_ids"] == []
    assert _config_of(client, auth_header, sub["id"])["workspace_ids"] == []
