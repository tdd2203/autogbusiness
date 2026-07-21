"""REVOKE_INVITES completion — chỉ mark 'removed' email THỰC SỰ thu hồi được.

Bug user 2026-07-13: extension báo COMPLETED dù không thu hồi được (menu ChatGPT
thiếu mục 'Thu hồi lời mời') → backend mark member 'removed' oan dù lời mời vẫn còn.
FIX: completion đọc result.data.results[].ok — chỉ email ok=true mới removed; email
fail hoặc extension cũ (không có results) → giữ 'pending'.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Revoke WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _invite_pending(client, ws, email, auth_header):
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": email, "role": "member", "subscription_months": 1},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text


def _revoke_task(client, ws, emails, auth_header) -> str:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/revoke-invites",
        json={"emails": emails},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    return resp.json()["queue_item_id"]


def _complete(client, ws, task_id, result):
    resp = client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "COMPLETED", "result": result},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _member(client, ws, email, auth_header) -> dict:
    resp = client.get(
        f"/api/v1/workspaces/{ws['id']}/members?include_removed=true",
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    return next(m for m in resp.json() if m["email"] == email)


def test_revoke_failed_keeps_member_pending(client: TestClient, auth_header: dict):
    """Thu hồi THẤT BẠI (revoked=0, results ok=false) → member GIỮ pending, không removed."""
    ws = _create_workspace(client, auth_header)
    _invite_pending(client, ws, "fail@example.com", auth_header)
    task_id = _revoke_task(client, ws, ["fail@example.com"], auth_header)
    _complete(
        client,
        ws,
        task_id,
        {
            "data": {
                "revoked": 0,
                "failed": 1,
                "results": [
                    {
                        "ok": False,
                        "email": "fail@example.com",
                        "reason": "Menu mở nhưng không có item Thu hồi",
                    }
                ],
            }
        },
    )
    assert _member(client, ws, "fail@example.com", auth_header)["status"] == "pending"


def test_revoke_success_marks_removed(client: TestClient, auth_header: dict):
    """Thu hồi THÀNH CÔNG (results ok=true) → member 'removed'."""
    ws = _create_workspace(client, auth_header)
    _invite_pending(client, ws, "ok@example.com", auth_header)
    task_id = _revoke_task(client, ws, ["ok@example.com"], auth_header)
    _complete(
        client,
        ws,
        task_id,
        {"data": {"revoked": 1, "failed": 0, "results": [{"ok": True, "email": "ok@example.com"}]}},
    )
    assert _member(client, ws, "ok@example.com", auth_header)["status"] == "removed"


def test_revoke_partial_only_success_removed(client: TestClient, auth_header: dict):
    """Thu hồi 1 phần: chỉ email ok=true bị removed, email fail giữ pending."""
    ws = _create_workspace(client, auth_header)
    _invite_pending(client, ws, "good@example.com", auth_header)
    _invite_pending(client, ws, "bad@example.com", auth_header)
    task_id = _revoke_task(
        client, ws, ["good@example.com", "bad@example.com"], auth_header
    )
    _complete(
        client,
        ws,
        task_id,
        {
            "data": {
                "revoked": 1,
                "failed": 1,
                "results": [
                    {"ok": True, "email": "good@example.com"},
                    {"ok": False, "email": "bad@example.com", "reason": "no menu item"},
                ],
            }
        },
    )
    assert _member(client, ws, "good@example.com", auth_header)["status"] == "removed"
    assert _member(client, ws, "bad@example.com", auth_header)["status"] == "pending"


def test_revoke_no_results_conservative_keeps_pending(
    client: TestClient, auth_header: dict
):
    """Extension cũ không trả result.data.results → thiếu căn cứ → GIỮ pending (an toàn)."""
    ws = _create_workspace(client, auth_header)
    _invite_pending(client, ws, "old@example.com", auth_header)
    task_id = _revoke_task(client, ws, ["old@example.com"], auth_header)
    _complete(client, ws, task_id, {"ok": True})
    assert _member(client, ws, "old@example.com", auth_header)["status"] == "pending"
