"""ChatGPT LỖI CÔNG TẮC "mời ngoài miền" ⇒ NGƯNG MỜI WORKSPACE 1 TIẾNG.

Vì sao có file này (chốt user 3/9/2026, kèm ảnh chụp /admin/identity):
ChatGPT thỉnh thoảng hỏng ngay cú bấm công tắc "Cho phép lời mời từ miền bên
ngoài" — in băng-rôn đỏ "Something went wrong...", tải lại trang thì công tắc VẪN
TẮT, và chính nó gửi thông báo về tài khoản admin của workspace. Extension chốt
`EXTERNAL_TOGGLE_BLOCKED` cho ca này.

Ba bất biến phải khoá:

  1. Nhận mã đó ⇒ workspace bị ngưng mời, và lệnh mời tiếp theo bị TỪ CHỐI ở API
     (409) chứ không được tạo task rồi hỏng tiếp — bấm lại công tắc lúc ChatGPT
     đang hỏng là đúng cách để bị khoá thêm.
  2. Ngưng KHÔNG được ăn tiền: lệnh hỏng vẫn hoàn phí đủ như EXTERNAL_TOGGLE_FAILED,
     và lệnh bị từ chối thì không trừ đồng nào.
  3. Super-admin mở lại được ngay; sub-admin thì không (mở lại lúc ChatGPT vẫn
     hỏng là mua thêm một loạt lệnh hỏng cho cả workspace).
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


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


@pytest.fixture(autouse=True)
def _mute_telegram(monkeypatch: pytest.MonkeyPatch) -> None:
    """Chặn mọi cú gọi Bot API trong test — không có token nên `call` sẽ raise
    `not_configured`, mà hàm gọi nó đã bọc try/except; chặn hẳn cho khỏi phụ thuộc
    thứ tự đó (và cho khỏi ai đó vô tình gọi Telegram thật)."""
    from app.services import invite_block

    monkeypatch.setattr(invite_block, "notify_super_admins", lambda *a, **k: 0)


def _invite(client: TestClient, token: str, ws_id: str, email: str):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": [email], "role": "member"},
        headers=bearer(token),
    )


def _fail_with_toggle_error(client: TestClient, ws: dict, item_id: str):
    return client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "EXTERNAL_TOGGLE_BLOCKED",
            "error_message": (
                "ChatGPT báo lỗi khi bật 'mời ngoài tên miền' (\"Something went "
                'wrong."). Đã tải lại trang đọc lại: công tắc VẪN TẮT.'
            ),
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )


def _workspace(ws_id: str):
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        return db.get(Workspace, uuid.UUID(ws_id))


def _audit_actions(ws_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        rows = db.query(AuditLog).filter(AuditLog.target_id == ws_id).all()
        return [r.action for r in rows]


def test_toggle_error_blocks_invites_for_an_hour_and_refunds(
    client: TestClient, auth_header: dict
) -> None:
    ws = create_ws(client, auth_header, "Block WS")
    sub = make_beta_sub(client, auth_header, username="blocksub", balance=FEE * 2)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "blocked1@example.com")
    assert r.status_code == 202, r.text
    item_id = r.json()["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == FEE

    upd = _fail_with_toggle_error(client, ws, item_id)
    assert upd.status_code == 200, upd.text

    # (2) Hoàn phí đủ — ngưng mời không phải cái cớ để giam tiền đại lý.
    assert wallet_of(client, sub["token"])["balance"] == FEE * 2, (
        "chưa email nào được mời thì phải hoàn phí đủ như EXTERNAL_TOGGLE_FAILED"
    )

    row = _workspace(ws["id"])
    assert row is not None
    assert row.invite_blocked_until is not None, "phải đặt mốc ngưng mời"
    until = row.invite_blocked_until
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    delta = until - datetime.now(timezone.utc)
    assert timedelta(minutes=55) < delta <= timedelta(minutes=60), (
        f"mốc ngưng phải khoảng 1 tiếng, đang là {delta}"
    )
    assert row.invite_block_reason, "phải ghi lý do để dashboard nói được vì sao"
    assert "WORKSPACE_INVITE_BLOCKED" in _audit_actions(ws["id"])

    # (1) Lệnh mời tiếp theo bị từ chối NGAY ở API, không tạo task.
    again = _invite(client, sub["token"], ws["id"], "blocked2@example.com")
    assert again.status_code == 409, again.text
    assert "ngưng mời" in again.json()["detail"].lower()
    assert wallet_of(client, sub["token"])["balance"] == FEE * 2, (
        "lệnh bị từ chối thì không được trừ đồng nào"
    )


def test_two_failures_do_not_shorten_the_pause(
    client: TestClient, auth_header: dict
) -> None:
    """Hai lệnh hỏng liền nhau: mốc phải LÙI RA, không được rút lại gần hơn."""
    from app.db import SessionLocal
    from app.models import Workspace
    from app.services import invite_block

    ws = create_ws(client, auth_header, "Block WS twice")
    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws["id"]))
        assert row is not None
        far = datetime.now(timezone.utc) + timedelta(hours=3)
        row.invite_blocked_until = far
        db.commit()
        invite_block.block_after_toggle_error(db, row, detail="lỗi lần hai")
        db.commit()
        again = db.get(Workspace, uuid.UUID(ws["id"]))
        assert again is not None
        got = again.invite_blocked_until
        if got.tzinfo is None:
            got = got.replace(tzinfo=timezone.utc)
    assert got >= far - timedelta(seconds=1), (
        "mốc cũ xa hơn thì phải giữ mốc cũ — nghỉ thêm thì được, nghỉ ít hơn thì không"
    )


def test_expired_block_lets_invites_through(
    client: TestClient, auth_header: dict
) -> None:
    """Mốc đã qua ⇒ mời lại được, không cần job nào đi dọn cột."""
    from app.db import SessionLocal
    from app.models import Workspace

    ws = create_ws(client, auth_header, "Block WS expired")
    sub = make_beta_sub(client, auth_header, username="expiredsub", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws["id"]))
        assert row is not None
        row.invite_blocked_until = datetime.now(timezone.utc) - timedelta(minutes=1)
        row.invite_block_reason = "lỗi cũ đã qua"
        db.commit()

    r = _invite(client, sub["token"], ws["id"], "afterblock@example.com")
    assert r.status_code == 202, r.text


def test_super_admin_can_unblock_but_sub_admin_cannot(
    client: TestClient, auth_header: dict
) -> None:
    ws = create_ws(client, auth_header, "Block WS unblock")
    sub = make_beta_sub(client, auth_header, username="unblocksub", balance=FEE * 2)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "unblock1@example.com")
    item_id = r.json()["queue_item_id"]
    assert _fail_with_toggle_error(client, ws, item_id).status_code == 200
    assert _workspace(ws["id"]).invite_blocked_until is not None

    denied = client.post(
        f"/api/v1/workspaces/{ws['id']}/invite-block/clear",
        headers=bearer(sub["token"]),
    )
    assert denied.status_code in (401, 403), denied.text
    assert _workspace(ws["id"]).invite_blocked_until is not None, (
        "sub-admin không được tự mở lại"
    )

    ok = client.post(
        f"/api/v1/workspaces/{ws['id']}/invite-block/clear", headers=auth_header
    )
    assert ok.status_code == 200, ok.text
    row = _workspace(ws["id"])
    assert row.invite_blocked_until is None
    assert row.invite_block_reason is None
    assert "WORKSPACE_INVITE_UNBLOCKED" in _audit_actions(ws["id"])

    # Mở lại rồi thì mời được ngay.
    again = _invite(client, sub["token"], ws["id"], "unblock2@example.com")
    assert again.status_code == 202, again.text


def test_seats_endpoint_reports_block_state(
    client: TestClient, auth_header: dict
) -> None:
    """Trang Mời đọc trạng thái ngưng qua `/workspaces/seats` (đã poll sẵn) —
    endpoint phải LỌC mốc quá hạn, kẻo dải cảnh báo treo mãi không tắt."""
    from app.db import SessionLocal
    from app.models import Workspace

    ws = create_ws(client, auth_header, "Block WS seats")
    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws["id"]))
        assert row is not None
        row.invite_blocked_until = datetime.now(timezone.utc) + timedelta(minutes=30)
        row.invite_block_reason = "ChatGPT báo lỗi"
        db.commit()

    rows = client.get("/api/v1/workspaces/seats", headers=auth_header).json()
    mine = next(r for r in rows if r["workspace_id"] == ws["id"])
    assert mine["invite_blocked_until"] is not None
    assert mine["invite_block_reason"] == "ChatGPT báo lỗi"

    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws["id"]))
        row.invite_blocked_until = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()
    rows = client.get("/api/v1/workspaces/seats", headers=auth_header).json()
    mine = next(r for r in rows if r["workspace_id"] == ws["id"])
    assert mine["invite_blocked_until"] is None, "mốc đã qua thì phải trả None"
    assert mine["invite_block_reason"] is None
