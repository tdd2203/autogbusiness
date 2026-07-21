"""Hết hạn subscription — TỰ ĐỘNG xoá qua scheduler nền (user 2026-07-13).

Khi 1 email hết hạn (`subscription_end_at <= now`, active/pending) thì scheduler nền
`_enqueue_expired_removals_once` (main.py) tự enqueue task gỡ, KHÔNG cần admin confirm
tay. Nút "Dọn member hết hạn" (POST /cleanup-expired) vẫn còn để remove NGAY thay vì
chờ tick kế. File này kiểm: (a) scheduler auto-enqueue task gỡ cho member hết hạn +
idempotent, (b) mốc tính hạn = neo + 30 ngày.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog, Member, QueueItem


def _expire_member(email: str) -> None:
    """Ép member `email` hết hạn: đặt subscription_end_at về quá khứ."""
    with SessionLocal() as db:
        member = db.query(Member).filter(Member.email == email).one()
        member.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.commit()


def test_scheduler_auto_enqueues_removal_for_expired(
    client: TestClient, auth_header: dict
) -> None:
    """GUARD chính: member active hết hạn → tick nền tự enqueue REMOVE_MEMBER +
    audit MEMBER_EXPIRED_REMOVE_QUEUED, không cần admin bấm gì; chạy lần 2 KHÔNG
    đẻ task trùng (idempotent nhờ _has_open_remove_task)."""
    import app.main as m

    assert hasattr(m, "_enqueue_expired_removals_once"), (
        "Scheduler auto-remove khi hết hạn (user 2026-07-13) — đừng gỡ"
    )

    ws = client.post(
        "/api/v1/workspaces",
        json={"name": "WS auto-expire", "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "expired@example.com", "status": "active"}],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code in (200, 201), resp.text
    _expire_member("expired@example.com")

    m._enqueue_expired_removals_once()

    with SessionLocal() as db:
        tasks = (
            db.query(QueueItem)
            .filter(QueueItem.type == "REMOVE_MEMBER")
            .all()
        )
        assert len(tasks) == 1, [t.payload for t in tasks]
        assert tasks[0].payload["email"] == "expired@example.com"
        audits = (
            db.query(AuditLog)
            .filter(AuditLog.action == "MEMBER_EXPIRED_REMOVE_QUEUED")
            .all()
        )
        assert len(audits) == 1
        assert audits[0].actor_type == "SYSTEM"

    # Idempotent: tick lần 2 (member vẫn active tới khi extension xong) không đẻ trùng.
    m._enqueue_expired_removals_once()
    with SessionLocal() as db:
        tasks = db.query(QueueItem).filter(QueueItem.type == "REMOVE_MEMBER").all()
        assert len(tasks) == 1, "tick lần 2 không được đẻ task trùng"


def test_pending_expired_enqueues_revoke_not_remove(
    client: TestClient, auth_header: dict
) -> None:
    """Member `pending` hết hạn → REVOKE_INVITES (tab Lời mời trước), KHÔNG REMOVE_MEMBER."""
    import app.main as m

    ws = client.post(
        "/api/v1/workspaces",
        json={"name": "WS pending-expire", "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "pend@example.com", "status": "pending"}],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    _expire_member("pend@example.com")

    m._enqueue_expired_removals_once()

    with SessionLocal() as db:
        types = {t.type for t in db.query(QueueItem).all()}
        assert "REVOKE_INVITES" in types
        assert "REMOVE_MEMBER" not in types


def test_synced_email_expiry_is_anchor_plus_30(
    client: TestClient, auth_header: dict
) -> None:
    """Email SCRAPE/SYNC lần đầu → mốc neo "Ngày gia hạn" = giờ ghi nhận
    (subscription_purchased_at), hạn = mốc + 30 ngày CHÍNH XÁC tới giây (yêu cầu
    user: hết hạn = gia hạn + 30, KHÔNG còn chốt cuối ngày 23:59:59)."""
    ws = client.post(
        "/api/v1/workspaces",
        json={"name": "WS sync exp", "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "synced@example.com", "status": "active"}],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code in (200, 201), resp.text

    rows = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    m = next(r for r in rows if r["email"] == "synced@example.com")
    assert m["subscription_purchased_at"] is not None, m
    purchased = datetime.fromisoformat(m["subscription_purchased_at"])
    end = datetime.fromisoformat(m["subscription_end_at"])
    assert end == purchased + timedelta(days=30), (purchased, end)
