"""bulk-upsert reconcile khi sync số lượng lớn chia chunk.

Regression: trước fix, extension reconcile theo TỪNG chunk (mỗi chunk chỉ thấy
~200 email của nó) → mọi member ngoài chunk bị mark 'removed' oan. Fix: upsert
các chunk với is_full_sync=false (no reconcile), rồi 1 request cuối truyền
reconcile_emails = TẤT CẢ email đã scrape → reconcile 1 lần trên toàn bộ.
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    ).json()


def _members(client: TestClient, auth_header: dict, ws_id: str) -> dict[str, str]:
    rows = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=auth_header,
    ).json()
    return {r["email"]: r["status"] for r in rows}


def test_chunked_upsert_no_reconcile_keeps_all_then_full_reconcile(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Large Sync WS")
    key = {"X-API-KEY": ws["extension_api_key"]}

    # Giả lập scrape 3 member active, chia 3 chunk (1 member/chunk),
    # upsert KHÔNG reconcile.
    all_emails = ["a@example.com", "b@example.com", "c@example.com"]
    for email in all_emails:
        resp = client.post(
            f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
            json={
                "members": [{"email": email, "status": "active"}],
                "is_full_sync": False,
            },
            headers=key,
        )
        assert resp.status_code == 200, resp.text
        # is_full_sync=false → KHÔNG reconcile (removed_missing luôn 0)
        assert resp.json()["removed_missing"] == 0

    # Sau các chunk, KHÔNG ai bị removed oan (đây là bug cũ).
    statuses = _members(client, auth_header, ws["id"])
    assert all(statuses[e] == "active" for e in all_emails), statuses

    # Request reconcile cuối (members rỗng) với TOÀN BỘ email đã scrape.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active", "pending"],
            "reconcile_emails": all_emails,
            "reconcile_pending_emails": [],
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    # Tất cả email scrape đều còn → không xoá ai.
    assert resp.json()["removed_missing"] == 0
    statuses = _members(client, auth_header, ws["id"])
    assert all(statuses[e] == "active" for e in all_emails), statuses


def test_full_reconcile_removes_only_missing(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Reconcile Missing WS")
    key = {"X-API-KEY": ws["extension_api_key"]}

    # 3 member đang active trong DB.
    for email in ["a@example.com", "b@example.com", "gone@example.com"]:
        client.post(
            f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
            json={
                "members": [{"email": email, "status": "active"}],
                "is_full_sync": False,
            },
            headers=key,
        )

    # Scrape lần này chỉ còn a,b (gone đã rời team) → reconcile mark gone removed.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": ["a@example.com", "b@example.com"],
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["removed_missing"] == 1

    statuses = _members(client, auth_header, ws["id"])
    assert statuses["a@example.com"] == "active"
    assert statuses["b@example.com"] == "active"
    assert statuses["gone@example.com"] == "removed"
