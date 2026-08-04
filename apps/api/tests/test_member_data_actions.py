"""Xuất dữ liệu / Xoá dữ liệu 1 member — POST /members/{id}/export-data | delete-data.

Xác minh (xem `app/routers/members/data_actions.md`):
  - Super-admin bấm → 1 task EXPORT_MEMBER_DATA / DELETE_MEMBER_DATA, payload có
    member_id + email.
  - Bấm lại khi task cũ còn mở → `already_queued`, KHÔNG tạo task thứ 2.
  - Member chưa tham gia (pending) → 400 (2 mục menu này chỉ có ở tab Người dùng).
  - Tài khoản phụ MẶC ĐỊNH không có quyền → 403 (quyền không nằm trong perms mặc
    định, không backfill). Cấp quyền tay → dùng được.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Data Actions WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upsert(client: TestClient, ws: dict, email: str, status: str = "active") -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": email,
                    "name": email.split("@")[0],
                    "chatgpt_role": "member",
                    "status": status,
                }
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _member_id(client: TestClient, ws_id: str, headers: dict, email: str) -> str:
    resp = client.get(f"/api/v1/workspaces/{ws_id}/members", headers=headers)
    assert resp.status_code == 200, resp.text
    return next(m["id"] for m in resp.json() if m["email"] == email)


def _tasks(client: TestClient, ws_id: str, headers: dict, task_type: str) -> list[dict]:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return [t for t in resp.json() if t["type"] == task_type]


def _login_token(client: TestClient, username: str, password: str) -> str:
    resp = client.post(
        "/api/v1/auth/login", json={"identifier": username, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _create_sub_admin(
    client: TestClient, auth_header: dict, name: str, perms: list[str]
) -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": f"{name}@example.com",
            "username": name,
            "password": "SubPassword123!",
            "permissions": perms,
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return {
        "id": resp.json()["id"],
        "token": _login_token(client, name, "SubPassword123!"),
    }


def test_export_data_enqueues_task(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert(client, ws, "a@example.com")
    mid = _member_id(client, ws["id"], auth_header, "a@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/export-data", headers=auth_header
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == "queued"

    tasks = _tasks(client, ws["id"], auth_header, "EXPORT_MEMBER_DATA")
    assert len(tasks) == 1
    assert tasks[0]["payload"]["email"] == "a@example.com"
    assert tasks[0]["payload"]["member_id"] == mid


def test_delete_data_enqueues_task(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert(client, ws, "b@example.com")
    mid = _member_id(client, ws["id"], auth_header, "b@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/delete-data", headers=auth_header
    )
    assert resp.status_code == 202, resp.text
    tasks = _tasks(client, ws["id"], auth_header, "DELETE_MEMBER_DATA")
    assert len(tasks) == 1
    assert tasks[0]["payload"]["email"] == "b@example.com"


def test_second_click_while_task_open_is_idempotent(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert(client, ws, "c@example.com")
    mid = _member_id(client, ws["id"], auth_header, "c@example.com")

    first = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/delete-data", headers=auth_header
    )
    assert first.json()["status"] == "queued"
    second = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/delete-data", headers=auth_header
    )
    assert second.status_code == 202, second.text
    assert second.json()["status"] == "already_queued"
    assert len(_tasks(client, ws["id"], auth_header, "DELETE_MEMBER_DATA")) == 1


def test_pending_member_rejected(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert(client, ws, "d@example.com", status="pending")
    mid = _member_id(client, ws["id"], auth_header, "d@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/export-data", headers=auth_header
    )
    assert resp.status_code == 400, resp.text
    assert _tasks(client, ws["id"], auth_header, "EXPORT_MEMBER_DATA") == []


def test_sub_admin_denied_by_default_and_allowed_once_granted(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert(client, ws, "e@example.com")
    mid = _member_id(client, ws["id"], auth_header, "e@example.com")

    # Quyền "mặc định" của tài khoản phụ (khớp DEFAULT_SUB_ADMIN_PERMS ở web) —
    # KHÔNG gồm 2 quyền dữ liệu ⇒ 403 cho cả xuất lẫn xoá.
    sub = _create_sub_admin(
        client,
        auth_header,
        "subdata",
        ["MEMBER_VIEW", "MEMBER_INVITE", "MEMBER_REMOVE", "QUEUE_VIEW"],
    )
    sub_header = {"Authorization": f"Bearer {sub['token']}"}
    for path in ("export-data", "delete-data"):
        resp = client.post(
            f"/api/v1/workspaces/{ws['id']}/members/{mid}/{path}", headers=sub_header
        )
        assert resp.status_code == 403, resp.text

    # Super-admin cấp tay MEMBER_EXPORT_DATA → xuất được, xoá vẫn 403.
    granted = _create_sub_admin(
        client,
        auth_header,
        "subexport",
        ["MEMBER_VIEW", "MEMBER_EXPORT_DATA"],
    )
    granted_header = {"Authorization": f"Bearer {granted['token']}"}
    # Member do super-admin tạo (invited_by_user_id=None) → visibility filter của
    # sub-admin không thấy ⇒ 404, KHÔNG phải 403: quyền đã qua, chỉ là không thấy
    # member của người khác.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/export-data",
        headers=granted_header,
    )
    assert resp.status_code == 404, resp.text
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/delete-data",
        headers=granted_header,
    )
    assert resp.status_code == 403, resp.text
