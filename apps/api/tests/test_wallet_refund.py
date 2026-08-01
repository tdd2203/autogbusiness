"""US2 — Hoàn phí khi mời thất bại (idempotent). Phủ FR-018, SC-005.

Refund gắn ở queue/completion.py: task INVITE_MEMBER FAILED → hoàn toàn bộ; COMPLETED
có unverified_emails → hoàn đúng các email đó; re-PATCH terminal → không hoàn 2 lần.
"""

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import assign, bearer, create_ws, make_beta_sub, set_settings, wallet_of

FEE = 100_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    """Ghim phí = 100k (mặc định hệ thống giờ 380k) để ví đủ → trừ thẳng → có phí hoàn."""
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _bulk(client: TestClient, token: str, ws_id: str, emails: list[str]) -> dict:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()


def _patch_queue(client: TestClient, api_key: str, item_id: str, body: dict):
    return client.patch(
        f"/api/v1/queue/{item_id}", json=body, headers={"X-API-KEY": api_key}
    )


def _backdate_members(ws_id: str, emails: list[str], minutes: int = 11) -> None:
    """Lùi mốc mời để vượt GUARD 10 PHÚT của phantom-cleanup (completion.py, fix
    2026-07-13): member 'tươi' <10′ lọt unverified được GIỮ chờ sync phân xử —
    KHÔNG xoá + KHÔNG hoàn phí ngay. Test chạy tức thì nên phải giả lập member cũ."""
    import uuid
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Member

    past = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    with SessionLocal() as db:
        rows = (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws_id),
                Member.email.in_([e.lower() for e in emails]),
            )
            .all()
        )
        for m in rows:
            m.last_invited_at = past
            m.created_at = past
        db.commit()


def test_refund_all_on_failed(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Refund WS")
    sub = make_beta_sub(client, auth_header, username="reffail", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["r1@example.com", "r2@example.com", "r3@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == 0

    r = _patch_queue(
        client, ws["extension_api_key"], res["queue_item_id"],
        {"status": "FAILED", "error_code": "UI_ELEMENT_NOT_FOUND"},
    )
    assert r.status_code == 200, r.text

    # Hoàn toàn bộ 3 × phí → về 300k; có 3 giao dịch invite_refund.
    assert wallet_of(client, sub["token"])["balance"] == 300_000
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    assert len([t for t in txns if t["kind"] == "invite_refund"]) == 3


def test_refund_partial_on_completed_unverified(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Partial WS")
    sub = make_beta_sub(client, auth_header, username="refpartial", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["p1@example.com", "p2@example.com", "p3@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == 0

    # Vượt guard 10′ (unverified tươi được GIỮ + chưa hoàn phí, chờ sync phân xử).
    _backdate_members(ws["id"], ["p1@example.com", "p2@example.com", "p3@example.com"])

    # COMPLETED nhưng p2 không verify được → chỉ hoàn phí p2.
    r = _patch_queue(
        client, ws["extension_api_key"], res["queue_item_id"],
        {"status": "COMPLETED", "result": {"unverified_emails": ["p2@example.com"]}},
    )
    assert r.status_code == 200, r.text

    assert wallet_of(client, sub["token"])["balance"] == FEE  # hoàn 1 email
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    refunds = [t for t in txns if t["kind"] == "invite_refund"]
    assert len(refunds) == 1
    assert refunds[0]["meta"]["email"] == "p2@example.com"


def test_refund_idempotent_on_reterminal(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Idem Refund WS")
    sub = make_beta_sub(client, auth_header, username="refidem", balance=100_000)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["i1@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == 0

    key = ws["extension_api_key"]
    first = _patch_queue(client, key, res["queue_item_id"], {"status": "FAILED"})
    assert first.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 100_000

    # Re-PATCH task đã terminal → guard trả nguyên trạng, KHÔNG hoàn lần 2.
    again = _patch_queue(client, key, res["queue_item_id"], {"status": "FAILED"})
    assert again.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 100_000
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    assert len([t for t in txns if t["kind"] == "invite_refund"]) == 1


def test_timeout_reconciles_like_failed(client: TestClient, auth_header: dict) -> None:
    """REGRESSION: task INVITE_MEMBER treo quá ngưỡng → lazy-cleanup (GET /queue/next)
    phải reconcile Y HỆT FAILED thật: hoàn phí ví + xoá member phantom + ghi timeline
    MEMBER_INVITE_FAILED. Trước đây đường timeout chỉ set status=FAILED → tiền kẹt +
    member kẹt 'pending' (hiện "Chờ tham gia") + timeline vẫn "Đã mời"."""
    from datetime import datetime, timedelta, timezone
    from uuid import UUID

    from app.db import SessionLocal
    from app.models import AuditLog, Member, QueueItem

    ws = create_ws(client, auth_header, "Timeout WS")
    sub = make_beta_sub(client, auth_header, username="reftimeout", balance=100_000)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["t1@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == 0
    item_id = res["queue_item_id"]
    key = ws["extension_api_key"]

    # Extension pick task → IN_PROGRESS.
    picked = client.get("/api/v1/queue/next", headers={"X-API-KEY": key})
    assert picked.status_code == 200 and picked.json()["id"] == item_id

    # Ép picked_at về 5 phút trước (vượt ngưỡng INVITE_MEMBER = 3 phút).
    db = SessionLocal()
    try:
        it = db.get(QueueItem, UUID(item_id))
        it.picked_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        db.add(it)
        db.commit()
    finally:
        db.close()

    # Pick lần nữa → lazy-cleanup auto-fail task treo + reconcile.
    client.get("/api/v1/queue/next", headers={"X-API-KEY": key})

    db = SessionLocal()
    try:
        it = db.get(QueueItem, UUID(item_id))
        assert it.status == "FAILED" and it.error_code == "TIMEOUT"
        # Member phantom bị xoá (không còn record nào cho email này).
        member = (
            db.query(Member)
            .filter(Member.workspace_id == UUID(ws["id"]), Member.email == "t1@example.com")
            .one_or_none()
        )
        assert member is None, "timeout phải xoá member phantom pending"
        # Timeline: có MEMBER_INVITE_FAILED gắn member (ghi TRƯỚC khi xoá).
        failed_log = (
            db.query(AuditLog)
            .filter(AuditLog.action == "MEMBER_INVITE_FAILED")
            .one_or_none()
        )
        assert failed_log is not None, "timeout phải ghi timeline MEMBER_INVITE_FAILED"
    finally:
        db.close()

    # Ví được hoàn phí về 100k + có 1 giao dịch invite_refund.
    assert wallet_of(client, sub["token"])["balance"] == 100_000
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    assert len([t for t in txns if t["kind"] == "invite_refund"]) == 1
