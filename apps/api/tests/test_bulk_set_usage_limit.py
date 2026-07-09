"""Bulk set usage limit — POST /workspaces/{ws}/members/bulk-set-usage-limit.

Xác minh:
  - Mức CHUNG (limit_credits + emails) → 1 SET_USAGE_LIMIT task / member, payload
    chứa limit_credits.
  - Mức RIÊNG (items) ưu tiên hơn mức chung khi trùng email.
  - Bỏ qua member đã đúng mức (`already`); email không khớp → `skipped`.
  - Thiếu cả limit_credits lẫn items → 400.
  - Lifecycle: extension COMPLETED → Member.usage_limit_credits sync trong DB.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Usage Limit WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upsert_active(client: TestClient, ws: dict, emails: list[str]) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": e, "name": e.split("@")[0], "chatgpt_role": "member",
                 "status": "active"}
                for e in emails
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _members(client: TestClient, ws_id: str, headers: dict) -> dict:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return {m["email"]: m for m in resp.json()}


def _limit_tasks(client: TestClient, ws_id: str, headers: dict) -> list[dict]:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return [t for t in resp.json() if t["type"] == "SET_USAGE_LIMIT"]


def _complete(client: TestClient, ws: dict, task_id: str) -> None:
    resp = client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "COMPLETED", "result": {"ok": True}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def test_common_limit_enqueues_one_task_each(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["a@example.com", "b@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["a@example.com", "b@example.com"], "limit_credits": 100},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    data = resp.json()
    assert data["count"] == 2
    assert set(data["emails"]) == {"a@example.com", "b@example.com"}

    tasks = _limit_tasks(client, ws["id"], auth_header)
    assert len(tasks) == 2
    assert all(t["payload"]["limit_credits"] == 100 for t in tasks)


def test_per_member_items_override_common(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["x@example.com", "y@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={
            "emails": ["x@example.com"],
            "limit_credits": 50,
            "items": [{"email": "y@example.com", "limit_credits": 999}],
        },
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["count"] == 2

    by_email = {
        t["payload"]["email"]: t["payload"]["limit_credits"]
        for t in _limit_tasks(client, ws["id"], auth_header)
    }
    assert by_email["x@example.com"] == 50
    assert by_email["y@example.com"] == 999


def test_skipped_unmatched_and_requires_input(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["real@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["REAL@example.com", "ghost@example.com"], "limit_credits": 10},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    data = resp.json()
    assert data["emails"] == ["real@example.com"]
    assert data["skipped"] == ["ghost@example.com"]

    # Thiếu cả limit_credits lẫn items → 400.
    bad = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["real@example.com"]},
        headers=auth_header,
    )
    assert bad.status_code == 400, bad.text


def test_lifecycle_syncs_usage_limit_and_skips_already(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["u@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["u@example.com"], "limit_credits": 250},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    task = _limit_tasks(client, ws["id"], auth_header)[0]

    # Trước khi extension chạy: chưa sync.
    assert _members(client, ws["id"], auth_header)["u@example.com"][
        "usage_limit_credits"
    ] is None

    _complete(client, ws, task["id"])
    assert _members(client, ws["id"], auth_header)["u@example.com"][
        "usage_limit_credits"
    ] == 250

    # Đặt lại đúng mức cũ → skip (already), không tạo task mới.
    again = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["u@example.com"], "limit_credits": 250},
        headers=auth_header,
    )
    assert again.status_code == 202, again.text
    body = again.json()
    assert body["count"] == 0
    assert body["already"] == ["u@example.com"]
