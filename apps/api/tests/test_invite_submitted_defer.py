"""Bất biến TIỀN: ĐÃ BẤM "GỬI LỜI MỜI" MÀ KHÔNG XÁC MINH ĐƯỢC ⇒ CHƯA ĐƯỢC HOÀN PHÍ.

Vì sao có file này (2 ca thật production 12/8/2026 — thất thoát 670k):

  19:30:51  mời → trừ 330k, member 'pending', hạn tới 11/9
  19:31:20  extension: đã click Gửi nhưng 15s không đọc được toast lẫn dialog-đóng
            → báo FAILED `VERIFY_FAILED` (mới 29 GIÂY sau khi mời)
            ⇒ backend hiểu FAILED = mời hỏng → hoàn 330k + void kỳ đã trả
  Thực tế: lời mời TỚI ĐƯỢC, người nhận đã tham gia team.
  ⇒ Ghế dùng thật, hệ thống thực thu 0đ. Ca thứ 2 y hệt qua đường 'total-miss'.

Điểm mấu chốt: "extension không xác minh được" KHÁC "lời mời hỏng". Đường
COMPLETED-chưa-xác-minh vốn đã cẩn thận (hoãn 10′ rồi resolver 20′ mới chốt) — chỉ
đường FAILED là chốt vội trong 30-100 giây. File này khoá sự đối xứng giữa hai đường.

Ranh giới phải giữ cả HAI phía: lỗi TRƯỚC khi bấm Gửi (không tìm thấy nút, toggle
'mời ngoài miền' không bật được…) vẫn phải hoàn phí NGAY — giam tiền của đại lý khi
biết chắc lời mời không đi cũng là một kiểu sai.
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
EMAIL = "deferlike@example.com"


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


def _audit_actions(ws_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        rows = (
            db.query(AuditLog)
            .filter(AuditLog.data.contains({"workspace_id": ws_id}))
            .all()
        )
        return [r.action for r in rows]


def _queue_types(ws_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        rows = (
            db.query(QueueItem)
            .filter(QueueItem.workspace_id == uuid.UUID(ws_id))
            .all()
        )
        return [r.type for r in rows]


def test_submitted_but_unverified_does_not_refund(
    client: TestClient, auth_header: dict
) -> None:
    """FAILED + `result.submit_clicked` ⇒ hoãn phán xử: tiền GIỮ NGUYÊN, member còn
    'pending' kèm hạn dùng, timeline ghi "chờ xác minh", và có mẻ đồng bộ đi đối chiếu."""
    ws = create_ws(client, auth_header, "Defer WS")
    sub = make_beta_sub(client, auth_header, username="defersub", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0, "phải bị trừ phí mời"
    before = _member(ws["id"])
    assert before is not None, "mời xong phải có member"
    assert before.subscription_end_at is not None, "mời tính phí phải tạo hạn dùng"

    upd = client.patch(
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
    assert upd.status_code == 200, upd.text

    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "THẤT THOÁT NGƯỢC: đã hoàn phí dù CHƯA có bằng chứng nào là lời mời hỏng — "
        "đúng ca 12/8/2026 (lời mời tới được, người nhận đã tham gia)"
    )
    m = _member(ws["id"])
    assert m is not None, "member không được xoá khi chưa biết lời mời hỏng hay không"
    assert m.status == "pending"
    assert m.subscription_end_at is not None, "chưa hoàn phí thì KHÔNG được void kỳ"
    assert m.payment_status == "paid", "phí vẫn đang thu → kỳ vẫn là đã thanh toán"

    actions = _audit_actions(ws["id"])
    assert "MEMBER_INVITE_PENDING_VERIFY" in actions, (
        "phải ghi mốc chờ xác minh — đây là mốc mà resolver 20′ canh để chốt sau"
    )
    assert "MEMBER_INVITE_FAILED" not in actions, (
        "chưa có bằng chứng hỏng thì timeline không được ghi 'Thất bại'"
    )
    assert "SYNC_MEMBERS_BATCH" in _queue_types(ws["id"]), (
        "phải chủ động enqueue mẻ đồng bộ để ĐI XEM tab Người dùng, không ngồi chờ 20′"
    )


def test_failure_before_submit_still_refunds_immediately(
    client: TestClient, auth_header: dict
) -> None:
    """Mặt còn lại của ranh giới: biết chắc lệnh CHƯA submit (không có
    `submit_clicked`) ⇒ hoàn phí NGAY như cũ, không giam tiền đại lý."""
    ws = create_ws(client, auth_header, "Defer WS 2")
    sub = make_beta_sub(client, auth_header, username="defersub2", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0

    upd = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "EXTERNAL_TOGGLE_FAILED",
            "error_message": "Không bật được toggle 'mời ngoài tên miền' → chưa submit",
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text
    assert wallet_of(client, sub["token"])["balance"] == FEE, "phải hoàn phí ngay"
    actions = _audit_actions(ws["id"])
    assert "MEMBER_INVITE_FAILED" in actions


def test_chatgpt_reported_error_is_positive_evidence_of_failure(
    client: TestClient, auth_header: dict
) -> None:
    """Đã bấm Gửi NHƯNG chính ChatGPT báo lỗi trong dialog (email trùng / hết ghế…)
    ⇒ bằng chứng DƯƠNG là lời mời không đi → hoàn phí ngay, KHÔNG hoãn."""
    ws = create_ws(client, auth_header, "Defer WS 3")
    sub = make_beta_sub(client, auth_header, username="defersub3", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, sub["token"], ws["id"])
    upd = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": 'ChatGPT báo lỗi trong dialog: "not enough seats"',
            "result": {
                "submit_clicked": True,
                "chatgpt_error_hint": "not enough seats",
            },
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text
    assert wallet_of(client, sub["token"])["balance"] == FEE, "phải hoàn phí ngay"
