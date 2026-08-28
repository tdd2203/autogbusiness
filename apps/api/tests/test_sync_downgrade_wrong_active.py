"""Trả về 'chờ tham gia' cho người bị NÂNG OAN thành 'đã tham gia'.

Ca thật 28/8/2026 (workspace GPT1): `SYNC_MEMBERS_BATCH` kết luận "đã tham gia"
chỉ bằng việc ô lọc tab "Người dùng" tìm thấy email. Lệnh chạy khi tab ChatGPT
còn kẹt ở `?tab=invites` nên ô lọc tìm thấy chính LỜI MỜI ĐANG CHỜ và báo về là
active. Chốt chặn chống-hạ-cấp trong vòng upsert khiến sai lầm đó vĩnh viễn: mọi
lần sync sau đều thấy email ở tab Lời mời, đều bị chặn hạ — dashboard đếm 244
active trong khi ChatGPT chỉ có 243.

Mẻ sync quét CẢ HAI tab và không bị nghi thiếu thì đủ căn cứ hạ lại. Sync CHỈ tab
Lời mời thì KHÔNG (một mình tab đó không phân biệt được "chưa tham gia" với "tab
active chưa unmount kịp").
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    ).json()


def _seed(client: TestClient, key: dict, ws_id: str, email: str, status: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-upsert",
        json={
            "members": [{"email": email, "status": status}],
            "is_full_sync": False,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text


def _status_of(client: TestClient, auth_header: dict, ws_id: str, email: str) -> str:
    rows = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=auth_header,
    ).json()
    return {r["email"]: r["status"] for r in rows}[email]


def test_full_sync_ha_lai_nguoi_bi_nang_oan(
    client: TestClient, auth_header: dict
) -> None:
    """Quét cả 2 tab: email chỉ có ở tab Lời mời → trả về 'pending'."""
    ws = _ws(client, auth_header, "Downgrade WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = [f"m{i}@example.com" for i in range(9)]
    for email in roster:
        _seed(client, key, ws["id"], email, "active")
    # Nạn nhân: đang ghi active trong DB nhưng thực tế mới chỉ là lời mời chờ.
    _seed(client, key, ws["id"], "oan@example.com", "active")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active", "pending"],
            "reconcile_emails": roster + ["oan@example.com"],
            "reconcile_pending_emails": ["oan@example.com"],
            "expected_total": 9,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["downgraded_to_pending"] == ["oan@example.com"], resp.text
    assert _status_of(client, auth_header, ws["id"], "oan@example.com") == "pending"
    # Người active thật KHÔNG bị đụng tới.
    assert _status_of(client, auth_header, ws["id"], roster[0]) == "active"


def test_sync_chi_tab_loi_moi_khong_duoc_ha(
    client: TestClient, auth_header: dict
) -> None:
    """Chỉ quét tab Lời mời → không đủ căn cứ, giữ nguyên active."""
    ws = _ws(client, auth_header, "Downgrade Invites Only WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    _seed(client, key, ws["id"], "giu@example.com", "active")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["pending"],
            "reconcile_emails": ["giu@example.com"],
            "reconcile_pending_emails": ["giu@example.com"],
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["downgraded_to_pending"] == [], resp.text
    assert _status_of(client, auth_header, ws["id"], "giu@example.com") == "active"


def test_scrape_thieu_thi_khong_ha(client: TestClient, auth_header: dict) -> None:
    """Mẻ bị nghi scrape thiếu (guard 90%) → hoãn phán xử, giữ nguyên active."""
    ws = _ws(client, auth_header, "Downgrade Partial WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    for email in [f"p{i}@example.com" for i in range(10)]:
        _seed(client, key, ws["id"], email, "active")
    _seed(client, key, ws["id"], "oan2@example.com", "active")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active", "pending"],
            # Chỉ bắt được 2/11 row active → dưới 90% mốc header ⇒ reconcile bị chặn.
            "reconcile_emails": ["p0@example.com", "p1@example.com", "oan2@example.com"],
            "reconcile_pending_emails": ["oan2@example.com"],
            "expected_total": 11,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["reconcile_skipped"] is True, resp.text
    assert resp.json()["downgraded_to_pending"] == [], resp.text
    assert _status_of(client, auth_header, ws["id"], "oan2@example.com") == "active"
