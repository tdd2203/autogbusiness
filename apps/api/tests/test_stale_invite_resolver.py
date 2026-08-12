"""Bug thuylinhtctbg (user 2026-07-16): lời mời KẸT LIMBO.

Kịch bản gốc: mời email → extension báo COMPLETED-unverified → guard 10′ "defer to
sync" GIỮ member pending. Nhưng (a) trước đây defer bị chấm VERIFIED oan (báo thành
công dù chưa xác minh), (b) không có gì quay lại chốt nếu lời mời hỏng thật → member
kẹt pending mãi + giữ "hạn ma" đã trả tiền → mời lại MIỄN PHÍ oan (mất tiền).

Phủ 3 sửa:
  - Fix B: defer KHÔNG còn chấm VERIFIED; ghi MEMBER_INVITE_PENDING_VERIFY ("chờ xác minh").
  - Fix A: resolver nền chốt limbo → hoàn phí + MEMBER_INVITE_FAILED + xoá phantom.
  - Fix C: hoàn phí ⇒ void kỳ đã trả → mời lại KHÔNG còn miễn phí oan.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_ws,
    make_beta_sub,
    set_settings,
    wallet_of,
)

FEE = 100_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _bulk(client: TestClient, token: str, ws_id: str, emails: list[str]) -> dict:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member", "subscription_months": 1},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()


def _patch_queue(client: TestClient, api_key: str, item_id: str, body: dict):
    return client.patch(
        f"/api/v1/queue/{item_id}", json=body, headers={"X-API-KEY": api_key}
    )


def _member_row(ws_id: str, email: str):
    from app.db import SessionLocal
    from app.models import Member

    db = SessionLocal()
    try:
        return (
            db.query(Member)
            .filter(Member.workspace_id == UUID(ws_id), Member.email == email)
            .one_or_none()
        )
    finally:
        db.close()


def _audit_actions(target_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    db = SessionLocal()
    try:
        rows = (
            db.query(AuditLog)
            .filter(AuditLog.target_type == "MEMBER", AuditLog.target_id == target_id)
            .all()
        )
        return [r.action for r in rows]
    finally:
        db.close()


def test_deferred_completion_does_not_mark_verified(
    client: TestClient, auth_header: dict
) -> None:
    """Fix B: COMPLETED-unverified email TƯƠI → defer: KHÔNG chấm VERIFIED, KHÔNG set
    joined_at, KHÔNG hoàn phí; ghi MEMBER_INVITE_PENDING_VERIFY ("chờ xác minh")."""
    ws = create_ws(client, auth_header, "Defer WS")
    sub = make_beta_sub(client, auth_header, username="defer1", balance=2 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["d1@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == FEE  # đã trừ 1 phí

    r = _patch_queue(
        client, ws["extension_api_key"], res["queue_item_id"],
        {"status": "COMPLETED", "result": {"unverified_emails": ["d1@example.com"]}},
    )
    assert r.status_code == 200, r.text

    m = _member_row(ws["id"], "d1@example.com")
    assert m is not None and m.status == "pending", "defer phải GIỮ member pending"
    assert m.joined_at is None, "defer KHÔNG được set joined_at (chưa xác minh)"
    assert wallet_of(client, sub["token"])["balance"] == FEE, "defer KHÔNG hoàn phí"

    actions = _audit_actions(str(m.id))
    assert "MEMBER_INVITE_PENDING_VERIFY" in actions, "phải báo chờ-xác-minh"
    assert "MEMBER_INVITE_VERIFIED" not in actions, "defer KHÔNG được báo thành công oan"


def test_resolver_fails_limbo_refunds_then_reinvite_charges_again(
    client: TestClient, auth_header: dict
) -> None:
    """Fix A + cốt lõi: limbo quá cửa sổ → resolver chốt FAILED + hoàn phí + xoá
    phantom; mời LẠI sau đó BỊ TRỪ TIỀN (không còn miễn phí oan)."""
    from app.db import SessionLocal
    from app.main import _resolve_stale_pending_invites_once
    from app.models import AuditLog, Member

    ws = create_ws(client, auth_header, "Limbo WS")
    sub = make_beta_sub(client, auth_header, username="limbo1", balance=2 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["L1@example.com".lower()])
    assert wallet_of(client, sub["token"])["balance"] == FEE
    _patch_queue(
        client, ws["extension_api_key"], res["queue_item_id"],
        {"status": "COMPLETED", "result": {"unverified_emails": ["l1@example.com"]}},
    )
    m = _member_row(ws["id"], "l1@example.com")
    assert m is not None and m.status == "pending"
    member_id = str(m.id)

    # Giả lập cửa sổ trôi qua: đẩy PENDING_VERIFY audit + last_invited_at về >20′ trước.
    past = datetime.now(timezone.utc) - timedelta(minutes=30)
    db = SessionLocal()
    try:
        for row in (
            db.query(AuditLog)
            .filter(AuditLog.target_id == member_id)
            .all()
        ):
            row.timestamp = past
        mm = db.get(Member, UUID(member_id))
        mm.last_invited_at = past
        mm.created_at = past
        db.commit()
    finally:
        db.close()

    _resolve_stale_pending_invites_once()

    # Phantom bị xoá + hoàn phí về đủ 2×FEE + ghi timeline FAILED.
    assert _member_row(ws["id"], "l1@example.com") is None, "resolver phải xoá phantom"
    assert wallet_of(client, sub["token"])["balance"] == 2 * FEE, "phải hoàn phí"
    assert "MEMBER_INVITE_FAILED" in _audit_actions(member_id)

    # CỐT LÕI: mời lại email này → BỊ TRỪ TIỀN lại (không miễn phí oan).
    res2 = _bulk(client, sub["token"], ws["id"], ["l1@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == FEE, (
        "mời lại phải trừ phí — đây là bug user báo (lần 2 không trừ tiền)"
    )
    assert res2["queue_item_id"] != res["queue_item_id"]


def test_refund_voids_paid_period_on_surviving_member(
    client: TestClient, auth_header: dict
) -> None:
    """Fix C: member có joined_at (mời-lại-removed) sống sót bộ lọc xoá phantom
    (joined_at IS NULL) khi lời mời FAILED — nhưng hoàn phí PHẢI void kỳ đã trả để
    `_is_paid_period_active` không cho mời lại miễn phí oan."""
    from app.db import SessionLocal
    from app.models import Member

    ws = create_ws(client, auth_header, "VoidPeriod WS")
    sub = make_beta_sub(client, auth_header, username="void1", balance=2 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["v1@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == FEE
    m = _member_row(ws["id"], "v1@example.com")
    assert m is not None and m.subscription_end_at is not None

    # Giả lập trạng thái mời-lại-removed: joined_at ĐÃ set → reconnect delete bỏ qua.
    db = SessionLocal()
    try:
        mm = db.get(Member, m.id)
        mm.joined_at = datetime.now(timezone.utc)
        db.commit()
    finally:
        db.close()

    # Lời mời FAILED → reconcile: member KHÔNG bị xoá (joined_at != NULL) + hoàn phí.
    r = _patch_queue(
        client, ws["extension_api_key"], res["queue_item_id"], {"status": "FAILED"}
    )
    assert r.status_code == 200, r.text

    db = SessionLocal()
    try:
        survivor = (
            db.query(Member)
            .filter(Member.workspace_id == UUID(ws["id"]), Member.email == "v1@example.com")
            .one_or_none()
        )
        assert survivor is not None, "member joined_at != NULL sống sót (đúng thiết kế)"
        # Void = HẾT HẠN NGAY, KHÔNG phải NULL. Chính bản ghi "sống sót" này là ca thật
        # 12/8/2026: NULL nghĩa là VÔ THỜI HẠN (EXPIRY_RULES §5) nên vừa thoát lượt quét
        # gỡ email hết hạn, vừa hiện "Vô hạn" trên dashboard ⇒ email dùng miễn phí vĩnh
        # viễn, im lặng. `<= now` vẫn chặn hạn-ma (mời lại vẫn tính phí) mà còn lộ ra.
        assert survivor.subscription_end_at is not None, (
            "void đặt NULL = VÔ HẠN → email hết hạn không bao giờ bị quét gỡ"
        )
        assert survivor.subscription_end_at <= datetime.now(timezone.utc), (
            "hoàn phí PHẢI void kỳ — nếu còn hạn ma sẽ cho mời lại miễn phí oan"
        )
        assert not survivor.subscription_cycles, "kỳ đã trả phải bị xoá theo"
    finally:
        db.close()
    assert wallet_of(client, sub["token"])["balance"] == 2 * FEE
