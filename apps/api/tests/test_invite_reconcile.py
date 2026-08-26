"""reconcile-after-invite — dọn phantom pending khi verify không thấy email."""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select


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


def _age_invite(ws_id: str, email: str, minutes: int) -> None:
    """Đẩy lùi mốc mời của member để ra khỏi vùng bảo vệ 10 phút."""
    from app.db import SessionLocal
    from app.models import Member

    old = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    with SessionLocal() as db:
        m = db.execute(
            select(Member).where(Member.email == email)
        ).scalar_one()
        assert str(m.workspace_id) == ws_id
        m.created_at = old
        m.last_invited_at = old
        db.commit()


def _audit_actions(email: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        rows = db.execute(select(AuditLog.action, AuditLog.data)).all()
    return [a for a, d in rows if email in str(d)]


def _members(client: TestClient, auth_header: dict, ws_id: str) -> dict[str, str]:
    rows = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=auth_header,
    ).json()
    return {r["email"]: r["status"] for r in rows}


def test_reconcile_removes_unverified_keeps_verified(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Reconcile WS")
    _invite(client, auth_header, ws["id"], "ok@example.com")
    _invite(client, auth_header, ws["id"], "ghost@example.com")
    # Ngoài vùng bảo vệ 10 phút → verify "không thấy" mới đủ căn cứ chốt hỏng.
    _age_invite(ws["id"], "ghost@example.com", minutes=30)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": ["ok@example.com"],
            "unverified_emails": ["ghost@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["removed"] == 1 and body["skipped"] is False
    assert body["deferred"] == 0

    statuses = _members(client, auth_header, ws["id"])
    assert statuses["ok@example.com"] == "pending"
    assert statuses["ghost@example.com"] == "removed"


def test_reconcile_defers_fresh_invite_instead_of_removing(
    client: TestClient, auth_header: dict
) -> None:
    """Ca thật 26/8/2026 (`mhlober`, task 8a2b9e4b): mẻ 9 email, verify chỉ thấy 8
    vì ChatGPT index chậm → email thứ 9 bị chốt removed+invite_failed 75 GIÂY sau
    khi mời, dù lời mời đã đi thật. Nay email tươi phải được HOÃN, giữ 'pending'."""
    ws = _ws(client, auth_header, "Reconcile Fresh WS")
    _invite(client, auth_header, ws["id"], "slowindex@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["slowindex@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["removed"] == 0
    assert body["deferred"] == 1
    assert body["deferred_emails"] == ["slowindex@example.com"]

    # Member GIỮ pending (không removed, không invite_failed).
    assert _members(client, auth_header, ws["id"])["slowindex@example.com"] == "pending"

    # Có dấu vết để tra: cùng sự kiện guard mà completion.py dùng.
    assert "MEMBER_INVITE_CLEANUP_DEFERRED" in _audit_actions("slowindex@example.com")


def test_reconcile_defer_does_not_stamp_last_synced_at(
    client: TestClient, auth_header: dict
) -> None:
    """Hoãn KHÔNG được chạm `last_synced_at`: resolver nền (`main.py`) coi mốc đó
    mới hơn lần hoãn là bằng chứng "đồng bộ đã thấy email" → lời mời hỏng thật sẽ
    được tha bổng và không ai hoàn phí."""
    from app.db import SessionLocal
    from app.models import Member

    ws = _ws(client, auth_header, "Reconcile Defer Stamp WS")
    _invite(client, auth_header, ws["id"], "nostamp@example.com")

    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["nostamp@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    with SessionLocal() as db:
        m = db.execute(
            select(Member).where(Member.email == "nostamp@example.com")
        ).scalar_one()
        assert m.last_synced_at is None
        assert m.removed_at is None and m.removed_reason is None


def test_reconcile_mixed_fresh_and_stale(
    client: TestClient, auth_header: dict
) -> None:
    """Một mẻ có cả email tươi lẫn email cũ → xử lý riêng từng email."""
    ws = _ws(client, auth_header, "Reconcile Mixed WS")
    _invite(client, auth_header, ws["id"], "fresh@example.com")
    _invite(client, auth_header, ws["id"], "stale@example.com")
    _age_invite(ws["id"], "stale@example.com", minutes=30)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["fresh@example.com", "stale@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    body = resp.json()
    assert body["removed"] == 1
    assert body["deferred_emails"] == ["fresh@example.com"]

    statuses = _members(client, auth_header, ws["id"])
    assert statuses["fresh@example.com"] == "pending"
    assert statuses["stale@example.com"] == "removed"


def test_reconcile_defers_reinvited_member_with_old_created_at(
    client: TestClient, auth_header: dict
) -> None:
    """Member re-invite giữ `created_at` CŨ → phải neo theo `last_invited_at`,
    nếu không lại rơi đúng bẫy đã fix ngày 2026-06-17 ở khối reconcile."""
    from app.db import SessionLocal
    from app.models import Member

    ws = _ws(client, auth_header, "Reconcile Reinvite WS")
    _invite(client, auth_header, ws["id"], "again@example.com")
    with SessionLocal() as db:
        m = db.execute(
            select(Member).where(Member.email == "again@example.com")
        ).scalar_one()
        m.created_at = datetime.now(timezone.utc) - timedelta(days=40)
        db.commit()

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["again@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.json()["deferred"] == 1
    assert _members(client, auth_header, ws["id"])["again@example.com"] == "pending"


def test_reconcile_skips_when_scrape_failed(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Reconcile Skip WS")
    _invite(client, auth_header, ws["id"], "keep@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["keep@example.com"],
            "verify_scrape_failed": True,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"removed": 0, "skipped": True}
    # Scrape fail → KHÔNG xoá, giữ pending
    assert _members(client, auth_header, ws["id"])["keep@example.com"] == "pending"


def test_reconcile_does_not_touch_active_member(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "Reconcile Active WS")
    # active member (đã trong team) qua bulk-upsert extension
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": "active@example.com", "status": "active"}]},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={
            "verified_emails": [],
            "unverified_emails": ["active@example.com"],
            "verify_scrape_failed": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    # active KHÔNG bị đụng (chỉ pending mới bị remove)
    assert resp.json()["removed"] == 0
    assert _members(client, auth_header, ws["id"])["active@example.com"] == "active"


def test_reconcile_wrong_key_rejected(
    client: TestClient, auth_header: dict
) -> None:
    ws_a = _ws(client, auth_header, "RA")
    ws_b = _ws(client, auth_header, "RB")
    resp = client.post(
        f"/api/v1/workspaces/{ws_a['id']}/members/reconcile-after-invite",
        json={"verified_emails": [], "unverified_emails": [], "verify_scrape_failed": False},
        headers={"X-API-KEY": ws_b["extension_api_key"]},
    )
    assert resp.status_code == 403
