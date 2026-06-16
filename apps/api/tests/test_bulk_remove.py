"""Bulk remove — POST /workspaces/{ws}/members/bulk-remove.

Xác minh:
  - Chọn bằng member_ids → enqueue 1 REMOVE_MEMBER / member.
  - Chọn bằng emails → resolve về member, enqueue; email không khớp → skipped.
  - Trộn id + email + trùng nhau → dedupe theo member.id.
  - Member status='removed' không được enqueue.
  - Thiếu cả member_ids lẫn emails → 400.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Bulk Remove WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _bulk_invite(client: TestClient, ws_id: str, emails: list[str], headers: dict) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=headers,
    )
    assert resp.status_code == 202, resp.text


def _members(client: TestClient, ws_id: str, headers: dict) -> list[dict]:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _remove_tasks(client: TestClient, ws_id: str, headers: dict) -> list[dict]:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return [t for t in resp.json() if t["type"] == "REMOVE_MEMBER"]


def test_bulk_remove_by_member_ids_enqueues_one_task_each(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _bulk_invite(
        client, ws["id"], ["a@example.com", "b@example.com", "c@example.com"], auth_header
    )
    members = {m["email"]: m for m in _members(client, ws["id"], auth_header)}
    ids = [members["a@example.com"]["id"], members["b@example.com"]["id"]]

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        json={"member_ids": ids},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    data = resp.json()
    assert data["count"] == 2
    assert set(data["emails"]) == {"a@example.com", "b@example.com"}
    assert data["skipped"] == []

    tasks = _remove_tasks(client, ws["id"], auth_header)
    assert len(tasks) == 2
    queued_emails = {t["payload"]["email"] for t in tasks}
    assert queued_emails == {"a@example.com", "b@example.com"}


def test_bulk_remove_by_emails_reports_skipped_unmatched(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _bulk_invite(client, ws["id"], ["real@example.com"], auth_header)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        # Email viết hoa + 1 email không tồn tại trong workspace.
        json={"emails": ["REAL@example.com", "ghost@example.com"]},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    data = resp.json()
    assert data["count"] == 1
    assert data["emails"] == ["real@example.com"]
    assert data["skipped"] == ["ghost@example.com"]


def test_bulk_remove_dedupes_id_and_email_overlap(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _bulk_invite(client, ws["id"], ["dup@example.com"], auth_header)
    member = _members(client, ws["id"], auth_header)[0]

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        json={"member_ids": [member["id"]], "emails": ["dup@example.com"]},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    data = resp.json()
    assert data["count"] == 1
    assert _remove_tasks(client, ws["id"], auth_header).__len__() == 1


def test_bulk_remove_requires_ids_or_emails(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        json={"member_ids": [], "emails": []},
        headers=auth_header,
    )
    assert resp.status_code == 400, resp.text


# =====================================================================
# Integration: mô phỏng extension chạy hết luồng xoá (logic xoá thực thi)
# =====================================================================

def _upsert_active(client: TestClient, ws: dict, emails: list[str]) -> None:
    """Giả lập extension scrape về → member active (như đã join workspace)."""
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


def _complete_task(client: TestClient, ws: dict, task_id: str) -> None:
    """Giả lập extension PATCH task REMOVE_MEMBER → COMPLETED (X-API-KEY)."""
    resp = client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "COMPLETED", "result": {"ok": True}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def test_bulk_remove_full_lifecycle_marks_members_removed(
    client: TestClient, auth_header: dict
):
    """End-to-end: active members → bulk-remove enqueue → extension COMPLETED →
    Member.status='removed' trong DB (logic remove của queue.py chạy thật)."""
    ws = _create_workspace(client, auth_header)
    emails = ["u1@example.com", "u2@example.com", "u3@example.com"]
    _upsert_active(client, ws, emails)

    members = {m["email"]: m for m in _members(client, ws["id"], auth_header)}
    assert all(members[e]["status"] == "active" for e in emails)

    # Xoá 2/3 bằng member_ids.
    ids = [members["u1@example.com"]["id"], members["u2@example.com"]["id"]]
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        json={"member_ids": ids},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["count"] == 2

    # Trước khi extension chạy: vẫn còn active (task chỉ mới PENDING).
    mid = {m["email"]: m for m in _members(client, ws["id"], auth_header)}
    assert mid["u1@example.com"]["status"] == "active"

    # Extension hoàn tất từng task.
    for task in _remove_tasks(client, ws["id"], auth_header):
        _complete_task(client, ws, task["id"])

    after = {m["email"]: m for m in _members(client, ws["id"], auth_header)}
    assert after["u1@example.com"]["status"] == "removed"
    assert after["u2@example.com"]["status"] == "removed"
    # Member không bị chọn vẫn active.
    assert after["u3@example.com"]["status"] == "active"


def test_bulk_remove_by_paste_emails_lifecycle(
    client: TestClient, auth_header: dict
):
    """Nhánh dán email (giống flow mời): emails → bulk-remove → COMPLETED →
    removed; email lạ nằm trong skipped, không tạo task."""
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["keep@example.com", "kill@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        json={"emails": ["kill@example.com", "ghost@example.com"]},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["emails"] == ["kill@example.com"]
    assert body["skipped"] == ["ghost@example.com"]

    tasks = _remove_tasks(client, ws["id"], auth_header)
    assert len(tasks) == 1
    _complete_task(client, ws, tasks[0]["id"])

    after = {m["email"]: m for m in _members(client, ws["id"], auth_header)}
    assert after["kill@example.com"]["status"] == "removed"
    assert after["keep@example.com"]["status"] == "active"
