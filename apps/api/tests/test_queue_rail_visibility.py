"""Queue panel visibility — panel "Hàng đợi tác vụ" (WorkspaceTaskRail).

Đổi 2026-06-17: khi list theo `workspace_id`, sub-admin (đã được gán workspace)
thấy TOÀN BỘ task của workspace đó để theo dõi thứ tự chạy tuần tự — nhưng:
  - `created_by_username` chỉ super-admin thấy (ẩn danh tính với sub-admin),
  - `can_cancel` = super OR người tạo (UI ẩn/hiện nút Huỷ).
Queue toàn cục (không workspace_id) giữ own-only cho sub-admin.
"""

from fastapi.testclient import TestClient


def _login_token(client: TestClient, identifier: str, password: str) -> str:
    resp = client.post(
        "/api/v1/auth/login", json={"identifier": identifier, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _create_ws(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces", json={"name": name}, headers=auth_header
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _sub(client: TestClient, auth_header: dict, perms: list[str], *, n: str = "sub") -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": f"{n}@example.com",
            "username": n,
            "password": "SubPassword123!",
            "permissions": perms,
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    user = resp.json()
    token = _login_token(client, n, "SubPassword123!")
    return {"id": user["id"], "token": token}


def _assign(client: TestClient, auth_header: dict, ws_id: str, user_id: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text


def _create_task(client: TestClient, headers: dict, ws_id: str, ttype: str) -> dict:
    resp = client.post(
        "/api/v1/queue",
        json={"type": ttype, "payload": {}, "workspace_id": ws_id},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


_SUB_PERMS = ["MEMBER_VIEW", "QUEUE_VIEW", "WORKSPACE_SYNC_TRIGGER"]


def test_sub_admin_sees_all_workspace_tasks_but_anonymized(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_ws(client, auth_header, "Rail WS")
    sub = _sub(client, auth_header, _SUB_PERMS)
    _assign(client, auth_header, ws["id"], sub["id"])

    by_super = _create_task(client, auth_header, ws["id"], "SYNC_DATA")
    by_sub = _create_task(client, _bearer(sub["token"]), ws["id"], "SYNC_DATA")

    listing = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}", headers=_bearer(sub["token"])
    )
    assert listing.status_code == 200, listing.text
    rows = {r["id"]: r for r in listing.json()}

    # Sub-admin thấy CẢ HAI task (toàn workspace), không chỉ task mình tạo.
    assert by_super["id"] in rows
    assert by_sub["id"] in rows

    # Danh tính người tạo bị ẩn với sub-admin.
    assert rows[by_super["id"]]["created_by_username"] is None
    assert rows[by_sub["id"]]["created_by_username"] is None

    # can_cancel: chỉ task do chính sub tạo.
    assert rows[by_sub["id"]]["can_cancel"] is True
    assert rows[by_super["id"]]["can_cancel"] is False


def test_super_admin_sees_creator_and_can_cancel_all(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_ws(client, auth_header, "Rail WS Super")
    sub = _sub(client, auth_header, _SUB_PERMS)
    _assign(client, auth_header, ws["id"], sub["id"])

    by_sub = _create_task(client, _bearer(sub["token"]), ws["id"], "SYNC_DATA")

    listing = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}", headers=auth_header
    )
    assert listing.status_code == 200, listing.text
    row = next(r for r in listing.json() if r["id"] == by_sub["id"])

    # Super-admin thấy ai tạo + huỷ được mọi task.
    assert row["created_by_username"] == "sub"
    assert row["can_cancel"] is True


def test_sub_admin_unassigned_workspace_queue_404(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_ws(client, auth_header, "Locked Rail WS")
    sub = _sub(client, auth_header, _SUB_PERMS)
    # KHÔNG gán workspace → không được dò task của workspace lạ.
    resp = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}", headers=_bearer(sub["token"])
    )
    assert resp.status_code == 404, resp.text


def test_global_queue_sub_admin_sees_own_only(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_ws(client, auth_header, "Global WS")
    sub = _sub(client, auth_header, _SUB_PERMS)
    _assign(client, auth_header, ws["id"], sub["id"])

    by_super = _create_task(client, auth_header, ws["id"], "SYNC_DATA")
    by_sub = _create_task(client, _bearer(sub["token"]), ws["id"], "SYNC_DATA")

    # Queue toàn cục (không workspace_id): sub chỉ thấy task mình tạo.
    listing = client.get("/api/v1/queue", headers=_bearer(sub["token"]))
    assert listing.status_code == 200, listing.text
    ids = {r["id"] for r in listing.json()}
    assert by_sub["id"] in ids
    assert by_super["id"] not in ids


def test_sub_admin_cannot_cancel_others_task(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_ws(client, auth_header, "Cancel WS")
    sub = _sub(client, auth_header, _SUB_PERMS)
    _assign(client, auth_header, ws["id"], sub["id"])

    by_super = _create_task(client, auth_header, ws["id"], "SYNC_DATA")
    # Sub thấy task nhưng KHÔNG huỷ được task người khác tạo.
    resp = client.post(
        f"/api/v1/queue/{by_super['id']}/cancel", headers=_bearer(sub["token"])
    )
    assert resp.status_code == 403, resp.text
