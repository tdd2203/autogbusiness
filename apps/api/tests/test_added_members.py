"""Tab 'Email đã add' — listing xuyên workspace + duyệt thanh toán (mark-paid)."""

from fastapi.testclient import TestClient


def _create_sub_admin(
    client: TestClient, auth_header: dict, *, username: str
) -> dict:
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


def _login(client: TestClient, identifier: str) -> dict:
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": identifier, "password": "SubPassword123!"},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _setup_workspace_with_sub(client: TestClient, auth_header: dict, *, username: str):
    ws = client.post(
        "/api/v1/workspaces",
        json={"name": f"WS {username}", "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()
    sub = _create_sub_admin(client, auth_header, username=username)
    assign = client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    assert assign.status_code in (200, 201), assign.text
    return ws, sub


def _invite(client: TestClient, headers: dict, ws_id: str, email: str) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_added_members_listing_and_default_unpaid(
    client: TestClient, auth_header: dict
) -> None:
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay1")
    sub_h = _login(client, "subpay1")
    _invite(client, sub_h, ws["id"], "buyer1@example.com")

    resp = client.get("/api/v1/added-members", headers=sub_h)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["email"] == "buyer1@example.com"
    assert rows[0]["payment_status"] == "unpaid"
    assert rows[0]["paid_at"] is None
    assert rows[0]["workspace_name"] == ws["name"]


def test_sub_admin_can_self_approve_payment(
    client: TestClient, auth_header: dict
) -> None:
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay2")
    sub_h = _login(client, "subpay2")
    m = _invite(client, sub_h, ws["id"], "buyer2@example.com")

    paid = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": True},
        headers=sub_h,
    )
    assert paid.status_code == 200, paid.text
    assert paid.json()["count"] == 1

    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert rows[0]["payment_status"] == "paid"
    assert rows[0]["paid_at"] is not None

    # Bỏ đánh dấu lại
    unpaid = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": False},
        headers=sub_h,
    )
    assert unpaid.json()["count"] == 1
    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert rows[0]["payment_status"] == "unpaid"
    assert rows[0]["paid_at"] is None


def test_sub_admin_cannot_mark_others_email(
    client: TestClient, auth_header: dict
) -> None:
    ws, _suba = _setup_workspace_with_sub(client, auth_header, username="subpayA")
    suba_h = _login(client, "subpayA")
    m = _invite(client, suba_h, ws["id"], "buyerA@example.com")

    # Sub B (khác workspace) không được duyệt email của Sub A → count 0.
    _wsb, _subb = _setup_workspace_with_sub(client, auth_header, username="subpayB")
    subb_h = _login(client, "subpayB")
    resp = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": True},
        headers=subb_h,
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 0
    # Email vẫn unpaid khi Sub A xem
    rows = client.get("/api/v1/added-members", headers=suba_h).json()
    assert rows[0]["payment_status"] == "unpaid"


def test_super_admin_can_view_per_sub_account(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _setup_workspace_with_sub(client, auth_header, username="subpay3")
    sub_h = _login(client, "subpay3")
    _invite(client, sub_h, ws["id"], "buyer3@example.com")

    # Super-admin lọc theo user_id của sub
    resp = client.get(
        f"/api/v1/added-members?user_id={sub['id']}", headers=auth_header
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["email"] == "buyer3@example.com"


def test_removed_email_not_listed(client: TestClient, auth_header: dict) -> None:
    from uuid import UUID

    from app.db import SessionLocal
    from app.models import Member

    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay4")
    sub_h = _login(client, "subpay4")
    m = _invite(client, sub_h, ws["id"], "buyer4@example.com")

    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert any(r["id"] == m["id"] for r in rows)

    # Email bị xoá khỏi team (status=removed) → không còn hiển thị trong tab.
    db = SessionLocal()
    try:
        member = db.get(Member, UUID(m["id"]))
        member.status = "removed"
        db.commit()
    finally:
        db.close()

    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert all(r["id"] != m["id"] for r in rows)
