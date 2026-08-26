"""Đồng bộ HÀNG LOẠT (SYNC_MEMBERS_BATCH) khi sub-admin KHÔNG được gán workspace.

Bối cảnh (user 2026-08-27): trang "Email đã thêm" gom email của mọi workspace, nên
thanh "Cập nhật N đã chọn → Đồng bộ" chạy xuyên không gian. Gán workspace CHỈ giới
hạn việc ADD (mời) — kiểm tra email MÌNH ĐÃ ADD đã tham gia hay chưa thì luôn phải
được, giống nút Đồng bộ lẻ ở menu ⋯ (`trigger_sync_member`) và remove/renew.

Phủ:
  - Sub-admin bị gỡ khỏi workspace vẫn đồng bộ được email mình đã add (202).
  - Email của người khác bị lọc khỏi mẻ (visibility theo invited_by_user_id).
  - `all_pending=true` (nút header trong workspace) VẪN cần quyền truy cập → 404.
"""

from fastapi.testclient import TestClient


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _sub(client: TestClient, auth_header: dict, name: str, perms: list[str]) -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": f"{name}@example.com",
            "username": name,
            "password": "SubPassword123!",
            "permissions": perms,
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    user = resp.json()
    login = client.post(
        "/api/v1/auth/login", json={"identifier": name, "password": "SubPassword123!"}
    )
    assert login.status_code == 200, login.text
    return {"id": user["id"], "token": login.json()["access_token"]}


def _assign(client: TestClient, auth_header: dict, ws_id: str, user_id: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id},
        headers=auth_header,
    )
    assert resp.status_code in (200, 201), resp.text


def _unassign(client: TestClient, auth_header: dict, ws_id: str, user_id: str) -> None:
    resp = client.delete(
        f"/api/v1/workspaces/{ws_id}/assignments/{user_id}", headers=auth_header
    )
    assert resp.status_code == 204, resp.text


def _invite(client: TestClient, headers: dict, ws_id: str, email: str) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _batch(client: TestClient, headers: dict, ws_id: str, body: dict):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/sync-members-batch", json=body, headers=headers
    )


def _task(client: TestClient, auth_header: dict, ws_id: str, task_id: str) -> dict:
    """Đọc 1 task từ hàng đợi workspace (không có GET /queue/{id} riêng)."""
    rows = client.get(
        f"/api/v1/queue?workspace_id={ws_id}", headers=auth_header
    ).json()
    match = [r for r in rows if r["id"] == task_id]
    assert match, rows
    return match[0]


SUB_PERMS = ["MEMBER_VIEW", "MEMBER_INVITE", "WORKSPACE_SYNC_TRIGGER"]


def test_batch_sync_allowed_after_unassign(client: TestClient, auth_header: dict) -> None:
    """Sub-admin add 2 email rồi bị gỡ khỏi workspace → vẫn đồng bộ được cả 2."""
    ws = _ws(client, auth_header, "Batch Sync Unassigned WS")
    sub = _sub(client, auth_header, "subsync", SUB_PERMS)
    _assign(client, auth_header, ws["id"], sub["id"])
    sub_h = _bearer(sub["token"])
    _invite(client, sub_h, ws["id"], "mine1@example.com")
    _invite(client, sub_h, ws["id"], "mine2@example.com")

    _unassign(client, auth_header, ws["id"], sub["id"])

    resp = _batch(
        client, sub_h, ws["id"], {"emails": ["mine1@example.com", "MINE2@example.com"]}
    )
    assert resp.status_code == 202, resp.text
    out = resp.json()
    assert out["count"] == 2
    assert out["deduplicated"] is False

    # Task đã vào hàng đợi với đúng 2 email (lowercase).
    task = _task(client, auth_header, ws["id"], out["queue_item_id"])
    assert task["type"] == "SYNC_MEMBERS_BATCH"
    assert sorted(task["payload"]["emails"]) == ["mine1@example.com", "mine2@example.com"]


def test_batch_sync_skips_other_owner_emails(client: TestClient, auth_header: dict) -> None:
    """Email do người khác add bị loại khỏi mẻ; gửi TOÀN email lạ → 400, không tạo task."""
    ws = _ws(client, auth_header, "Batch Sync Visibility WS")
    sub = _sub(client, auth_header, "subvis", SUB_PERMS)
    _assign(client, auth_header, ws["id"], sub["id"])
    sub_h = _bearer(sub["token"])
    _invite(client, sub_h, ws["id"], "mine@example.com")
    # Email của super-admin — sub-admin không thấy trong danh sách của mình.
    _invite(client, auth_header, ws["id"], "boss@example.com")
    _unassign(client, auth_header, ws["id"], sub["id"])

    resp = _batch(
        client, sub_h, ws["id"], {"emails": ["mine@example.com", "boss@example.com"]}
    )
    assert resp.status_code == 202, resp.text
    out = resp.json()
    assert out["count"] == 1
    task = _task(client, auth_header, ws["id"], out["queue_item_id"])
    assert task["payload"]["emails"] == ["mine@example.com"]

    # Mẻ chỉ toàn email không thuộc quyền quản lý → 400 (không phải "danh sách rỗng").
    resp2 = _batch(client, sub_h, ws["id"], {"emails": ["boss@example.com"]})
    assert resp2.status_code == 400, resp2.text
    assert "quyền quản lý" in resp2.json()["detail"]


def test_batch_sync_all_pending_still_needs_assignment(
    client: TestClient, auth_header: dict
) -> None:
    """Nút header `all_pending=true` quét toàn workspace → vẫn 404 khi không được gán."""
    ws = _ws(client, auth_header, "Batch Sync All Pending WS")
    sub = _sub(client, auth_header, "suball", SUB_PERMS)
    _assign(client, auth_header, ws["id"], sub["id"])
    sub_h = _bearer(sub["token"])
    _invite(client, sub_h, ws["id"], "mine@example.com")
    _unassign(client, auth_header, ws["id"], sub["id"])

    resp = _batch(client, sub_h, ws["id"], {"emails": [], "all_pending": True})
    assert resp.status_code == 404, resp.text
