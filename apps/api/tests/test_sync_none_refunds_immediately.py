"""ĐỒNG BỘ NÓI "KHÔNG THẤY Ở ĐÂU CẢ" ⇒ HOÀN PHÍ NGAY, KHÔNG BẮT CHỜ ĐỦ 20′.

Đường hoãn phán xử (`defer_unverified_invite`) enqueue một mẻ `SYNC_MEMBERS_BATCH`
đi hỏi ChatGPT: email này có nằm trong tab "Lời mời đang chờ" / "Người dùng" không?

Chiều DƯƠNG đã có `close_invite_defer_with_sync_evidence` (thấy → chốt xác minh).
Chiều ÂM thì trước đây chỉ đóng dấu `member.sync_missing_at` rồi vẫn bắt chờ đủ
`STALE_PENDING_INVITE_WINDOW` (20′) để `_resolve_stale_pending_invites_once` đi hỏi
lại đúng câu vừa được trả lời — tiền của đại lý bị giam thêm ~19 phút cho một lời
mời đã biết chắc là hỏng (user 26/8/2026).

Chốt an toàn KHÔNG được bỏ: lời mời phải đủ CŨ (`INVITE_MISSING_MIN_AGE`) thì lời
chứng phủ định mới đáng tin — tab "Lời mời đang chờ" của ChatGPT không tươi tức thì,
chốt hỏng ngay sau cú bấm Gửi là rơi vào đúng cái bẫy hoàn-phí-oan mà cả đường hoãn
sinh ra để tránh (ca 76d68e55 ngày 26/8: suýt hoàn 1.650.000đ cho 5 lời mời có thật).
"""

import uuid

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
EMAIL = "syncnone@example.com"


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
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": "Đã submit nhưng không xác minh được",
            "result": {"submit_clicked": True},
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
            .filter(Member.workspace_id == uuid.UUID(ws_id), Member.email == EMAIL)
            .one_or_none()
        )


def _actions(member_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        return [
            r.action
            for r in db.query(AuditLog)
            .filter(AuditLog.target_type == "MEMBER", AuditLog.target_id == member_id)
            .all()
        ]


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
        assert row is not None
        return str(row.id)


def _age_invite(member_id: str, minutes: int) -> None:
    """Đẩy mốc mời + mốc hoãn về quá khứ (mô phỏng ca timeout 8′ ngoài đời)."""
    from datetime import datetime, timedelta, timezone

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


def _sync(client: TestClient, ws: dict, found_in: str) -> None:
    r = client.patch(
        f"/api/v1/queue/{_sync_batch_id(ws['id'])}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"results": [{"email": EMAIL, "found_in": found_in}]}},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def test_sync_khong_thay_email_thi_hoan_phi_ngay(
    client: TestClient, auth_header: dict
) -> None:
    """Không cần gọi resolver 20′: mẻ đồng bộ trả `none` là đủ để chốt + hoàn phí."""
    ws = create_ws(client, auth_header, "SyncNone WS")
    sub = make_beta_sub(client, auth_header, username="syncnone1", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0
    _fail_after_submit(client, ws, item_id)
    member_id = str(_member(ws["id"]).id)
    _age_invite(member_id, minutes=10)  # ca timeout 8′ ngoài đời

    _sync(client, ws, "none")

    assert _member(ws["id"]) is None, "lời mời hỏng thật phải bị xoá phantom NGAY"
    assert wallet_of(client, sub["token"])["balance"] == FEE, (
        "đồng bộ đã trả lời 'không thấy đâu cả' — không có lý do giam tiền thêm 19 phút"
    )
    actions = _actions(member_id)
    assert "MEMBER_INVITE_FAILED" in actions
    assert "MEMBER_INVITE_VERIFIED" not in actions


def test_loi_moi_con_tuoi_thi_van_cho_resolver(
    client: TestClient, auth_header: dict
) -> None:
    """Chốt an toàn: lời mời vừa gửi (< `INVITE_MISSING_MIN_AGE`) mà đồng bộ chưa
    thấy thì CHƯA kết luận — tab lời mời của ChatGPT không tươi tức thì."""
    ws = create_ws(client, auth_header, "SyncNone Fresh WS")
    sub = make_beta_sub(client, auth_header, username="syncnone2", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    _fail_after_submit(client, ws, item_id)
    member_id = str(_member(ws["id"]).id)

    _sync(client, ws, "none")

    assert _member(ws["id"]) is not None, "chưa đủ cũ thì không được chốt hỏng"
    assert wallet_of(client, sub["token"])["balance"] == 0, "chưa được hoàn phí vội"
    assert "MEMBER_INVITE_FAILED" not in _actions(member_id)


def test_sync_thay_email_thi_khong_dong_gi_ca(
    client: TestClient, auth_header: dict
) -> None:
    """Ranh giới ngược: `found_in='pending'` (thấy trong tab Lời mời) ⇒ giữ nguyên
    tiền + bản ghi, chốt XÁC MINH chứ không phải chốt hỏng."""
    ws = create_ws(client, auth_header, "SyncNone Seen WS")
    sub = make_beta_sub(client, auth_header, username="syncnone3", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    _fail_after_submit(client, ws, item_id)
    member_id = str(_member(ws["id"]).id)
    _age_invite(member_id, minutes=10)

    _sync(client, ws, "pending")

    assert _member(ws["id"]) is not None
    assert wallet_of(client, sub["token"])["balance"] == 0
    actions = _actions(member_id)
    assert "MEMBER_INVITE_VERIFIED" in actions
    assert "MEMBER_INVITE_FAILED" not in actions
