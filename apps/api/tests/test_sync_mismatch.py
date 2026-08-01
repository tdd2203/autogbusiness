"""Đối soát LỆCH số lượng sau sync → trả field `mismatch` cho dashboard cảnh báo.

Bối cảnh (user 2026-07-30): sync xong VẪN lệch (vd ChatGPT header 172 mà AutoGPT
171). Sai lệch nhỏ (<10%) lọt qua guard "sync thiếu" nên trước đây không ai được
báo. `bulk_upsert_members` nay so `expected_total` (header) · `scraped_active` ·
`db_active` rồi ĐÍCH DANH email lệch trong field `mismatch` (None nếu khớp). CHỈ
báo, KHÔNG tự xoá/sửa.
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    ).json()


def _seed_active(
    client: TestClient, key: dict, ws_id: str, emails: list[str]
) -> None:
    """Đưa member active vào DB qua bulk-upsert no-reconcile. invited_by_user_id
    NULL → KHÔNG dính vùng bảo vệ 10 phút (chỉ áp cho member mời qua dashboard)."""
    for email in emails:
        resp = client.post(
            f"/api/v1/workspaces/{ws_id}/members/bulk-upsert",
            json={
                "members": [{"email": email, "status": "active"}],
                "is_full_sync": False,
            },
            headers=key,
        )
        assert resp.status_code == 200, resp.text


def test_no_mismatch_returns_none(client: TestClient, auth_header: dict) -> None:
    """Khớp hoàn toàn (header = scrape = db) → mismatch None."""
    ws = _ws(client, auth_header, "Mismatch Clean WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = [f"m{i}@example.com" for i in range(3)]
    _seed_active(client, key, ws["id"], roster)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": roster,
            "expected_total": 3,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["mismatch"] is None, resp.text


def test_unresolved_when_header_exceeds_scrape(
    client: TestClient, auth_header: dict
) -> None:
    """Case THỰC TẾ (172 vs 171): header ChatGPT báo NHIỀU hơn số row scrape bắt
    được → 1 dòng chưa lấy được danh tính (unresolved_count) — không nêu email
    được. Dùng 10 vs 11 để không dính guard 90% (10 > 11×0.9)."""
    ws = _ws(client, auth_header, "Mismatch Unresolved WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = [f"m{i}@example.com" for i in range(10)]
    _seed_active(client, key, ws["id"], roster)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": roster,  # scrape đủ 10
            "expected_total": 11,  # nhưng ChatGPT header nói 11
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reconcile_skipped"] is False, body
    mm = body["mismatch"]
    assert mm is not None, body
    assert mm["expected_total"] == 11
    assert mm["scraped_active"] == 10
    assert mm["db_active"] == 10
    assert mm["unresolved_count"] == 1
    assert mm["extra_in_autogpt"] == []
    assert mm["missing_in_autogpt"] == []


def test_missing_in_autogpt_named(client: TestClient, auth_header: dict) -> None:
    """ChatGPT scrape thấy email (trong reconcile_emails) mà AutoGPT KHÔNG có
    thành active → nêu ĐÍCH DANH ở missing_in_autogpt. Mô phỏng lỗi chunk: y@ có
    trong danh sách scrape nhưng chưa từng upsert được vào DB."""
    ws = _ws(client, auth_header, "Mismatch Missing WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    _seed_active(client, key, ws["id"], ["x@example.com"])

    # Request reconcile cuối (members rỗng, giống extension): scrape báo x@ + y@
    # nhưng y@ chưa vào DB.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": ["x@example.com", "y@example.com"],
            "expected_total": 2,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    mm = resp.json()["mismatch"]
    assert mm is not None
    assert mm["missing_in_autogpt"] == ["y@example.com"], mm
    assert mm["db_active"] == 1
    assert mm["scraped_active"] == 2


def test_extra_in_autogpt_named(client: TestClient, auth_header: dict) -> None:
    """AutoGPT đang active nhưng ChatGPT lại liệt kê ở tab pending (không có ở tab
    active) → chốt chặn active→pending giữ nguyên active, nhưng đây là trạng thái
    lệch → nêu ĐÍCH DANH ở extra_in_autogpt để admin kiểm tra."""
    ws = _ws(client, auth_header, "Mismatch Extra WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    _seed_active(client, key, ws["id"], ["z@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            # scope both: tab active RỖNG, tab pending có z@ (lệch trạng thái).
            "members": [{"email": "z@example.com", "status": "pending"}],
            "scraped_statuses": ["active", "pending"],
            "reconcile_emails": ["z@example.com"],
            "reconcile_pending_emails": ["z@example.com"],
            "expected_total": 0,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    mm = resp.json()["mismatch"]
    assert mm is not None
    assert mm["extra_in_autogpt"] == ["z@example.com"], mm
    assert mm["db_active"] == 1
    assert mm["scraped_active"] == 0


def test_skipped_partial_scrape_no_mismatch(
    client: TestClient, auth_header: dict
) -> None:
    """Khi partial-scrape guard skip reconcile (nghi sync thiếu), số liệu vô nghĩa
    → KHÔNG báo mismatch (đã có MEMBER_RECONCILE_SKIPPED lo)."""
    ws = _ws(client, auth_header, "Mismatch Skipped WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    roster = [f"m{i}@example.com" for i in range(12)]
    _seed_active(client, key, ws["id"], roster)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active"],
            "reconcile_emails": roster[:2],  # scrape sập còn 2/12
            "expected_total": 12,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reconcile_skipped"] is True
    assert body["mismatch"] is None, body
