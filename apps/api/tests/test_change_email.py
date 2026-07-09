"""Change email — POST /workspaces/{ws}/members/{id}/change-email.

Nghiệp vụ: khách đổi email → xoá email cũ + mời email mới, GIỮ NGUYÊN hạn dùng cũ.

Xác minh:
  - Enqueue đúng 2 task: REMOVE_MEMBER(email cũ) + INVITE_MEMBER(email mới).
  - Member mới (email mới) status=pending, subscription_end_at == hạn cũ (copy y nguyên).
  - Member cũ → status=removed ngay trong DB.
  - new_email trùng email cũ → 400.
  - new_email đã là member active khác → 409.
  - Đổi email của member đã removed → 409.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Change Email WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upsert_active(client: TestClient, ws: dict, emails: list[str]) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": e,
                    "name": e.split("@")[0],
                    "chatgpt_role": "member",
                    "status": "active",
                }
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


def _set_subscription(
    client: TestClient, ws_id: str, member_id: str, months: int, headers: dict
) -> str:
    resp = client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json={"subscription_months": months},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["subscription_end_at"]


def _tasks(client: TestClient, ws_id: str, headers: dict, ttype: str) -> list[dict]:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return [t for t in resp.json() if t["type"] == ttype]


def _change_email(
    client: TestClient, ws_id: str, member_id: str, new_email: str, headers: dict
):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/change-email",
        json={"new_email": new_email},
        headers=headers,
    )


def test_change_email_carries_expiry_and_enqueues_two_tasks(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["old@example.com"])
    old = _members(client, ws["id"], auth_header)["old@example.com"]
    old_end = _set_subscription(client, ws["id"], old["id"], 3, auth_header)
    assert old_end is not None

    resp = _change_email(client, ws["id"], old["id"], "new@example.com", auth_header)
    assert resp.status_code == 201, resp.text
    new_member = resp.json()
    assert new_member["email"] == "new@example.com"
    assert new_member["status"] == "pending"
    # Hạn dùng GIỮ NGUYÊN — copy y nguyên, KHÔNG tính lại từ now.
    assert new_member["subscription_end_at"] == old_end

    # Đúng 2 task: xoá email cũ + mời email mới.
    removes = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")
    invites = _tasks(client, ws["id"], auth_header, "INVITE_MEMBER")
    assert [t["payload"]["email"] for t in removes] == ["old@example.com"]
    assert [t["payload"]["email"] for t in invites] == ["new@example.com"]

    # Member cũ → removed ngay; member mới → pending với hạn cũ.
    members = _members(client, ws["id"], auth_header)
    assert members["old@example.com"]["status"] == "removed"
    assert members["new@example.com"]["subscription_end_at"] == old_end


def test_change_email_same_as_current_rejected(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["same@example.com"])
    m = _members(client, ws["id"], auth_header)["same@example.com"]
    resp = _change_email(client, ws["id"], m["id"], "SAME@example.com", auth_header)
    assert resp.status_code == 400, resp.text


def test_change_email_to_existing_active_rejected(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["a@example.com", "b@example.com"])
    a = _members(client, ws["id"], auth_header)["a@example.com"]
    resp = _change_email(client, ws["id"], a["id"], "b@example.com", auth_header)
    assert resp.status_code == 409, resp.text


def test_change_email_of_removed_member_rejected(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["gone@example.com"])
    m = _members(client, ws["id"], auth_header)["gone@example.com"]
    # Xoá rồi extension hoàn tất → removed.
    rm = client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{m['id']}", headers=auth_header
    )
    assert rm.status_code == 202, rm.text
    task = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")[0]
    client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": {"ok": True}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    resp = _change_email(client, ws["id"], m["id"], "fresh@example.com", auth_header)
    assert resp.status_code == 409, resp.text
