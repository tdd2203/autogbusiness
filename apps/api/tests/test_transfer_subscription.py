"""Chuyển hạn sử dụng — POST /workspaces/{ws}/members/{id}/transfer-subscription.

Nghiệp vụ: chuyển HẠN CÒN LẠI của 1 email sang email khác, rồi gỡ email cho khỏi
workspace. Khác "đổi email": email nhận ĐƯỢC PHÉP đang là thành viên → cộng dồn.

Xác minh:
  - preview trả đúng phép tính (mode/new_end_at) và KHÔNG ghi gì vào DB.
  - fresh (email nhận chưa có trong workspace): bê nguyên mốc hạn + mời email nhận.
  - accumulate (email nhận đang dùng): hạn mới = hạn cũ của email nhận + phần còn
    lại; KHÔNG sinh task mời.
  - Email cho: status=removed + subscription_end_at bị đặt về "hết hạn ngay"
    (KHÔNG phải NULL — NULL nghĩa là vô thời hạn, xem EXPIRY_RULES §5).
  - Luôn gỡ bằng REMOVE_MEMBER (kể cả member pending) — extension tự fallback sang
    tab "Lời mời đang chờ xử lý" nếu không thấy ở tab "Người dùng".
  - Email cho đã hết hạn → 409 (không còn gì để chuyển).
  - target_email trùng email cho → 400.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Transfer WS", "plan": "business", "seat_total": 50},
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
    resp = client.get(f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=headers)
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


def _preview(client: TestClient, ws_id: str, member_id: str, target: str, headers: dict):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/transfer-subscription/preview",
        json={"target_email": target},
        headers=headers,
    )


def _transfer(client: TestClient, ws_id: str, member_id: str, target: str, headers: dict):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/transfer-subscription",
        json={"target_email": target},
        headers=headers,
    )


def _parse(dt: str) -> datetime:
    d = datetime.fromisoformat(dt)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def test_transfer_to_new_email_carries_expiry_and_invites(client: TestClient, auth_header: dict):
    """fresh: email nhận chưa ở trong workspace → bê NGUYÊN mốc hạn + mời vào."""
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["give@example.com"])
    src = _members(client, ws["id"], auth_header)["give@example.com"]
    src_end = _set_subscription(client, ws["id"], src["id"], 3, auth_header)

    prev = _preview(client, ws["id"], src["id"], "take@example.com", auth_header)
    assert prev.status_code == 200, prev.text
    p = prev.json()
    assert p["mode"] == "fresh"
    assert p["blocked_reason"] is None
    assert p["will_invite"] is True
    assert p["target"]["exists"] is False
    assert _parse(p["new_end_at"]) == _parse(src_end)
    assert p["source"]["remaining_seconds"] > 0
    # preview KHÔNG được ghi gì.
    assert _members(client, ws["id"], auth_header)["give@example.com"]["status"] == "active"

    resp = _transfer(client, ws["id"], src["id"], "take@example.com", auth_header)
    assert resp.status_code == 201, resp.text
    target = resp.json()
    assert target["email"] == "take@example.com"
    assert target["status"] == "pending"
    assert _parse(target["subscription_end_at"]) == _parse(src_end)

    # Gỡ email cho bằng REMOVE_MEMBER + mời email nhận.
    removes = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")
    invites = _tasks(client, ws["id"], auth_header, "INVITE_MEMBER")
    assert [t["payload"]["email"] for t in removes] == ["give@example.com"]
    assert [t["payload"]["email"] for t in invites] == ["take@example.com"]

    members = _members(client, ws["id"], auth_header)
    gone = members["give@example.com"]
    assert gone["status"] == "removed"
    # Hạn phải bị đặt về "hết hạn ngay", TUYỆT ĐỐI không phải NULL (NULL = vô hạn).
    assert gone["subscription_end_at"] is not None
    assert _parse(gone["subscription_end_at"]) <= datetime.now(timezone.utc) + timedelta(seconds=5)


def test_transfer_to_existing_member_accumulates(client: TestClient, auth_header: dict):
    """accumulate: email nhận đang dùng → hạn mới = hạn cũ của họ + phần còn lại."""
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["src@example.com", "dst@example.com"])
    members = _members(client, ws["id"], auth_header)
    src, dst = members["src@example.com"], members["dst@example.com"]
    src_end = _parse(_set_subscription(client, ws["id"], src["id"], 1, auth_header))
    dst_end = _parse(_set_subscription(client, ws["id"], dst["id"], 2, auth_header))

    prev = _preview(client, ws["id"], src["id"], "dst@example.com", auth_header)
    assert prev.status_code == 200, prev.text
    p = prev.json()
    assert p["mode"] == "accumulate"
    assert p["will_invite"] is False
    assert p["target"]["exists"] is True
    assert _parse(p["accumulate_from"]) == dst_end

    resp = _transfer(client, ws["id"], src["id"], "dst@example.com", auth_header)
    assert resp.status_code == 201, resp.text
    target = resp.json()
    assert target["email"] == "dst@example.com"
    # hạn mới = hạn cũ email nhận + phần còn lại của email cho (tính lúc gọi API,
    # nên so với sai số vài giây thay vì bằng tuyệt đối).
    new_end = _parse(target["subscription_end_at"])
    remaining = src_end - datetime.now(timezone.utc)
    assert abs((new_end - (dst_end + remaining)).total_seconds()) < 10

    # Email nhận ĐÃ ở trong workspace → KHÔNG mời lại, chỉ gỡ email cho.
    assert _tasks(client, ws["id"], auth_header, "INVITE_MEMBER") == []
    removes = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")
    assert [t["payload"]["email"] for t in removes] == ["src@example.com"]
    assert _members(client, ws["id"], auth_header)["src@example.com"]["status"] == "removed"


def test_transfer_from_pending_uses_remove_task(client: TestClient, auth_header: dict):
    """Member CHỜ THAM GIA vẫn gỡ bằng REMOVE_MEMBER — extension tự sang tab
    "Lời mời đang chờ xử lý" khi không thấy ở tab "Người dùng" (thứ tự user chốt)."""
    ws = _create_workspace(client, auth_header)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "pending-src@example.com", "subscription_months": 2},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    src = resp.json()

    resp = _transfer(client, ws["id"], src["id"], "pending-dst@example.com", auth_header)
    assert resp.status_code == 201, resp.text
    assert _parse(resp.json()["subscription_end_at"]) == _parse(src["subscription_end_at"])

    removes = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")
    assert [t["payload"]["email"] for t in removes] == ["pending-src@example.com"]
    assert _tasks(client, ws["id"], auth_header, "REVOKE_INVITES") == []


def test_transfer_rejects_expired_and_self(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["exp@example.com"])
    src = _members(client, ws["id"], auth_header)["exp@example.com"]

    # Trùng chính nó → 400.
    resp = _transfer(client, ws["id"], src["id"], "exp@example.com", auth_header)
    assert resp.status_code == 400, resp.text

    # Đặt hạn về quá khứ → không còn gì để chuyển.
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{src['id']}/subscription",
        json={"subscription_end_at": past},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text

    prev = _preview(client, ws["id"], src["id"], "any@example.com", auth_header)
    assert prev.status_code == 200, prev.text
    assert prev.json()["blocked_reason"] is not None

    resp = _transfer(client, ws["id"], src["id"], "any@example.com", auth_header)
    assert resp.status_code == 409, resp.text
    # Không được đụng gì vào DB khi bị chặn.
    assert _members(client, ws["id"], auth_header)["exp@example.com"]["status"] == "active"
    assert _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER") == []
