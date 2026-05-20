"""Demo: thử mời 2 email bất kỳ qua bulk-invite, in từng bước response.

Chạy:
    .\.venv\Scripts\python.exe -m pytest tests/test_invite_demo_two_emails.py -v -s

Chạy trên DB test riêng (conftest.py reset mỗi test) — KHÔNG đụng DB dev/prod.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient


def _dump(label: str, payload) -> None:
    print(f"\n--- {label} ---")
    print(json.dumps(payload, indent=2, default=str, ensure_ascii=False))


def test_invite_two_arbitrary_emails(
    client: TestClient, auth_header: dict
) -> None:
    EMAIL_A = "huong.nguyen@example.com"
    EMAIL_B = "tuan.le@example.com"

    # 1. Tạo workspace
    ws = client.post(
        "/api/v1/workspaces",
        json={"name": "Demo Invite WS", "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()
    _dump("Step 1 — Create workspace", {"id": ws["id"], "name": ws["name"]})

    # 2. Bulk-invite 2 emails (đúng giống dashboard gửi)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={
            "invites": [
                {"email": EMAIL_A, "subscription_months": 1},
                {"email": EMAIL_B, "subscription_months": 3},
            ],
            "role": "member",
        },
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text
    bulk_body = resp.json()
    _dump("Step 2 — POST /members/bulk-invite (202)", bulk_body)
    assert bulk_body["count"] == 2
    queue_item_id = bulk_body["queue_item_id"]

    # 3. Xem QueueItem extension sẽ pick up
    queue = client.get("/api/v1/queue?limit=10", headers=auth_header).json()
    task = next(q for q in queue if q["id"] == queue_item_id)
    _dump(
        "Step 3 — Queue task extension sẽ exec",
        {
            "id": task["id"],
            "type": task["type"],
            "status": task["status"],
            "payload": task["payload"],
        },
    )
    assert task["type"] == "INVITE_MEMBER"
    assert sorted(task["payload"]["emails"]) == sorted(
        [EMAIL_A.lower(), EMAIL_B.lower()]
    )
    assert task["payload"]["role"] == "member"

    # 4. Member rows đã tạo trên dashboard (status=pending)
    members = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    _dump(
        "Step 4 — Member rows trên dashboard",
        [
            {
                "email": m["email"],
                "status": m["status"],
                "chatgpt_role": m["chatgpt_role"],
                "subscription_months": m["subscription_months"],
                "joined_at": m["joined_at"],
            }
            for m in members
        ],
    )
    assert {m["email"] for m in members} == {EMAIL_A.lower(), EMAIL_B.lower()}
    assert all(m["status"] == "pending" for m in members)

    # 5. Giả lập extension HOÀN TẤT (verified cả 2)
    patch_resp = client.patch(
        f"/api/v1/queue/{queue_item_id}",
        json={
            "status": "COMPLETED",
            "result": {
                "verified_emails": [EMAIL_A.lower(), EMAIL_B.lower()],
                "unverified_emails": [],
                "verify_scrape_failed": False,
            },
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    _dump(
        "Step 5 — Extension PATCH COMPLETED (verified cả 2)",
        {
            "task_status": patch_resp.json()["status"],
            "result": patch_resp.json()["result"],
        },
    )

    final = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    _dump(
        "Step 6 — Member rows SAU verify (phải giữ nguyên 2 pending)",
        [{"email": m["email"], "status": m["status"]} for m in final],
    )
    assert len(final) == 2
