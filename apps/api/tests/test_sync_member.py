"""Đồng bộ 1 tài khoản lẻ (SYNC_MEMBER) + rate-limit full-sync.

Phủ:
  - Full-sync (SYNC_DATA): admin phụ 1 lần/ngày → lần 2 429; admin chính không giới hạn.
  - GET /sync-quota: admin phụ allowed→false sau khi dùng; admin chính luôn true.
  - sync-member chống-spam: 2 lần OK, lần 3 → 429 SYNC_MEMBER_COOLDOWN, còn cooldown.
  - completion reconcile: found_in=active → member 'active'; none → giữ 'pending'.
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    ).json()


def _invite(client: TestClient, auth_header: dict, ws_id: str, email: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text


def _members(client: TestClient, auth_header: dict, ws_id: str) -> dict[str, str]:
    rows = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=auth_header,
    ).json()
    return {r["email"]: r["status"] for r in rows}


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _sub(client: TestClient, auth_header: dict, perms: list[str], *, n: str = "sub") -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": f"{n}@example.com",
            "username": n,
            "password": "SubPassword123!",
            "permissions": perms,
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    user = resp.json()
    login = client.post(
        "/api/v1/auth/login", json={"identifier": n, "password": "SubPassword123!"}
    )
    return {"id": user["id"], "token": login.json()["access_token"]}


def _assign(client: TestClient, auth_header: dict, ws_id: str, user_id: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text


# ---------- Full-sync daily limit ----------


def test_full_sync_daily_limit_sub_admin(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "Daily Limit WS")
    sub = _sub(client, auth_header, ["WORKSPACE_SYNC_TRIGGER"])
    _assign(client, auth_header, ws["id"], sub["id"])

    first = client.post(
        f"/api/v1/workspaces/{ws['id']}/sync", headers=_bearer(sub["token"])
    )
    assert first.status_code == 202, first.text

    second = client.post(
        f"/api/v1/workspaces/{ws['id']}/sync", headers=_bearer(sub["token"])
    )
    assert second.status_code == 429, second.text
    assert second.json()["detail"]["code"] == "FULL_SYNC_DAILY_LIMIT"


def test_full_sync_super_admin_unlimited(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "Super Unlimited WS")
    for _ in range(3):
        resp = client.post(
            f"/api/v1/workspaces/{ws['id']}/sync", headers=auth_header
        )
        assert resp.status_code == 202, resp.text


def test_sync_quota_reflects_usage(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "Quota WS")
    sub = _sub(client, auth_header, ["WORKSPACE_SYNC_TRIGGER"])
    _assign(client, auth_header, ws["id"], sub["id"])

    before = client.get(
        f"/api/v1/workspaces/{ws['id']}/sync-quota", headers=_bearer(sub["token"])
    )
    assert before.status_code == 200, before.text
    assert before.json()["full_sync_allowed"] is True

    client.post(f"/api/v1/workspaces/{ws['id']}/sync", headers=_bearer(sub["token"]))

    after = client.get(
        f"/api/v1/workspaces/{ws['id']}/sync-quota", headers=_bearer(sub["token"])
    )
    assert after.json()["full_sync_allowed"] is False

    # Admin chính luôn cho phép.
    su = client.get(
        f"/api/v1/workspaces/{ws['id']}/sync-quota", headers=auth_header
    )
    assert su.json()["full_sync_allowed"] is True


# ---------- chống spam: cùng (lệnh, email) lặp >3 lần → ban 10 phút ----------

SUPER_USER = "superadmin"
SUPER_PW = "TestPassword123!"


def _sync(client: TestClient, auth_header: dict, ws: dict, email: str):
    return client.post(
        f"/api/v1/workspaces/{ws['id']}/sync-member",
        json={"email": email},
        headers=auth_header,
    )


def _complete(client: TestClient, ws: dict, task_id: str, found_in: str = "pending"):
    return client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "COMPLETED", "result": {"data": {"found_in": found_in}}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )


def _fail(client: TestClient, ws: dict, task_id: str):
    return client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "FAILED", "error_code": "X", "error_message": "boom"},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )


def test_spam_same_email_bans_on_4th(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "Spam WS")
    email = "spam@example.com"
    # 3 lần OK (hoàn tất giữa mỗi lần để không bị dedup gộp).
    for _ in range(3):
        r = _sync(client, auth_header, ws, email)
        assert r.status_code == 202, r.text
        _complete(client, ws, r.json()["queue_item_id"])
    # Lần thứ 4 cùng email → spam → cấm 10 phút.
    r4 = _sync(client, auth_header, ws, email)
    assert r4.status_code == 403, r4.text
    assert r4.json()["detail"]["code"] == "COMMAND_BANNED"
    # token_version đã bump → token cũ bị thu hồi → call tiếp 401.
    r5 = _sync(client, auth_header, ws, email)
    assert r5.status_code == 401
    # Login bị chặn trong thời gian cấm.
    login = client.post(
        "/api/v1/auth/login", json={"identifier": SUPER_USER, "password": SUPER_PW}
    )
    assert login.status_code == 403, login.text


def test_different_email_resets_streak(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "Reset WS")
    for _ in range(3):
        r = _sync(client, auth_header, ws, "aaa@example.com")
        assert r.status_code == 202
        _complete(client, ws, r.json()["queue_item_id"])
    # Chen 1 email KHÁC → reset chuỗi liên tiếp của aaa.
    rb = _sync(client, auth_header, ws, "bbb@example.com")
    assert rb.status_code == 202
    _complete(client, ws, rb.json()["queue_item_id"])
    # Quay lại aaa → KHÔNG bị ban vì chuỗi đã reset (bbb chen giữa).
    ra = _sync(client, auth_header, ws, "aaa@example.com")
    assert ra.status_code == 202, ra.text


def test_failed_task_not_counted(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "Retry WS")
    email = "retry@example.com"
    # Lặp 5 lần nhưng task nào cũng FAILED → KHÔNG tính spam → không bị ban.
    for _ in range(5):
        r = _sync(client, auth_header, ws, email)
        assert r.status_code == 202, r.text
        _fail(client, ws, r.json()["queue_item_id"])


# ---------- completion reconcile ----------


def _patch_queue(client: TestClient, ws: dict, task_id: str, found_in: str):
    return client.patch(
        f"/api/v1/queue/{task_id}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"email": "join@example.com", "found_in": found_in}},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )


def test_sync_member_active_promotes_status(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "Promote WS")
    _invite(client, auth_header, ws["id"], "join@example.com")
    assert _members(client, auth_header, ws["id"])["join@example.com"] == "pending"

    queued = client.post(
        f"/api/v1/workspaces/{ws['id']}/sync-member",
        json={"email": "join@example.com"},
        headers=auth_header,
    )
    assert queued.status_code == 202, queued.text
    task_id = queued.json()["queue_item_id"]

    resp = _patch_queue(client, ws, task_id, "active")
    assert resp.status_code == 200, resp.text
    assert _members(client, auth_header, ws["id"])["join@example.com"] == "active"


def test_sync_member_none_keeps_pending(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header, "None WS")
    _invite(client, auth_header, ws["id"], "join@example.com")

    queued = client.post(
        f"/api/v1/workspaces/{ws['id']}/sync-member",
        json={"email": "join@example.com"},
        headers=auth_header,
    )
    task_id = queued.json()["queue_item_id"]

    resp = _patch_queue(client, ws, task_id, "none")
    assert resp.status_code == 200, resp.text
    # KHÔNG mark removed, giữ pending.
    assert _members(client, auth_header, ws["id"])["join@example.com"] == "pending"
