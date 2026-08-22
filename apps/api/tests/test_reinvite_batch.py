"""Mời lại HÀNG LOẠT — POST /workspaces/{ws}/members/re-invite-batch.

Yêu cầu user 2026-08-22: chọn nhiều email ở tab "Chờ tham gia" thì phải có lệnh "Mời
lại" (trước chỉ có Đồng bộ + Thu hồi). Quy tắc chốt:
  - CHỈ email CÒN HẠN được mời lại → MIỄN PHÍ, giữ nguyên cửa sổ hạn.
  - Email HẾT HẠN bị BỎ QUA (trả `skipped_expired`) — lệnh hàng loạt không bao giờ
    trừ ví / bật modal QR giữa chừng; muốn mời lại thì làm từng dòng.
  - Member `active` bị bỏ qua (`skipped_active`), TRỪ khi lần đồng bộ gần nhất không
    thấy email trong workspace (`sync_missing_at`).
  - ChatGPT 1 vai trò / dialog → gom theo `chatgpt_role`, mỗi nhóm 1 task.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import bearer, create_ws, set_settings

FEE = 100_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _token(auth_header: dict) -> str:
    return auth_header["Authorization"].split()[1]


def _invite(
    client: TestClient, auth_header: dict, ws_id: str, email: str, role: str = "member"
) -> dict:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": role, "subscription_months": 1},
        headers=auth_header,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _batch(client: TestClient, auth_header: dict, ws_id: str, ids: list[str]):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/re-invite-batch",
        json={"member_ids": ids},
        headers=auth_header,
    )


def _expire(client: TestClient, auth_header: dict, ws_id: str, member_id: str) -> None:
    """Đẩy hạn về quá khứ qua endpoint đổi hạn (mốc cụ thể)."""
    past = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    r = client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json={"subscription_end_at": past},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text


def test_batch_reinvites_valid_and_skips_expired(
    client: TestClient, auth_header: dict
) -> None:
    """2 email còn hạn → mời lại; 1 email hết hạn → bỏ qua + báo số."""
    ws = create_ws(client, auth_header, "Reinvite Batch WS")
    a = _invite(client, auth_header, ws["id"], "a@example.com")
    b = _invite(client, auth_header, ws["id"], "b@example.com")
    c = _invite(client, auth_header, ws["id"], "c@example.com")
    _expire(client, auth_header, ws["id"], c["id"])

    resp = _batch(client, auth_header, ws["id"], [a["id"], b["id"], c["id"]])
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["count"] == 2
    assert body["skipped_expired"] == 1
    assert body["skipped_active"] == 0
    assert len(body["queue_item_ids"]) == 1  # cùng vai trò "member" → 1 task

    tasks = client.get("/api/v1/queue?limit=50", headers=auth_header).json()
    task = next(t for t in tasks if t["id"] == body["queue_item_ids"][0])
    assert task["type"] == "INVITE_MEMBER"
    assert task["payload"]["reinvite"] is True
    assert sorted(task["payload"]["emails"]) == ["a@example.com", "b@example.com"]


def test_batch_reinvite_is_free_for_valid_period(
    client: TestClient, auth_header: dict
) -> None:
    """Email còn hạn → KHÔNG trừ ví, giữ nguyên hạn cũ."""
    ws = create_ws(client, auth_header, "Reinvite Batch Free WS")
    m = _invite(client, auth_header, ws["id"], "free@example.com")
    before = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    end_before = next(x for x in before if x["id"] == m["id"])["subscription_end_at"]

    resp = _batch(client, auth_header, ws["id"], [m["id"]])
    assert resp.status_code == 202, resp.text
    assert resp.json()["count"] == 1

    after = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    row = next(x for x in after if x["id"] == m["id"])
    assert row["subscription_end_at"] == end_before  # cửa sổ hạn KHÔNG đổi
    assert row["status"] == "pending"


def test_batch_groups_by_role(client: TestClient, auth_header: dict) -> None:
    """2 vai trò khác nhau → 2 task (ChatGPT chỉ cho 1 vai trò / dialog)."""
    ws = create_ws(client, auth_header, "Reinvite Batch Role WS")
    m1 = _invite(client, auth_header, ws["id"], "r1@example.com", role="member")
    m2 = _invite(client, auth_header, ws["id"], "r2@example.com", role="admin")
    resp = _batch(client, auth_header, ws["id"], [m1["id"], m2["id"]])
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["count"] == 2
    assert len(body["queue_item_ids"]) == 2


def test_batch_skips_active_members(client: TestClient, auth_header: dict) -> None:
    """Member đang là thành viên thật → bỏ qua (`skipped_active`), không tạo task."""
    ws = create_ws(client, auth_header, "Reinvite Batch Active WS")
    m = _invite(client, auth_header, ws["id"], "act@example.com")
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": "act@example.com",
                    "name": None,
                    "chatgpt_role": "member",
                    "status": "active",
                    "joined_at": "2026-05-19T10:00:00+00:00",
                }
            ],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    resp = _batch(client, auth_header, ws["id"], [m["id"]])
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["count"] == 0
    assert body["skipped_active"] == 1
    assert body["queue_item_ids"] == []


def test_batch_sub_admin_only_sees_own_members(
    client: TestClient, auth_header: dict
) -> None:
    """Visibility filter: member của chủ khác → tính vào `skipped_missing`."""
    from tests.wallet_helpers import assign, create_user, login

    ws = create_ws(client, auth_header, "Reinvite Batch Vis WS")
    mine = _invite(client, auth_header, ws["id"], "mine@example.com")
    other = create_user(
        client, auth_header, "subinv", ["MEMBER_VIEW", "MEMBER_INVITE"]
    )
    assign(client, auth_header, ws["id"], other["id"])
    token = login(client, "subinv")
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/re-invite-batch",
        json={"member_ids": [mine["id"]]},
        headers=bearer(token),
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["count"] == 0
    assert body["skipped_missing"] == 1
