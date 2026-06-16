"""Workspace assignment RBAC — gán quyền sở hữu workspace cho sub-admin.

Phủ: visibility list workspace, access guard member endpoints, idempotent
assign/unassign, chặn gán super-admin, seat guard khi mời, stats endpoint.
"""

from fastapi.testclient import TestClient


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
        "/api/v1/auth/login", json={"identifier": identifier, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _create_ws(client: TestClient, auth_header: dict, name: str, **extra) -> dict:
    resp = client.post(
        "/api/v1/workspaces", json={"name": name, **extra}, headers=auth_header
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _assign(client: TestClient, auth_header: dict, ws_id: str, user_id: str):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id},
        headers=auth_header,
    )


def _sub(client: TestClient, auth_header: dict, perms: list[str], *, n: str = "sub") -> dict:
    user = _create_sub_admin(
        client, auth_header, email=f"{n}@example.com", username=n, permissions=perms
    )
    token = _login_token(client, n, "SubPassword123!")
    return {"id": user["id"], "token": token}


# ---------- Visibility ----------


def test_sub_admin_only_sees_assigned_workspaces(
    client: TestClient, auth_header: dict
) -> None:
    ws1 = _create_ws(client, auth_header, "WS One")
    _create_ws(client, auth_header, "WS Two")
    sub = _sub(client, auth_header, ["MEMBER_VIEW"])

    _assign(client, auth_header, ws1["id"], sub["id"])

    # Super-admin thấy cả 2
    super_list = client.get("/api/v1/workspaces", headers=auth_header).json()
    assert len(super_list) == 2

    # Sub-admin chỉ thấy ws1
    sub_list = client.get("/api/v1/workspaces", headers=_bearer(sub["token"])).json()
    assert len(sub_list) == 1
    assert sub_list[0]["id"] == ws1["id"]


def test_sub_admin_blocked_from_unassigned_workspace(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_ws(client, auth_header, "Locked WS")
    sub = _sub(client, auth_header, ["MEMBER_VIEW", "MEMBER_INVITE"])

    # Chưa gán → 404 ở mọi endpoint user-facing
    assert (
        client.get(
            f"/api/v1/workspaces/{ws['id']}/members", headers=_bearer(sub["token"])
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/workspaces/{ws['id']}/members/invite",
            json={"email": "x@example.com", "role": "member"},
            headers=_bearer(sub["token"]),
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/api/v1/workspaces/{ws['id']}/members/stats",
            headers=_bearer(sub["token"]),
        ).status_code
        == 404
    )


def test_unassign_revokes_access(client: TestClient, auth_header: dict) -> None:
    ws = _create_ws(client, auth_header, "Toggle WS")
    sub = _sub(client, auth_header, ["MEMBER_VIEW"])
    _assign(client, auth_header, ws["id"], sub["id"])

    assert (
        client.get(
            f"/api/v1/workspaces/{ws['id']}/members", headers=_bearer(sub["token"])
        ).status_code
        == 200
    )

    unassign = client.delete(
        f"/api/v1/workspaces/{ws['id']}/assignments/{sub['id']}", headers=auth_header
    )
    assert unassign.status_code == 204

    assert (
        client.get(
            f"/api/v1/workspaces/{ws['id']}/members", headers=_bearer(sub["token"])
        ).status_code
        == 404
    )
    sub_list = client.get("/api/v1/workspaces", headers=_bearer(sub["token"])).json()
    assert sub_list == []


# ---------- Assignment CRUD rules ----------


def test_assign_is_idempotent(client: TestClient, auth_header: dict) -> None:
    ws = _create_ws(client, auth_header, "Idem WS")
    sub = _sub(client, auth_header, ["MEMBER_VIEW"])

    assert _assign(client, auth_header, ws["id"], sub["id"]).status_code == 201
    assert _assign(client, auth_header, ws["id"], sub["id"]).status_code == 201

    listing = client.get(
        f"/api/v1/workspaces/{ws['id']}/assignments", headers=auth_header
    ).json()
    assert len(listing) == 1
    assert listing[0]["user_id"] == sub["id"]


def test_cannot_assign_super_admin(client: TestClient, auth_header: dict) -> None:
    ws = _create_ws(client, auth_header, "Super WS")
    users = client.get("/api/v1/users", headers=auth_header).json()
    super_id = next(u["id"] for u in users if u["is_super_admin"])

    resp = _assign(client, auth_header, ws["id"], super_id)
    assert resp.status_code == 400


def test_assignment_endpoints_require_super_admin(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_ws(client, auth_header, "Guard WS")
    sub = _sub(client, auth_header, ["MEMBER_VIEW"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub["id"]},
        headers=_bearer(sub["token"]),
    )
    assert resp.status_code == 403


# ---------- Seat guard ----------


def test_seat_guard_blocks_when_full(client: TestClient, auth_header: dict) -> None:
    ws = _create_ws(client, auth_header, "Seat WS", seat_total=1)
    sub = _sub(client, auth_header, ["MEMBER_INVITE", "MEMBER_VIEW"])
    _assign(client, auth_header, ws["id"], sub["id"])

    ok = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "first@example.com", "role": "member"},
        headers=_bearer(sub["token"]),
    )
    assert ok.status_code == 201, ok.text

    full = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "second@example.com", "role": "member"},
        headers=_bearer(sub["token"]),
    )
    assert full.status_code == 409


def test_seat_guard_super_admin_bypass(client: TestClient, auth_header: dict) -> None:
    ws = _create_ws(client, auth_header, "Seat Bypass", seat_total=1)
    # Super-admin mời vượt seat_total → KHÔNG bị chặn
    for email in ("a@example.com", "b@example.com", "c@example.com"):
        resp = client.post(
            f"/api/v1/workspaces/{ws['id']}/members/invite",
            json={"email": email, "role": "member"},
            headers=auth_header,
        )
        assert resp.status_code == 201, resp.text


# ---------- Stats ----------


def test_member_stats_total_vs_own(client: TestClient, auth_header: dict) -> None:
    ws = _create_ws(client, auth_header, "Stats WS", seat_total=10)
    sub = _sub(client, auth_header, ["MEMBER_VIEW", "MEMBER_INVITE"])
    _assign(client, auth_header, ws["id"], sub["id"])

    # 1 do super mời, 1 do sub mời
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "bysuper@example.com", "role": "member"},
        headers=auth_header,
    )
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "bysub@example.com", "role": "member"},
        headers=_bearer(sub["token"]),
    )

    stats = client.get(
        f"/api/v1/workspaces/{ws['id']}/members/stats", headers=_bearer(sub["token"])
    )
    assert stats.status_code == 200, stats.text
    body = stats.json()
    assert body["total"] == 2  # toàn workspace
    assert body["own_count"] == 1  # chỉ member do sub mời
    assert body["seat_total"] == 10
