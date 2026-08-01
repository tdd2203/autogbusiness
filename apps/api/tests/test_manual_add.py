"""THÊM THỦ CÔNG (manual-add) — bản ghi quản lý cho email đã ở trên ChatGPT.

Kiểm: active ngay, chu kỳ `unpaid` (không trừ ví / không đánh dấu đã thanh toán),
KHÔNG tạo task INVITE_MEMBER, chặn cứng email ngoài miền + workspace thiếu miền,
chỉ super-admin, và add lại email đã active = cộng dồn chu kỳ mới.
"""

from fastapi.testclient import TestClient


def _create_sub_admin(client: TestClient, auth_header: dict, *, username: str) -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "username": username,
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE"],
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _ws(client: TestClient, auth_header: dict, *, name: str, domain: str | None) -> dict:
    body: dict = {"name": name}
    if domain is not None:
        body["verified_domain"] = domain
    resp = client.post("/api/v1/workspaces", json=body, headers=auth_header)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_manual_add_creates_active_unpaid_no_task(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, name="Auto WS", domain="ndaigroup.org")
    ws_id = ws["id"]

    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/manual-add",
        json={"invites": [{"email": "a@ndaigroup.org", "subscription_months": 2}]},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["added_count"] == 1
    assert body["renewed_count"] == 0
    assert body["count"] == 1

    members = client.get(
        f"/api/v1/workspaces/{ws_id}/members", headers=auth_header
    ).json()
    assert len(members) == 1
    m = members[0]
    assert m["email"] == "a@ndaigroup.org"
    assert m["status"] == "active"
    assert m["payment_status"] == "unpaid"
    assert m["subscription_end_at"] is not None
    assert m["invited_by_user_id"] is not None  # gắn super-admin (chủ sở hữu)

    # KHÔNG tạo task extension.
    queue = client.get("/api/v1/queue?limit=50", headers=auth_header).json()
    assert [i for i in queue if i["type"] == "INVITE_MEMBER"] == []

    # Chu kỳ được ghi nhận nhưng ở trạng thái 'unpaid'.
    added = client.get("/api/v1/added-members", headers=auth_header).json()
    row = next(r for r in added if r["email"] == "a@ndaigroup.org")
    assert len(row["cycles"]) == 1
    assert row["cycles"][0]["payment_status"] == "unpaid"
    assert row["cycles"][0]["months"] == 2


def test_manual_add_rejects_out_of_domain(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, name="Auto WS2", domain="ndaigroup.org")
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/manual-add",
        json={
            "invites": [
                {"email": "ok@ndaigroup.org", "subscription_months": 1},
                {"email": "bad@gmail.com", "subscription_months": 1},
            ]
        },
        headers=auth_header,
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "EMAIL_OUT_OF_DOMAIN"
    # Không tạo member nào khi có email ngoài miền (all-or-nothing).
    members = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    assert members == []


def test_manual_add_requires_verified_domain(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, name="No Domain WS", domain=None)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/manual-add",
        json={"invites": [{"email": "a@ndaigroup.org", "subscription_months": 1}]},
        headers=auth_header,
    )
    assert resp.status_code == 400, resp.text


def test_manual_add_super_admin_only(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, name="Perm WS", domain="ndaigroup.org")
    sub = _create_sub_admin(client, auth_header, username="submanual")
    client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    login = client.post(
        "/api/v1/auth/login",
        json={"identifier": "submanual", "password": "SubPassword123!"},
    )
    sub_token = login.json()["access_token"]
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/manual-add",
        json={"invites": [{"email": "a@ndaigroup.org", "subscription_months": 1}]},
        headers={"Authorization": f"Bearer {sub_token}"},
    )
    assert resp.status_code == 403, resp.text


def test_manual_add_again_stacks_cycle(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, name="Stack WS", domain="ndaigroup.org")
    ws_id = ws["id"]
    payload = {"invites": [{"email": "b@ndaigroup.org", "subscription_months": 1}]}
    first = client.post(
        f"/api/v1/workspaces/{ws_id}/members/manual-add",
        json=payload,
        headers=auth_header,
    ).json()
    assert first["added_count"] == 1

    second = client.post(
        f"/api/v1/workspaces/{ws_id}/members/manual-add",
        json=payload,
        headers=auth_header,
    ).json()
    assert second["added_count"] == 0
    assert second["renewed_count"] == 1

    added = client.get("/api/v1/added-members", headers=auth_header).json()
    row = next(r for r in added if r["email"] == "b@ndaigroup.org")
    assert len(row["cycles"]) == 2
    assert all(c["payment_status"] == "unpaid" for c in row["cycles"])
