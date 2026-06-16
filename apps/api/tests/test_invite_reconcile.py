"""reconcile-after-invite — dọn phantom pending khi verify không thấy email."""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    ).json()


def _invite(client: TestClient, auth_header: dict, ws_id: str, email: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text


def _members(client: TestClient, auth_header: dict, ws_id: str) -> dict[str, str]:
    rows = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=auth_header,
    ).json()
    return {r["email"]: r["status"] for r in rows}


def test_reconcile_removes_unverified_keeps_verified(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Reconcile WS")
    _invite(client, auth_header, ws["id"], "ok@example.com")
    _invite(client, auth_header, ws["id"], "ghost@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": ["ok@example.com"],
            "unverified_emails": ["ghost@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"removed": 1, "skipped": False}

    statuses = _members(client, auth_header, ws["id"])
    assert statuses["ok@example.com"] == "pending"
    assert statuses["ghost@example.com"] == "removed"


def test_reconcile_skips_when_scrape_failed(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Reconcile Skip WS")
    _invite(client, auth_header, ws["id"], "keep@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["keep@example.com"],
            "verify_scrape_failed": True,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"removed": 0, "skipped": True}
    # Scrape fail → KHÔNG xoá, giữ pending
    assert _members(client, auth_header, ws["id"])["keep@example.com"] == "pending"


def test_reconcile_does_not_touch_active_member(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Reconcile Active WS")
    # active member (đã trong team) qua bulk-upsert extension
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": "active@example.com", "status": "active"}]},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["active@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    # active KHÔNG bị đụng (chỉ pending mới bị remove)
    assert resp.json()["removed"] == 0
    assert _members(client, auth_header, ws["id"])["active@example.com"] == "active"


def test_reconcile_wrong_key_rejected(
    client: TestClient, auth_header: dict
) -> None:
    ws_a = _ws(client, auth_header, "RA")
    ws_b = _ws(client, auth_header, "RB")
    resp = client.post(
        f"/api/v1/workspaces/{ws_a['id']}/members/reconcile-after-invite",
        json={"verified_emails": [], "unverified_emails": [], "verify_scrape_failed": False},
        headers={"X-API-KEY": ws_b["extension_api_key"]},
    )
    assert resp.status_code == 403
