"""Retention 30 ngày cho member đã 'removed' (yêu cầu user 2026-07-12).

Email bị xoá → giữ record + lịch sử 30 ngày (xem lại được, mời lại vẫn thấy lịch
sử removed). Quá 30 ngày kể từ lúc removed → job nền hard-delete record + audit
log RIÊNG của email. Mời lại sau đó = record `member.id` mới, lịch sử sạch.

Kiểm: (1) removed_at set khi xoá; (2) mời lại clear removed_at; (3) purge xoá
member quá hạn + audit log của nó; (4) giữ member removed gần đây + member active.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import _purge_old_removed_members_once
from app.models import AuditLog, Member


def _ws(client: TestClient, auth_header: dict, name: str = "Retention WS") -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 25},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _invite(client: TestClient, auth_header: dict, ws_id: str, email: str) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _remove_complete(
    client: TestClient, auth_header: dict, ws: dict, member_id: str
) -> None:
    """DELETE + giả lập extension hoàn tất → status='removed', removed_at set.

    Member pending → task REVOKE_INVITES (tab Lời mời); active → REMOVE_MEMBER. Nhận cả
    hai; với REVOKE cần result.data.results[].ok để completion mark removed thật."""
    assert (
        client.delete(
            f"/api/v1/workspaces/{ws['id']}/members/{member_id}", headers=auth_header
        ).status_code
        == 202
    )
    queue = client.get("/api/v1/queue?limit=50", headers=auth_header).json()
    task = next(
        q
        for q in queue
        if q["type"] in ("REMOVE_MEMBER", "REVOKE_INVITES")
        and q["status"] == "PENDING"
    )
    if task["type"] == "REVOKE_INVITES":
        result = {
            "data": {"results": [{"email": e, "ok": True} for e in task["payload"]["emails"]]}
        }
    else:
        # CONTRACT v0.9.22: REMOVE_MEMBER mark removed cần result.data.verified.
        result = {"data": {"verified": True}}
    resp = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": result},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def test_removed_at_set_on_removal(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header)
    m = _invite(client, auth_header, ws["id"], "gone@example.com")
    _remove_complete(client, auth_header, ws, m["id"])

    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(m["id"]))
        assert row.status == "removed"
        assert row.removed_at is not None


def test_reinvite_clears_removed_at(client: TestClient, auth_header: dict) -> None:
    ws = _ws(client, auth_header)
    m = _invite(client, auth_header, ws["id"], "back@example.com")
    _remove_complete(client, auth_header, ws, m["id"])
    # Mời lại → removed_at phải về NULL (reset mốc retention).
    _invite(client, auth_header, ws["id"], "back@example.com")

    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(m["id"]))
        assert row.status == "pending"
        assert row.removed_at is None


def test_purge_hard_deletes_removed_after_retention(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header)
    m = _invite(client, auth_header, ws["id"], "purge@example.com")
    member_id = m["id"]
    _remove_complete(client, auth_header, ws, member_id)

    # Backdate removed_at về quá hạn (91 ngày trước — retention 90 ngày).
    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(member_id))
        row.removed_at = datetime.now(timezone.utc) - timedelta(days=91)
        db.commit()
        # Có ít nhất 1 audit log đơn-mục của member (INVITE/REMOVE...).
        before = db.execute(
            select(AuditLog).where(
                AuditLog.target_type == "MEMBER",
                AuditLog.target_id == member_id,
            )
        ).scalars().all()
        assert len(before) > 0

    _purge_old_removed_members_once()

    with SessionLocal() as db:
        assert db.get(Member, uuid.UUID(member_id)) is None  # record xoá hẳn
        after = db.execute(
            select(AuditLog).where(
                AuditLog.target_type == "MEMBER",
                AuditLog.target_id == member_id,
            )
        ).scalars().all()
        assert after == []  # lịch sử riêng của email cũng bị dọn


def test_purge_keeps_recent_removed_and_active(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header)
    recent = _invite(client, auth_header, ws["id"], "recent@example.com")
    active = _invite(client, auth_header, ws["id"], "active@example.com")
    _remove_complete(client, auth_header, ws, recent["id"])

    # recent: removed nhưng mới 5 ngày → GIỮ. active: chưa removed → GIỮ.
    with SessionLocal() as db:
        db.get(Member, uuid.UUID(recent["id"])).removed_at = (
            datetime.now(timezone.utc) - timedelta(days=5)
        )
        db.commit()

    _purge_old_removed_members_once()

    with SessionLocal() as db:
        assert db.get(Member, uuid.UUID(recent["id"])) is not None
        assert db.get(Member, uuid.UUID(active["id"])) is not None
