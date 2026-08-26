"""Bất biến TIỀN: ĐỒNG BỘ ĐÃ THẤY EMAIL TRONG CHATGPT ⇒ KHÔNG ĐƯỢC HOÀN PHÍ.

Ca thật 26/8/2026 (workspace CHAT GPT PRO, task `76d68e55`, suýt mất 1.650.000đ):

  10:47:59  mời mẻ 5 email → trừ 5×330k
  10:48:0x  extension bấm "Gửi lời mời" THẬT, ChatGPT nhận, nhưng 15s sau hộp thoại
            chưa đóng và không đọc được toast → task FAILED `VERIFY_FAILED` kèm
            `submit_clicked: true`
  10:49:52  backend hoãn phán xử (ĐÚNG): ghi MEMBER_INVITE_PENDING_VERIFY + enqueue
            SYNC_MEMBERS_BATCH đi tìm bằng chứng
  10:51:50  mẻ đồng bộ TÌM ĐƯỢC: cả 5 email `found_in='pending'` trong tab Lời mời
  11:38     …resolver 20′ vẫn hoàn 5×330k + void kỳ + XOÁ 5 bản ghi.

Mắt xích đứt: nhánh reconcile của `SYNC_MEMBERS_BATCH` khi `found_in='pending'` chỉ
chạm `last_synced_at`, KHÔNG ghi `MEMBER_INVITE_VERIFIED` — mà đó lại đúng là một
trong hai dấu hiệu duy nhất `_resolve_stale_pending_invites_once` chấp nhận. Bằng
chứng tìm được rồi mà vô hình với người ra quyết định.

Ranh giới phải giữ cả hai phía: `found_in='none'` (không thấy ở tab nào) thì resolver
vẫn phải chốt hỏng + hoàn phí — nếu không, mọi lời mời hỏng thật đều được giam tiền.
"""

import uuid
from datetime import datetime, timedelta, timezone

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
EMAIL = "syncevidence@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _invite(client: TestClient, token: str, ws_id: str) -> str:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member"},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()["queue_item_id"]


def _fail_after_submit(client: TestClient, ws: dict, item_id: str) -> None:
    """Kết thúc task mời y như extension làm khi đã bấm Gửi mà không xác minh được."""
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": (
                "Đã submit nhưng không thấy toast thành công và dialog không đóng sau 15s"
            ),
            "result": {"submit_clicked": True, "chatgpt_error_hint": None},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def _member(ws_id: str):
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        return (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws_id),
                Member.email == EMAIL,
            )
            .one_or_none()
        )


def _actions(member_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        rows = (
            db.query(AuditLog)
            .filter(AuditLog.target_type == "MEMBER", AuditLog.target_id == member_id)
            .all()
        )
        return [r.action for r in rows]


def _sync_batch_id(ws_id: str) -> str:
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        row = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws_id),
                QueueItem.type == "SYNC_MEMBERS_BATCH",
            )
            .one_or_none()
        )
        assert row is not None, "hoãn phán xử phải enqueue mẻ đồng bộ đi đối chiếu"
        return str(row.id)


def _age_defer_event(member_id: str, minutes: int = 30) -> datetime:
    """Đẩy mốc "chờ xác minh" + mốc mời về quá khứ để resolver coi là hết cửa sổ."""
    from app.db import SessionLocal
    from app.models import AuditLog, Member

    past = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    with SessionLocal() as db:
        for row in (
            db.query(AuditLog)
            .filter(
                AuditLog.target_id == member_id,
                AuditLog.action == "MEMBER_INVITE_PENDING_VERIFY",
            )
            .all()
        ):
            row.timestamp = past
        m = db.get(Member, uuid.UUID(member_id))
        m.last_invited_at = past
        m.created_at = past
        db.commit()
    return past


def test_sync_found_pending_closes_defer_and_keeps_fee(
    client: TestClient, auth_header: dict
) -> None:
    """CỐT LÕI: mẻ đồng bộ trả `found_in='pending'` ⇒ ghi VERIFIED ⇒ resolver 20′ đi
    qua: tiền GIỮ NGUYÊN, bản ghi GIỮ NGUYÊN."""
    from app.main import _resolve_stale_pending_invites_once

    ws = create_ws(client, auth_header, "SyncEvidence WS")
    sub = make_beta_sub(client, auth_header, username="syncev1", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0
    _fail_after_submit(client, ws, item_id)
    member_id = str(_member(ws["id"]).id)
    assert "MEMBER_INVITE_VERIFIED" not in _actions(member_id), (
        "chưa đối chiếu thì chưa được chấm xác minh"
    )

    # Mẻ đồng bộ ĐI TÌM và THẤY email trong tab "Lời mời đang chờ".
    r = client.patch(
        f"/api/v1/queue/{_sync_batch_id(ws['id'])}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"results": [{"email": EMAIL, "found_in": "pending"}]}},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text
    assert "MEMBER_INVITE_VERIFIED" in _actions(member_id), (
        "thấy email trong ChatGPT là bằng chứng lời mời ĐÃ ĐI — phải đóng trạng thái "
        "chờ xác minh, kẻo resolver 20′ hoàn phí oan (ca 26/8/2026)"
    )

    _age_defer_event(member_id)
    _resolve_stale_pending_invites_once()

    assert _member(ws["id"]) is not None, "KHÔNG được xoá lời mời đang chờ có thật"
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "THẤT THOÁT NGƯỢC: hoàn phí cho lời mời đang nằm chờ thật trong ChatGPT"
    )
    assert "MEMBER_INVITE_FAILED" not in _actions(member_id)


def test_resolver_keeps_member_seen_by_sync_before_the_fix(
    client: TestClient, auth_header: dict
) -> None:
    """Lớp chặn thứ hai, cho các bản ghi ĐÃ lỡ hoãn trước bản vá: mẻ đồng bộ của chúng
    chạy xong rồi (chỉ để lại `last_synced_at`), không còn mẻ nào quay lại ghi giúp →
    resolver phải tự đọc ra bằng chứng đó."""
    from app.db import SessionLocal
    from app.main import _resolve_stale_pending_invites_once
    from app.models import Member

    ws = create_ws(client, auth_header, "SyncEvidence WS 2")
    sub = make_beta_sub(client, auth_header, username="syncev2", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    _fail_after_submit(client, ws, item_id)
    member_id = str(_member(ws["id"]).id)
    past = _age_defer_event(member_id)

    # Dấu vết DUY NHẤT mà nhánh reconcile cũ để lại khi thấy `found_in='pending'`.
    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        m.last_synced_at = past + timedelta(minutes=2)
        m.sync_missing_at = None
        db.commit()

    _resolve_stale_pending_invites_once()

    assert _member(ws["id"]) is not None, "đồng bộ đã thấy → không được xoá"
    assert wallet_of(client, sub["token"])["balance"] == 0, "không được hoàn phí"
    actions = _actions(member_id)
    assert "MEMBER_INVITE_VERIFIED" in actions, "phải chốt xác minh để khỏi xét lại"
    assert "MEMBER_INVITE_FAILED" not in actions


def test_resolver_still_refunds_when_sync_did_not_find_email(
    client: TestClient, auth_header: dict
) -> None:
    """Mặt còn lại: đồng bộ quét mà KHÔNG thấy email ở tab nào (`found_in='none'` →
    `sync_missing_at`) ⇒ lời mời hỏng thật, resolver vẫn phải hoàn phí + xoá phantom."""
    from app.db import SessionLocal
    from app.main import _resolve_stale_pending_invites_once
    from app.models import Member

    ws = create_ws(client, auth_header, "SyncEvidence WS 3")
    sub = make_beta_sub(client, auth_header, username="syncev3", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0
    _fail_after_submit(client, ws, item_id)
    member_id = str(_member(ws["id"]).id)

    r = client.patch(
        f"/api/v1/queue/{_sync_batch_id(ws['id'])}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"results": [{"email": EMAIL, "found_in": "none"}]}},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text
    assert "MEMBER_INVITE_VERIFIED" not in _actions(member_id), (
        "không thấy email thì không được chấm xác minh"
    )

    _age_defer_event(member_id)
    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        assert m.sync_missing_at is not None, "found_in='none' phải đóng dấu"
        db.commit()

    _resolve_stale_pending_invites_once()

    assert _member(ws["id"]) is None, "lời mời hỏng thật phải bị xoá phantom"
    assert wallet_of(client, sub["token"])["balance"] == FEE, "phải hoàn phí"
    assert "MEMBER_INVITE_FAILED" in _actions(member_id)
