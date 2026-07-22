"""Nút "Lời mời chờ xử lý" (SYNC_DATA scope=invites) → tự truy tab "Người dùng".

Yêu cầu user 2026-07-22: quét tab "Lời mời đang chờ xử lý" trên ChatGPT rồi ĐỐI
CHIẾU với danh sách "chờ tham gia" của dashboard. Email dashboard đang pending mà
KHÔNG còn ở tab Lời mời → gom lại, enqueue SYNC_MEMBERS_BATCH để extension lọc
tiếp trong tab "Người dùng": thấy ⇒ đã tham gia, không thấy ⇒ giữ pending.

Trước fix: quét-chỉ-tab-Lời-mời không kết luận gì về nhóm lệch (guard chống mất
member 2026-07-13) → phải bấm thêm "Đồng bộ cả 2" mới biết ai đã tham gia.

Xem app/routers/members/reconcile.py + app/routers/queue/completion.py.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    ).json()


def _seed_pending(client: TestClient, key: dict, ws_id: str, emails: list[str]) -> None:
    """Dựng member 'pending' qua bulk-upsert (không reconcile)."""
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-upsert",
        json={
            "members": [{"email": e, "status": "pending"} for e in emails],
            "is_full_sync": False,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text


def _mark_invited_by_dashboard(ws_id: str, emails: list[str], *, aged: bool) -> None:
    """Gán `invited_by_user_id` (= mời qua dashboard) + tuổi của lời mời.

    Vùng bảo vệ 10' chỉ áp cho member CÓ `invited_by_user_id` — member do sync dựng
    (invited_by NULL) không có khái niệm "lời mời vừa gửi". `aged=False` giữ mốc
    hiện tại (lời mời vừa gửi), `aged=True` đẩy lùi 2h (đã quá vùng bảo vệ).
    """
    from sqlalchemy import select, update

    from app.db import SessionLocal
    from app.models import Member, User

    ts = datetime.now(timezone.utc) - (timedelta(hours=2) if aged else timedelta())
    with SessionLocal() as db:
        admin_id = db.execute(select(User.id)).scalars().first()
        db.execute(
            update(Member)
            .where(Member.email.in_(emails))
            .values(
                created_at=ts, last_invited_at=ts, invited_by_user_id=admin_id
            )
        )
        db.commit()


def _queue_item(task_id: str) -> dict:
    """Đọc thẳng QueueItem từ DB — router queue nằm ở /api/v1/queue (không theo ws)."""
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        item = db.get(QueueItem, task_id)
        assert item is not None, f"Không thấy queue item {task_id}"
        return {"type": item.type, "payload": item.payload}


def _scan_invites_tab(client: TestClient, key: dict, ws_id: str, seen: list[str]) -> dict:
    """Mô phỏng extension quét XONG tab Lời mời (scope=invites) và gửi reconcile."""
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["pending"],
            "reconcile_emails": seen,
            "reconcile_pending_emails": seen,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _statuses(client: TestClient, auth_header: dict, ws_id: str) -> dict[str, str]:
    rows = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=auth_header,
    ).json()
    return {r["email"]: r["status"] for r in rows}


def test_vanished_from_invites_tab_queues_users_tab_lookup(
    client: TestClient, auth_header: dict
) -> None:
    """2 pending, tab Lời mời chỉ còn 1 → email lệch được đẩy đi tra tab Người dùng."""
    ws = _ws(client, auth_header, "Invite Sync WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    still_waiting = "waiting@example.com"
    joined = "joined@example.com"
    _seed_pending(client, key, ws["id"], [still_waiting, joined])
    _mark_invited_by_dashboard(ws["id"], [still_waiting, joined], aged=True)

    body = _scan_invites_tab(client, key, ws["id"], [still_waiting])

    # Email lệch được gom lại → 1 task tra tab Người dùng.
    assert body["joined_check_count"] == 1, body
    task_id = body["joined_check_task_id"]
    assert task_id

    # KHÔNG ai bị mark removed chỉ vì vắng mặt ở tab Lời mời (guard 2026-07-13).
    statuses = _statuses(client, auth_header, ws["id"])
    assert statuses[joined] == "pending"
    assert statuses[still_waiting] == "pending"

    # Task đúng loại + đúng payload.
    task = _queue_item(task_id)
    assert task["type"] == "SYNC_MEMBERS_BATCH"
    assert task["payload"]["emails"] == [joined]
    assert task["payload"]["source"] == "invite_sync_diff"

    # Extension báo tìm THẤY trong tab Người dùng → promote sang active.
    resp = client.patch(
        f"/api/v1/queue/{task_id}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"results": [{"email": joined, "found_in": "active"}]}},
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    statuses = _statuses(client, auth_header, ws["id"])
    assert statuses[joined] == "active"
    assert statuses[still_waiting] == "pending"


def test_not_found_in_users_tab_stays_pending(
    client: TestClient, auth_header: dict
) -> None:
    """Không thấy ở tab Người dùng → GIỮ pending, tuyệt đối không xoá."""
    ws = _ws(client, auth_header, "Invite Sync WS 2")
    key = {"X-API-KEY": ws["extension_api_key"]}
    ghost = "ghost@example.com"
    _seed_pending(client, key, ws["id"], [ghost])
    _mark_invited_by_dashboard(ws["id"], [ghost], aged=True)

    body = _scan_invites_tab(client, key, ws["id"], [])
    assert body["joined_check_count"] == 1, body

    resp = client.patch(
        f"/api/v1/queue/{body['joined_check_task_id']}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"results": [{"email": ghost, "found_in": "pending"}]}},
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert _statuses(client, auth_header, ws["id"])[ghost] == "pending"


def test_fresh_invite_not_chased(client: TestClient, auth_header: dict) -> None:
    """Lời mời vừa gửi (<10') chưa kịp index vào tab Lời mời → KHÔNG coi là lệch."""
    ws = _ws(client, auth_header, "Invite Sync WS 3")
    key = {"X-API-KEY": ws["extension_api_key"]}
    fresh = "fresh@example.com"
    _seed_pending(client, key, ws["id"], [fresh])
    _mark_invited_by_dashboard(ws["id"], [fresh], aged=False)

    body = _scan_invites_tab(client, key, ws["id"], [])
    assert body["joined_check_count"] == 0, body
    assert body["joined_check_task_id"] is None


def test_full_scope_sync_does_not_chain(client: TestClient, auth_header: dict) -> None:
    """Scope 'both' đã quét tab Người dùng rồi → không cần task tra thêm."""
    ws = _ws(client, auth_header, "Invite Sync WS 4")
    key = {"X-API-KEY": ws["extension_api_key"]}
    gone = "gone@example.com"
    _seed_pending(client, key, ws["id"], [gone])
    _mark_invited_by_dashboard(ws["id"], [gone], aged=True)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [],
            "scraped_statuses": ["active", "pending"],
            "reconcile_emails": [],
            "reconcile_pending_emails": [],
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["joined_check_count"] == 0, resp.text
