"""Đặt giới hạn tín dụng — DUYỆT + NGÂN SÁCH (sub-admin).

Xác minh:
  - Sub-admin tạo lệnh → task approval_status='pending', extension KHÔNG pick.
  - Ngân sách: tổng giới hạn (gồm yêu cầu đang chờ) không vượt credit_budget → 400.
  - Super-admin approve → task PENDING approved, extension pick được, COMPLETED →
    Member.usage_limit_credits sync.
  - Super-admin reject → task FAILED, không bao giờ chạy.
  - Super-admin tự đặt → approval_status NULL, chạy ngay (không cần duyệt).
"""

from fastapi.testclient import TestClient


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, identifier: str, password: str) -> str:
    resp = client.post(
        "/api/v1/auth/login", json={"identifier": identifier, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _ws(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "UL Approval WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _sub(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "username": "ulsub",
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE", "MEMBER_SET_USAGE_LIMIT"],
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return {"id": resp.json()["id"], "token": _login(client, "ulsub", "SubPassword123!")}


def _assign(client: TestClient, auth_header: dict, ws_id: str, user_id: str, budget: int) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id, "credit_budget": budget},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["credit_budget"] == budget


def _sub_invites_active(
    client: TestClient, ws: dict, sub_headers: dict, emails: list[str]
) -> None:
    """Sub-admin mời (pending, invited_by=sub) → super-admin upsert active (giữ invited_by)."""
    inv = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=sub_headers,
    )
    assert inv.status_code == 202, inv.text
    up = client.post(
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
    assert up.status_code == 200, up.text
    # bulk-invite tạo task INVITE_MEMBER → drain để queue sạch (FIFO không nhiễu khi
    # test pick task SET_USAGE_LIMIT).
    _drain_queue(client, ws)


def _drain_queue(client: TestClient, ws: dict) -> None:
    key = {"X-API-KEY": ws["extension_api_key"]}
    for _ in range(50):
        r = client.get("/api/v1/queue/next", headers=key)
        t = r.json()
        if not t:
            break
        client.patch(
            f"/api/v1/queue/{t['id']}",
            json={"status": "COMPLETED", "result": {}},
            headers=key,
        )


def _ul_tasks(client: TestClient, ws_id: str, auth_header: dict) -> list[dict]:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=auth_header)
    assert resp.status_code == 200, resp.text
    return [t for t in resp.json() if t["type"] == "SET_USAGE_LIMIT"]


def _member_limit(client: TestClient, ws_id: str, auth_header: dict, email: str):
    resp = client.get(f"/api/v1/workspaces/{ws_id}/members", headers=auth_header)
    assert resp.status_code == 200, resp.text
    for m in resp.json():
        if m["email"] == email:
            return m["usage_limit_credits"]
    return None


def test_subadmin_request_pending_budget_and_approval(
    client: TestClient, auth_header: dict
):
    ws = _ws(client, auth_header)
    sub = _sub(client, auth_header)
    _assign(client, auth_header, ws["id"], sub["id"], budget=200)
    sub_h = _bearer(sub["token"])
    _sub_invites_active(client, ws, sub_h, ["m1@example.com", "m2@example.com"])

    # 1) Sub-admin đặt 150 cho m1 → chờ duyệt, member CHƯA sync.
    r1 = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["m1@example.com"], "limit_credits": 150},
        headers=sub_h,
    )
    assert r1.status_code == 202, r1.text
    assert r1.json()["count"] == 1
    assert r1.json()["pending_approval"] is True
    assert _member_limit(client, ws["id"], auth_header, "m1@example.com") is None

    tasks = _ul_tasks(client, ws["id"], auth_header)
    assert len(tasks) == 1
    task = tasks[0]
    assert task["approval_status"] == "pending"

    # 2) Extension KHÔNG pick task chờ duyệt.
    pick = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": ws["extension_api_key"]}
    )
    assert pick.status_code == 200
    assert pick.json() is None

    # 3) Budget: 150 (đang chờ) + 100 (m2) = 250 > 200 → 400.
    over = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["m2@example.com"], "limit_credits": 100},
        headers=sub_h,
    )
    assert over.status_code == 400, over.text

    # 3b) 150 + 50 = 200 ≤ 200 → OK.
    ok = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["m2@example.com"], "limit_credits": 50},
        headers=sub_h,
    )
    assert ok.status_code == 202, ok.text

    # 4) Budget endpoint: used = 200, remaining = 0.
    budget = client.get(
        f"/api/v1/workspaces/{ws['id']}/members/usage-limit-budget", headers=sub_h
    )
    assert budget.status_code == 200, budget.text
    b = budget.json()
    assert b["budget"] == 200 and b["used"] == 200 and b["remaining"] == 0

    # 5) Super-admin DUYỆT task m1 → approved, vẫn PENDING.
    appr = client.post(f"/api/v1/queue/{task['id']}/approve", headers=auth_header)
    assert appr.status_code == 202, appr.text
    assert appr.json()["approval_status"] == "approved"

    # 6) Extension giờ pick được task đã duyệt.
    pick2 = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": ws["extension_api_key"]}
    )
    assert pick2.status_code == 200
    picked = pick2.json()
    assert picked is not None and picked["id"] == task["id"]

    # 7) Extension báo COMPLETED → Member.usage_limit_credits sync.
    done = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": {"ok": True}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert done.status_code == 200, done.text
    assert _member_limit(client, ws["id"], auth_header, "m1@example.com") == 150


def test_subadmin_reject_blocks_task(client: TestClient, auth_header: dict):
    ws = _ws(client, auth_header)
    sub = _sub(client, auth_header)
    _assign(client, auth_header, ws["id"], sub["id"], budget=500)
    sub_h = _bearer(sub["token"])
    _sub_invites_active(client, ws, sub_h, ["r1@example.com"])

    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["r1@example.com"], "limit_credits": 99},
        headers=sub_h,
    )
    task = _ul_tasks(client, ws["id"], auth_header)[0]

    rej = client.post(f"/api/v1/queue/{task['id']}/reject", headers=auth_header)
    assert rej.status_code == 202, rej.text
    assert rej.json()["status"] == "FAILED"

    # Extension không pick task đã FAILED; member không bị sync.
    pick = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": ws["extension_api_key"]}
    )
    assert pick.json() is None
    assert _member_limit(client, ws["id"], auth_header, "r1@example.com") is None


def test_subadmin_zero_budget_blocks(client: TestClient, auth_header: dict):
    ws = _ws(client, auth_header)
    sub = _sub(client, auth_header)
    _assign(client, auth_header, ws["id"], sub["id"], budget=0)  # mặc định/không cấp
    sub_h = _bearer(sub["token"])
    _sub_invites_active(client, ws, sub_h, ["z1@example.com"])

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["z1@example.com"], "limit_credits": 1},
        headers=sub_h,
    )
    assert resp.status_code == 400, resp.text


def test_superadmin_no_approval_needed(client: TestClient, auth_header: dict):
    ws = _ws(client, auth_header)
    # Super-admin upsert active member trực tiếp.
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": "s1@example.com", "name": "s1",
                           "chatgpt_role": "member", "status": "active"}]},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-set-usage-limit",
        json={"emails": ["s1@example.com"], "limit_credits": 9999},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["pending_approval"] is False
    task = _ul_tasks(client, ws["id"], auth_header)[0]
    assert task["approval_status"] is None
    # Extension pick được ngay (không cần duyệt).
    pick = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": ws["extension_api_key"]}
    )
    assert pick.json()["id"] == task["id"]
