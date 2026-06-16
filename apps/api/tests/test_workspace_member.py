"""Tuần 2 — Workspace, Member, visibility, per-workspace API key."""

from fastapi.testclient import TestClient

from .conftest import SUPER_ADMIN_PASSWORD, SUPER_ADMIN_USERNAME


def _create_sub_admin(
    client: TestClient,
    auth_header: dict,
    *,
    email: str,
    username: str,
    permissions: list[str],
) -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": email,
            "username": username,
            "password": "SubPassword123!",
            "permissions": permissions,
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login_token(client: TestClient, identifier: str, password: str) -> str:
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": identifier, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------- Workspace ----------


def test_super_admin_can_create_workspace_and_get_api_key(
    client: TestClient, auth_header: dict
) -> None:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Test Workspace", "plan": "business", "seat_total": 25},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Test Workspace"
    assert "extension_api_key" in body
    assert len(body["extension_api_key"]) > 20


def test_sub_admin_cannot_create_workspace(
    client: TestClient, auth_header: dict
) -> None:
    _create_sub_admin(
        client,
        auth_header,
        email="subws@example.com",
        username="subws",
        permissions=["MEMBER_VIEW"],
    )
    sub_token = _login_token(client, "subws", "SubPassword123!")

    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Hacked WS"},
        headers=_bearer(sub_token),
    )
    assert resp.status_code == 403


def test_create_user_without_email_synthesizes(
    client: TestClient, auth_header: dict
) -> None:
    """Tạo tài khoản phụ chỉ với username + password (không gửi email) → backend
    tự sinh email nội bộ; login bằng username vẫn hoạt động."""
    resp = client.post(
        "/api/v1/users",
        json={
            "username": "noemailuser",
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW"],
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["username"] == "noemailuser"
    assert body["email"].endswith("@no-email.local")
    # Đăng nhập bằng username vẫn được
    login = client.post(
        "/api/v1/auth/login",
        json={"identifier": "noemailuser", "password": "SubPassword123!"},
    )
    assert login.status_code == 200, login.text


def test_regenerate_api_key_changes_key(client: TestClient, auth_header: dict) -> None:
    create_resp = client.post(
        "/api/v1/workspaces",
        json={"name": "WS Regen"},
        headers=auth_header,
    )
    ws_id = create_resp.json()["id"]
    old_key = create_resp.json()["extension_api_key"]

    regen_resp = client.post(
        f"/api/v1/workspaces/{ws_id}/regenerate-key", headers=auth_header
    )
    assert regen_resp.status_code == 200
    new_key = regen_resp.json()["extension_api_key"]
    assert new_key != old_key


def test_workspace_settings_auto_created(client: TestClient, auth_header: dict) -> None:
    create_resp = client.post(
        "/api/v1/workspaces", json={"name": "WS Set"}, headers=auth_header
    )
    ws_id = create_resp.json()["id"]

    settings_resp = client.get(
        f"/api/v1/workspaces/{ws_id}/settings", headers=auth_header
    )
    assert settings_resp.status_code == 200
    s = settings_resp.json()
    assert s["rate_limit_invite_ms"] == 5000
    assert s["dry_run_mode"] is False


# ---------- Member visibility ----------


def _setup_ws_and_sub_admin(client: TestClient, auth_header: dict) -> tuple[str, str, str]:
    """Trả về (workspace_id, sub_admin_id, sub_admin_token)."""
    ws_resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Visibility WS"},
        headers=auth_header,
    )
    ws_id = ws_resp.json()["id"]

    sub = _create_sub_admin(
        client,
        auth_header,
        email="subview@example.com",
        username="subview",
        permissions=["MEMBER_VIEW", "MEMBER_INVITE", "MEMBER_REMOVE"],
    )
    # Gán workspace cho sub-admin (bắt buộc kể từ workspace-assignment RBAC).
    assign = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    assert assign.status_code == 201, assign.text
    sub_token = _login_token(client, "subview", "SubPassword123!")
    return ws_id, sub["id"], sub_token


def test_sub_admin_sees_only_own_invites(
    client: TestClient, auth_header: dict
) -> None:
    ws_id, sub_id, sub_token = _setup_ws_and_sub_admin(client, auth_header)

    client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "by-super@example.com", "role": "member"},
        headers=auth_header,
    )
    client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "by-sub@example.com", "role": "member"},
        headers=_bearer(sub_token),
    )

    super_list = client.get(
        f"/api/v1/workspaces/{ws_id}/members", headers=auth_header
    ).json()
    assert len(super_list) == 2

    sub_list = client.get(
        f"/api/v1/workspaces/{ws_id}/members", headers=_bearer(sub_token)
    ).json()
    assert len(sub_list) == 1
    assert sub_list[0]["email"] == "by-sub@example.com"
    assert sub_list[0]["invited_by_user_id"] == sub_id


def test_sub_admin_cannot_remove_member_invited_by_super(
    client: TestClient, auth_header: dict
) -> None:
    ws_id, _, sub_token = _setup_ws_and_sub_admin(client, auth_header)

    inv = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "by-super2@example.com", "role": "member"},
        headers=auth_header,
    ).json()
    member_id = inv["id"]

    resp = client.delete(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}",
        headers=_bearer(sub_token),
    )
    assert resp.status_code == 404


def test_sub_admin_cannot_change_role(client: TestClient, auth_header: dict) -> None:
    ws_id, _, sub_token = _setup_ws_and_sub_admin(client, auth_header)

    inv = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "role-target@example.com", "role": "member"},
        headers=_bearer(sub_token),
    ).json()
    member_id = inv["id"]

    resp = client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/role",
        json={"new_role": "admin"},
        headers=_bearer(sub_token),
    )
    assert resp.status_code == 403


def test_invite_creates_queue_item_with_workspace_id(
    client: TestClient, auth_header: dict
) -> None:
    ws_id = client.post(
        "/api/v1/workspaces", json={"name": "Queue WS"}, headers=auth_header
    ).json()["id"]

    client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "queueable@example.com", "role": "member"},
        headers=auth_header,
    )

    queue_resp = client.get("/api/v1/queue?limit=10", headers=auth_header)
    items = queue_resp.json()
    invites = [i for i in items if i["type"] == "INVITE_MEMBER"]
    assert len(invites) == 1
    assert invites[0]["workspace_id"] == ws_id
    assert invites[0]["payload"]["email"] == "queueable@example.com"


# ---------- Per-workspace API key (extension auth) ----------


def test_extension_bulk_upsert_requires_correct_workspace_key(
    client: TestClient, auth_header: dict
) -> None:
    ws_a = client.post(
        "/api/v1/workspaces", json={"name": "WS A"}, headers=auth_header
    ).json()
    ws_b = client.post(
        "/api/v1/workspaces", json={"name": "WS B"}, headers=auth_header
    ).json()

    payload = {"members": [{"email": "scraped@example.com", "name": "Scraped User"}]}

    # No key → 401
    no_key = client.post(
        f"/api/v1/workspaces/{ws_a['id']}/members/bulk-upsert", json=payload
    )
    assert no_key.status_code == 401

    # Wrong key → 401
    bad_key = client.post(
        f"/api/v1/workspaces/{ws_a['id']}/members/bulk-upsert",
        json=payload,
        headers={"X-API-KEY": "totally-wrong"},
    )
    assert bad_key.status_code == 401

    # Key của WS B nhưng URL là WS A → 403
    mismatch = client.post(
        f"/api/v1/workspaces/{ws_a['id']}/members/bulk-upsert",
        json=payload,
        headers={"X-API-KEY": ws_b["extension_api_key"]},
    )
    assert mismatch.status_code == 403

    # Đúng key + đúng URL → 200
    ok = client.post(
        f"/api/v1/workspaces/{ws_a['id']}/members/bulk-upsert",
        json=payload,
        headers={"X-API-KEY": ws_a["extension_api_key"]},
    )
    assert ok.status_code == 200
    assert ok.json()["created"] == 1


def test_extension_queue_next_isolated_per_workspace(
    client: TestClient, auth_header: dict
) -> None:
    ws_a = client.post(
        "/api/v1/workspaces", json={"name": "Iso A"}, headers=auth_header
    ).json()
    ws_b = client.post(
        "/api/v1/workspaces", json={"name": "Iso B"}, headers=auth_header
    ).json()

    # Tạo invite (= QueueItem) trong WS A
    client.post(
        f"/api/v1/workspaces/{ws_a['id']}/members/invite",
        json={"email": "iso@example.com", "role": "member"},
        headers=auth_header,
    )

    # Extension WS B poll → null
    b_pick = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": ws_b["extension_api_key"]}
    )
    assert b_pick.status_code == 200
    assert b_pick.json() is None

    # Extension WS A poll → có task
    a_pick = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": ws_a["extension_api_key"]}
    )
    assert a_pick.status_code == 200
    body = a_pick.json()
    assert body is not None
    assert body["workspace_id"] == ws_a["id"]
    assert body["status"] == "IN_PROGRESS"


def test_bulk_upsert_marks_invited_by_null_for_new_members(
    client: TestClient, auth_header: dict
) -> None:
    ws = client.post(
        "/api/v1/workspaces", json={"name": "Bulk WS"}, headers=auth_header
    ).json()

    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": "stranger@example.com", "name": "Stranger", "chatgpt_role": "member"}
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    # Super-admin thấy được
    super_list = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    assert len(super_list) == 1
    assert super_list[0]["invited_by_user_id"] is None

    # Sub-admin (chưa có MEMBER_VIEW grant ở đây nhưng nếu có) → không thấy
    sub = _create_sub_admin(
        client,
        auth_header,
        email="bulkview@example.com",
        username="bulkview",
        permissions=["MEMBER_VIEW"],
    )
    client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    sub_token = _login_token(client, "bulkview", "SubPassword123!")
    sub_list = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=_bearer(sub_token)
    ).json()
    assert len(sub_list) == 0
