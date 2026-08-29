"""Bất biến TIỀN: CẢ MẺ ĐI ĐƯỢC THÌ KHÔNG LỖI LẺ MỘT EMAIL.

Ca thật 29/8/2026 (CHATGPT PRO, task e3380978, mẻ 17 email, 330.000đ hoàn oan):

  18:09  mời mẻ 17 email → trừ 17×330k
  18:11  quét tab "Lời mời đang chờ xử lý" thấy 16/17 → 16 email VERIFIED, email
         thứ 17 (`anton.m.…`) vào diện chờ xác minh. Nó KHÔNG nằm ở tab "Lời mời"
         vì đã được CHẤP NHẬN NGAY, tức nằm ở tab "Người dùng".
  18:53  resolver nền hết cửa sổ → chốt hỏng, hoàn 330k, xoá bản ghi
  18:58  đồng bộ kế tiếp: email ĐANG Ở TRONG TEAM (`MEMBER_REFUND_WHILE_IN_TEAM`)
         ⇒ dịch vụ đã giao mà thực thu 0đ, phải truy thu tay.

Mời một mẻ là MỘT lần bấm gửi trên ChatGPT: mẻ đi được thì đi cả mẻ. Nên còn anh em
cùng mẻ đã xác minh ⇒ giữ nguyên lời mời, cử đồng bộ đi xem, KHÔNG hoàn theo đồng hồ.
Lời mời lẻ (không có anh em nào xác minh) vẫn chốt hỏng như cũ — test dưới giữ cả hai.
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
        return [
            r.action
            for r in db.query(AuditLog)
            .filter(AuditLog.target_type == "MEMBER", AuditLog.target_id == target_id)
            .all()
        ]
    finally:
        db.close()


def _age_out(member_id: str, minutes: int = 30) -> datetime:
    """Đẩy mốc hoãn + mốc mời về quá cửa sổ, kèm BẰNG CHỨNG ÂM (`sync_missing_at`)
    để resolver đi tới tận nhánh chốt hỏng — chính chỗ cần chặn."""
    from app.db import SessionLocal
    from app.models import AuditLog, Member

    past = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    db = SessionLocal()
    try:
        for row in db.query(AuditLog).filter(AuditLog.target_id == member_id).all():
            row.timestamp = past
        m = db.get(Member, UUID(member_id))
        m.last_invited_at = past
        m.created_at = past
        m.sync_missing_at = past + timedelta(minutes=1)
        db.commit()
    finally:
        db.close()
    return past


def test_resolver_holds_email_whose_batch_siblings_verified(
    client: TestClient, auth_header: dict
) -> None:
    """Mẻ 3 email, 2 email xác minh xong: email còn lại KHÔNG bị chốt hỏng theo
    đồng hồ — giữ bản ghi, giữ phí, ghi MEMBER_INVITE_BATCH_HOLD."""
    from app.main import _resolve_stale_pending_invites_once

    ws = create_ws(client, auth_header, "Solidarity WS")
    sub = make_beta_sub(client, auth_header, username="solid1", balance=4 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    emails = ["s1@example.com", "s2@example.com", "s3@example.com"]
    res = _bulk(client, sub["token"], ws["id"], emails)
    assert wallet_of(client, sub["token"])["balance"] == FEE  # 4 - 3 phí

    # Extension chỉ thấy 2/3 ở tab "Lời mời" — email thứ 3 đã sang tab "Người dùng".
    r = client.patch(
        f"/api/v1/queue/{res['queue_item_id']}",
        json={"status": "COMPLETED", "result": {"unverified_emails": ["s3@example.com"]}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text

    m = _member_row(ws["id"], "s3@example.com")
    assert m is not None and m.status == "pending"
    member_id = str(m.id)
    _age_out(member_id)

    _resolve_stale_pending_invites_once()

    assert _member_row(ws["id"], "s3@example.com") is not None, (
        "cùng mẻ với email đã xác minh ⇒ KHÔNG được xoá bản ghi"
    )
    assert wallet_of(client, sub["token"])["balance"] == FEE, (
        "KHÔNG được hoàn phí theo đồng hồ — đây là ca hoàn oan 29/8/2026"
    )
    actions = _audit_actions(member_id)
    assert "MEMBER_INVITE_BATCH_HOLD" in actions, "phải ghi lý do giữ lại"
    assert "MEMBER_INVITE_FAILED" not in actions, "không được chốt hỏng"


def test_hold_is_logged_once_and_queues_a_sync_probe(
    client: TestClient, auth_header: dict
) -> None:
    """Giữ lại KHÔNG phải bỏ mặc: cử một mẻ đồng bộ đi xem, và chỉ kêu MỘT lần
    dù resolver chạy nhiều vòng."""
    from app.db import SessionLocal
    from app.main import _resolve_stale_pending_invites_once
    from app.models import QueueItem

    ws = create_ws(client, auth_header, "Solidarity WS2")
    sub = make_beta_sub(client, auth_header, username="solid2", balance=3 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["h1@example.com", "h2@example.com"])
    client.patch(
        f"/api/v1/queue/{res['queue_item_id']}",
        json={"status": "COMPLETED", "result": {"unverified_emails": ["h2@example.com"]}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    member_id = str(_member_row(ws["id"], "h2@example.com").id)
    _age_out(member_id)

    _resolve_stale_pending_invites_once()
    _resolve_stale_pending_invites_once()

    assert _audit_actions(member_id).count("MEMBER_INVITE_BATCH_HOLD") == 1, (
        "kêu một lần cho mỗi mốc hoãn, không lặp mỗi vòng"
    )
    db = SessionLocal()
    try:
        probes = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == UUID(ws["id"]),
                QueueItem.type == "SYNC_MEMBERS_BATCH",
            )
            .all()
        )
    finally:
        db.close()
    assert probes, "phải cử đồng bộ đi xem tận nơi"
    assert "h2@example.com" in (probes[0].payload or {}).get("emails", [])


def test_lone_invite_without_verified_siblings_still_fails(
    client: TestClient, auth_header: dict
) -> None:
    """Lời mời LẺ (cả mẻ không email nào xác minh) + bằng chứng âm ⇒ vẫn chốt hỏng
    + hoàn phí như cũ. Luật mới không được nới tay cho ca hỏng thật."""
    from app.main import _resolve_stale_pending_invites_once

    ws = create_ws(client, auth_header, "Lone WS")
    sub = make_beta_sub(client, auth_header, username="lone1", balance=2 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["lone@example.com"])
    assert wallet_of(client, sub["token"])["balance"] == FEE
    client.patch(
        f"/api/v1/queue/{res['queue_item_id']}",
        json={"status": "COMPLETED", "result": {"unverified_emails": ["lone@example.com"]}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    member_id = str(_member_row(ws["id"], "lone@example.com").id)
    _age_out(member_id)

    _resolve_stale_pending_invites_once()

    assert _member_row(ws["id"], "lone@example.com") is None
    assert wallet_of(client, sub["token"])["balance"] == 2 * FEE
    assert "MEMBER_INVITE_FAILED" in _audit_actions(member_id)
