"""License type — đổi giấy phép (ChatGPT/Codex) đơn lẻ + hàng loạt + scrape.

Xác minh:
  - bulk-upsert (extension scrape) lưu license_type; không xoá khi scrape null.
  - PATCH .../members/{id}/license-type → enqueue 1 CHANGE_LICENSE_TYPE task.
  - POST .../members/bulk-change-license-type → 1 task / member active; bỏ qua
    member đã đúng license (already); email lạ → skipped.
  - Full lifecycle: extension COMPLETED → Member.license_type sync trong DB.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "License WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upsert(client: TestClient, ws: dict, members: list[dict]) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": members},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _members(client: TestClient, ws_id: str, headers: dict) -> dict:
    resp = client.get(f"/api/v1/workspaces/{ws_id}/members", headers=headers)
    assert resp.status_code == 200, resp.text
    return {m["email"]: m for m in resp.json()}


def _license_tasks(client: TestClient, ws_id: str, headers: dict) -> list[dict]:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return [t for t in resp.json() if t["type"] == "CHANGE_LICENSE_TYPE"]


def _complete(client: TestClient, ws: dict, task_id: str) -> None:
    resp = client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "COMPLETED", "result": {"ok": True}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def test_bulk_upsert_persists_license_type(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert(
        client,
        ws,
        [
            {"email": "a@example.com", "status": "active", "license_type": "ChatGPT"},
            {"email": "b@example.com", "status": "active", "license_type": "Codex"},
        ],
    )
    m = _members(client, ws["id"], auth_header)
    assert m["a@example.com"]["license_type"] == "ChatGPT"
    assert m["b@example.com"]["license_type"] == "Codex"

    # Scrape lại không kèm license_type (null) → KHÔNG xoá giá trị cũ.
    _upsert(client, ws, [{"email": "a@example.com", "status": "active"}])
    m = _members(client, ws["id"], auth_header)
    assert m["a@example.com"]["license_type"] == "ChatGPT"


def test_change_license_type_enqueues_task(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert(client, ws, [{"email": "x@example.com", "status": "active", "license_type": "ChatGPT"}])
    member = _members(client, ws["id"], auth_header)["x@example.com"]

    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/license-type",
        json={"new_license_type": "Codex"},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text

    tasks = _license_tasks(client, ws["id"], auth_header)
    assert len(tasks) == 1
    assert tasks[0]["payload"]["email"] == "x@example.com"
    assert tasks[0]["payload"]["new_license_type"] == "Codex"
    assert tasks[0]["payload"]["old_license_type"] == "ChatGPT"


def test_bulk_change_license_type_skips_already_matching(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert(
        client,
        ws,
        [
            {"email": "c1@example.com", "status": "active", "license_type": "ChatGPT"},
            {"email": "c2@example.com", "status": "active", "license_type": "Codex"},
        ],
    )
    m = _members(client, ws["id"], auth_header)
    ids = [m["c1@example.com"]["id"], m["c2@example.com"]["id"]]

    # Đổi cả 2 sang Codex → c2 đã Codex rồi → already; chỉ c1 tạo task.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-change-license-type",
        json={"member_ids": ids, "new_license_type": "Codex"},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    data = resp.json()
    assert data["count"] == 1
    assert data["emails"] == ["c1@example.com"]
    assert data["already"] == ["c2@example.com"]

    tasks = _license_tasks(client, ws["id"], auth_header)
    assert len(tasks) == 1


def test_bulk_change_license_type_full_lifecycle(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert(
        client,
        ws,
        [
            {"email": "u1@example.com", "status": "active", "license_type": "ChatGPT"},
            {"email": "u2@example.com", "status": "active", "license_type": "ChatGPT"},
        ],
    )
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-change-license-type",
        json={"emails": ["u1@example.com", "u2@example.com"], "new_license_type": "Codex"},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["count"] == 2

    # Trước khi extension chạy: vẫn ChatGPT (task chỉ PENDING).
    m = _members(client, ws["id"], auth_header)
    assert m["u1@example.com"]["license_type"] == "ChatGPT"

    for task in _license_tasks(client, ws["id"], auth_header):
        _complete(client, ws, task["id"])

    after = _members(client, ws["id"], auth_header)
    assert after["u1@example.com"]["license_type"] == "Codex"
    assert after["u2@example.com"]["license_type"] == "Codex"


def test_bulk_change_license_type_requires_ids_or_emails(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-change-license-type",
        json={"member_ids": [], "emails": [], "new_license_type": "Codex"},
        headers=auth_header,
    )
    assert resp.status_code == 400, resp.text
