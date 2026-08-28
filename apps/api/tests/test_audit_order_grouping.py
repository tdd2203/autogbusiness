"""Nhật ký: 2 dòng tiền của hoá đơn QR phải trỏ về ĐÚNG task đã thực thi.

Ca thật user 2026-08-26: một lượt "ví thiếu → quét QR → mời" hiện thành BA dòng rời
trên trang nhật ký (tạo lệnh thanh toán · thanh toán thành công · lệnh mời) trong khi
đó là MỘT việc. UI gom nhóm theo `data.queue_item_id`, mà hai dòng tiền không có
trường đó — liên kết thật nằm ở `payment_orders.queue_item_id`. Endpoint phân giải
lúc ĐỌC nên áp được cho cả nhật ký cũ.
"""

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_ws,
    make_beta_sub,
    set_settings,
)

FEE = 100_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _webhook_body(note: str, amount: int, txn_id: str) -> dict:
    return {
        "transferType": "in",
        "transferAmount": amount,
        "content": note,
        "id": txn_id,
        "referenceCode": txn_id,
    }


def test_order_audit_rows_carry_queue_item_id(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Audit Order WS")
    sub = make_beta_sub(client, auth_header, username="audord", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "ord1@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]

    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-AUD-1"))
    assert wh.status_code == 200 and wh.json().get("success") is True

    o = client.get(
        f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])
    ).json()
    qid = o["queue_item_id"]
    assert qid, "hoá đơn đã trả phải gắn task mời"

    logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    by_action = {x["action"]: x for x in logs}
    for action in ("PAYMENT_ORDER_CREATED", "WALLET_ORDER_CREDITED"):
        assert action in by_action, sorted(by_action)
        assert (by_action[action].get("data") or {}).get("queue_item_id") == qid, action

    # Cùng khoá gom nhóm với chính lệnh mời → trang nhật ký hiện 1 dòng, không phải 3.
    invite_log = by_action.get("MEMBER_INVITE_QUEUED")
    assert invite_log and (invite_log.get("data") or {}).get("queue_item_id") == qid


def test_unpaid_order_audit_row_has_no_queue_item(client: TestClient, auth_header: dict) -> None:
    """Hoá đơn CHƯA trả chưa thực thi gì → không được gắn task nào."""
    ws = create_ws(client, auth_header, "Audit Unpaid WS")
    sub = make_beta_sub(client, auth_header, username="audunp", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "ord2@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text

    logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    created = [x for x in logs if x["action"] == "PAYMENT_ORDER_CREATED"]
    assert created, "phải có dòng tạo lệnh thanh toán"
    assert not (created[0].get("data") or {}).get("queue_item_id")
