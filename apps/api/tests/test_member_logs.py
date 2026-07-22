"""Member activity log — GET /workspaces/{ws}/members/{id}/logs.

Xác minh:
  - Trả về sự kiện audit có target_id == member.id (nhánh đơn lẻ) — ở đây dùng
    cập nhật subscription (MEMBER_SUBSCRIPTION_UPDATED).
  - Trả về CẢ sự kiện hàng loạt nhét id vào data["member_ids"] (nhánh JSONB
    containment) — ở đây dùng /added-members/mark-paid.
  - member_id không tồn tại → 404.
  - Sắp xếp mới nhất lên đầu.

Xem app/routers/members/activity.md.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Logs WS", "plan": "business", "seat_total": 50},
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


def _member(client: TestClient, ws_id: str, email: str, headers: dict) -> dict:
    resp = client.get(f"/api/v1/workspaces/{ws_id}/members", headers=headers)
    assert resp.status_code == 200, resp.text
    return {m["email"]: m for m in resp.json()}[email]


def _logs(client: TestClient, ws_id: str, member_id: str, headers: dict):
    return client.get(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/logs", headers=headers
    )


def test_member_logs_single_and_bulk_events(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["log@example.com"])
    m = _member(client, ws["id"], "log@example.com", auth_header)

    # 1) Sự kiện đơn lẻ: cập nhật subscription → MEMBER_SUBSCRIPTION_UPDATED.
    sub = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{m['id']}/subscription",
        json={"subscription_months": 2},
        headers=auth_header,
    )
    assert sub.status_code == 200, sub.text

    # 2) Sự kiện hàng loạt: mark-paid nhét member_ids vào data → nhánh JSONB.
    paid = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": True},
        headers=auth_header,
    )
    assert paid.status_code == 200, paid.text

    resp = _logs(client, ws["id"], m["id"], auth_header)
    assert resp.status_code == 200, resp.text
    logs = resp.json()
    actions = [l["action"] for l in logs]
    assert "MEMBER_SUBSCRIPTION_UPDATED" in actions
    assert "MEMBER_PAYMENT_MARKED" in actions  # bắt được qua data["member_ids"]

    # Sắp xếp giảm dần theo timestamp (mới nhất lên đầu).
    timestamps = [l["timestamp"] for l in logs]
    assert timestamps == sorted(timestamps, reverse=True)


def test_member_logs_include_bulk_invite_by_email(
    client: TestClient, auth_header: dict
):
    """Mời hàng loạt ghi log target_type=QUEUE_ITEM (không có member.id), email
    nằm trong data["entries"]. Panel chi tiết vẫn phải thấy sự kiện mời — bắt qua
    nhánh containment (workspace_id, email). Xem activity.py."""
    ws = _create_workspace(client, auth_header)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={
            "role": "member",
            "invites": [
                {"email": "bulk1@example.com", "subscription_months": 1},
                {"email": "bulk2@example.com", "subscription_months": 2},
            ],
        },
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text

    m = _member(client, ws["id"], "bulk1@example.com", auth_header)
    logs = _logs(client, ws["id"], m["id"], auth_header).json()
    actions = [l["action"] for l in logs]
    assert "MEMBER_BULK_INVITE_QUEUED" in actions

    # Không rò rỉ log của email khác cùng batch: log bulk là chung, nhưng phải
    # KHÔNG bắt nhầm cho member ở workspace/email khác. Tạo member lạ → 0 log mời.
    _upsert_active(client, ws, ["stranger@example.com"])
    other = _member(client, ws["id"], "stranger@example.com", auth_header)
    other_actions = [l["action"] for l in _logs(client, ws["id"], other["id"], auth_header).json()]
    assert "MEMBER_BULK_INVITE_QUEUED" not in other_actions


def test_member_logs_after_change_email(
    client: TestClient, auth_header: dict
) -> None:
    """Sau đổi email, timeline member mới phải có MEMBER_EMAIL_CHANGED (+ lời mời gốc nếu có)."""
    ws = _create_workspace(client, auth_header)
    inv = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "lineage-old@example.com", "subscription_months": 1},
        headers=auth_header,
    )
    assert inv.status_code == 201, inv.text
    old = inv.json()

    chg = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{old['id']}/change-email",
        json={"new_email": "lineage-new@example.com"},
        headers=auth_header,
    )
    assert chg.status_code == 201, chg.text
    new_m = chg.json()

    logs = _logs(client, ws["id"], new_m["id"], auth_header).json()
    actions = [lg["action"] for lg in logs]
    assert "MEMBER_EMAIL_CHANGED" in actions
    email_changed = next(lg for lg in logs if lg["action"] == "MEMBER_EMAIL_CHANGED")
    assert email_changed["data"]["old_email"] == "lineage-old@example.com"
    assert email_changed["data"]["new_email"] == "lineage-new@example.com"


def test_member_logs_unknown_member_404(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    resp = _logs(
        client,
        ws["id"],
        "00000000-0000-0000-0000-000000000000",
        auth_header,
    )
    assert resp.status_code == 404, resp.text
