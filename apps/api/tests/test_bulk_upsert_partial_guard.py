"""Guard chống 'sync THIẾU' trong bulk-upsert reconcile.

Bug thực tế (user 2026-07-03): extension scrape list member, LẦN 1 chỉ lấy được
~2/N member (list chưa render hết) → nếu reconcile chạy, N-2 member còn lại bị
mark 'removed' oan, phá dữ liệu lịch sử. Fix: extension gửi `expected_total`
(header count ChatGPT tự báo) làm nguồn sự thật; backend BỎ QUA reconcile khi số
active scrape được ≪ expected_total. Phân biệt với 'admin xoá thật còn ít' (header
cũng giảm theo → expected_total ≈ scrape → reconcile vẫn chạy).
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


def _seed_active(
    client: TestClient, key: dict, ws_id: str, emails: list[str]
) -> None:
    """Đưa N member active vào DB qua bulk-upsert (is_full_sync=false → no reconcile)."""
    for email in emails:
        resp = client.post(
            f"/api/v1/workspaces/{ws_id}/members/bulk-upsert",
            json={"members": [{"email": email, "status": "active"}], "is_full_sync": False},
            headers=key,
        )
        assert resp.status_code == 200, resp.text


def test_partial_sync_skips_reconcile_with_expected_total(
    client: TestClient, auth_header: dict
) -> None:
    """ChatGPT báo 12 active, scrape chỉ ra 2 → BỎ QUA reconcile (giữ 10 kia)."""
    ws = _ws(client, auth_header, "Partial Guard WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = [f"m{i}@example.com" for i in range(12)]
    _seed_active(client, key, ws["id"], roster)

    # Sync lỗi: chỉ scrape được 2 member, nhưng header ChatGPT báo 12.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": roster[:2],
            "expected_total": 12,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reconcile_skipped"] is True
    assert body["removed_missing"] == 0
    assert "partial_scrape" in (body["reconcile_skip_reason"] or "")

    # KHÔNG ai bị xoá — toàn bộ 12 vẫn active.
    statuses = _members(client, auth_header, ws["id"])
    assert all(statuses[e] == "active" for e in roster), statuses


def test_legit_removal_still_reconciles_when_header_matches(
    client: TestClient, auth_header: dict
) -> None:
    """Admin xoá thật còn 2 (header cũng = 2) → reconcile CHẠY, mark 10 removed."""
    ws = _ws(client, auth_header, "Legit Removal WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = [f"m{i}@example.com" for i in range(12)]
    _seed_active(client, key, ws["id"], roster)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": roster[:2],
            "expected_total": 2,  # ChatGPT header cũng chỉ còn 2 → không phải bug
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reconcile_skipped"] is False
    assert body["removed_missing"] == 10

    statuses = _members(client, auth_header, ws["id"])
    assert statuses[roster[0]] == "active"
    assert statuses[roster[1]] == "active"
    assert all(statuses[e] == "removed" for e in roster[2:]), statuses


def test_partial_sync_fallback_guard_without_expected_total(
    client: TestClient, auth_header: dict
) -> None:
    """Extension cũ KHÔNG gửi expected_total: roster ≥10 mà scrape ≤2 → vẫn skip."""
    ws = _ws(client, auth_header, "Fallback Guard WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = [f"m{i}@example.com" for i in range(12)]
    _seed_active(client, key, ws["id"], roster)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": roster[:1],  # scrape sập còn 1
            # expected_total KHÔNG gửi (None)
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reconcile_skipped"] is True
    assert body["removed_missing"] == 0
    statuses = _members(client, auth_header, ws["id"])
    assert all(statuses[e] == "active" for e in roster), statuses


def test_invites_sync_does_not_downgrade_active_to_pending(
    client: TestClient, auth_header: dict
) -> None:
    """Bug (user 2026-07-13): sync scope 'invites' đẩy member đang active về
    'Chờ tham gia'. Row active chưa unmount lọt vào lần quét tab Lời mời → mang
    nhãn pending. bulk-upsert TUYỆT ĐỐI không được hạ active → pending."""
    ws = _ws(client, auth_header, "No Downgrade WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    _seed_active(client, key, ws["id"], ["active1@example.com", "active2@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": "active1@example.com", "status": "pending"},
                {"email": "active2@example.com", "status": "pending"},
            ],
            "scraped_statuses": ["pending"],
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text

    statuses = _members(client, auth_header, ws["id"])
    assert statuses["active1@example.com"] == "active", statuses
    assert statuses["active2@example.com"] == "active", statuses


def test_pending_to_active_promotion_still_works(
    client: TestClient, auth_header: dict
) -> None:
    """Chốt chặn chỉ chặn active→pending; pending→active (member vừa nhận lời
    mời, quét thấy ở tab Người dùng) vẫn phải cho qua bình thường."""
    ws = _ws(client, auth_header, "Promote WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    # Seed pending trước.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": "p@example.com", "status": "pending"}], "is_full_sync": False},
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert _members(client, auth_header, ws["id"])["p@example.com"] == "pending"

    # Sync tab active thấy họ → promote lên active.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "p@example.com", "status": "active"}],
            "scraped_statuses": ["active"],
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert _members(client, auth_header, ws["id"])["p@example.com"] == "active"


def test_invites_sync_does_not_remove_disappeared_pending(
    client: TestClient, auth_header: dict
) -> None:
    """Bug (user 2026-07-13): đồng bộ scope 'invites' làm MẤT thành viên. Member
    'pending' đã CHẤP NHẬN lời mời rời tab "Lời mời" → sang tab "Người dùng";
    sync CHỈ quét tab Lời mời không thấy họ → TRƯỚC ĐÂY mark 'removed' oan. Giờ:
    quét mỗi tab Lời mời (scraped_statuses=['pending']) KHÔNG đủ căn cứ xoá →
    member giữ nguyên, chờ sync scope 'both' promote/gỡ chuẩn."""
    ws = _ws(client, auth_header, "Invites No Remove WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    # Seed 1 pending (invited_by_user_id NULL → KHÔNG dính vùng bảo vệ 10 phút).
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "accepted@example.com", "status": "pending"}],
            "is_full_sync": False,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    # Sync tab Lời mời: KHÔNG thấy accepted@ (đã sang tab Người dùng) — chỉ thấy email khác.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "other@example.com", "status": "pending"}],
            "scraped_statuses": ["pending"],
            "reconcile_emails": ["other@example.com"],
            "reconcile_pending_emails": ["other@example.com"],
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["removed_missing"] == 0, resp.text
    statuses = _members(client, auth_header, ws["id"])
    assert statuses["accepted@example.com"] == "pending", statuses


def test_both_sync_still_removes_truly_gone_pending(
    client: TestClient, auth_header: dict
) -> None:
    """Ngược lại: sync scope 'both' (quét CẢ tab Người dùng) — pending không thấy
    ở đâu (active lẫn pending) → thật sự bị revoke → mark 'removed' đúng. Gate chỉ
    hoãn xoá khi thiếu bằng chứng tab active, không phải cấm xoá vĩnh viễn."""
    ws = _ws(client, auth_header, "Both Remove WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "gone@example.com", "status": "pending"}],
            "is_full_sync": False,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    # scope 'both': quét active (thấy keep@) + pending (rỗng) — gone@ biến mất ở CẢ 2.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "keep@example.com", "status": "active"}],
            "scraped_statuses": ["active", "pending"],
            "reconcile_emails": ["keep@example.com"],
            "reconcile_pending_emails": [],
            "expected_total": 1,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["removed_missing"] == 1, resp.text
    statuses = _members(client, auth_header, ws["id"])
    assert statuses["gone@example.com"] == "removed", statuses


def test_small_workspace_removal_not_blocked_by_fallback(
    client: TestClient, auth_header: dict
) -> None:
    """Workspace nhỏ (3 member) không dính fallback guard → xoá hợp lệ vẫn chạy."""
    ws = _ws(client, auth_header, "Small WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = ["a@example.com", "b@example.com", "gone@example.com"]
    _seed_active(client, key, ws["id"], roster)

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
    body = resp.json()
    assert body["reconcile_skipped"] is False
    assert body["removed_missing"] == 1
    statuses = _members(client, auth_header, ws["id"])
    assert statuses["gone@example.com"] == "removed"
