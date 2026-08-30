"""Nhật ký: các dòng tiền của hoá đơn QR phải trỏ về ĐÚNG việc đã thực thi.

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


def test_renew_fee_row_carries_order_id(client: TestClient, auth_header: dict) -> None:
    """Khoản TRỪ PHÍ gia hạn phải trỏ về hoá đơn đã trả cho nó (user 2026-08-30).

    Gia hạn không đi qua hàng đợi nên hai dòng tiền cùng một giây neo hai kiểu khác
    nhau: tiền QR vào ví neo theo id hoá đơn, phí trừ ra neo theo `member_id`. Trang
    nhật ký gom nhóm theo khoá nên hiện thành hai dòng cho MỘT việc. Liên kết thật
    là `payment_orders.member_id` — phân giải lúc đọc, áp được cho cả nhật ký cũ.
    """
    ws = create_ws(client, auth_header, "Audit Renew WS")
    sub = make_beta_sub(client, auth_header, username="audrenew", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "ord5@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]

    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/renew",
        json={"months": 2},
        headers=bearer(sub["token"]),
    )
    assert rr.status_code == 402, rr.text
    order = rr.json()["detail"]["order"]

    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], 2 * FEE, "ORD-AUD-RENEW-1")
    )
    assert wh.status_code == 200 and wh.json().get("success") is True

    logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    by_action = {x["action"]: x for x in logs}
    fee_row = by_action.get("WALLET_RENEW_CHARGED")
    assert fee_row, sorted(by_action)
    data = fee_row.get("data") or {}
    # Cùng khoá gom nhóm với dòng "Thanh toán thành công" → 1 dòng, không phải 2.
    assert data.get("order_id") == order["id"]
    assert data.get("order_ref_code") == order["ref_code"]
    credited = by_action.get("WALLET_ORDER_CREDITED") or {}
    assert (credited.get("data") or {}).get("ref_id") == order["id"]


def test_wallet_paid_renew_fee_has_no_order_id(
    client: TestClient, auth_header: dict
) -> None:
    """Ví đủ tiền → gia hạn không sinh hoá đơn ⇒ khoản trừ phí không được gán bừa."""
    ws = create_ws(client, auth_header, "Audit Renew Wallet WS")
    sub = make_beta_sub(client, auth_header, username="audrnwal", balance=3 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "ord6@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text
    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{r.json()['id']}/renew",
        json={"months": 1},
        headers=bearer(sub["token"]),
    )
    assert rr.status_code == 200, rr.text

    logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    fee = next((x for x in logs if x["action"] == "WALLET_RENEW_CHARGED"), None)
    assert fee, "phải có dòng trừ phí gia hạn"
    assert not (fee.get("data") or {}).get("order_id")


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


def test_order_ref_code_reaches_every_row_of_the_command(
    client: TestClient, auth_header: dict
) -> None:
    """Mọi sự kiện của lệnh phải mang MÃ HOÁ ĐƠN (user 2026-08-29).

    Hàng nhật ký hiện mã này cạnh tên workspace thay cho mã hàng đợi: mã hoá đơn tra
    được ở sao kê ngân hàng và ở khối "Hoá đơn QR" của panel thành viên, còn mã hàng
    đợi chỉ là id nội bộ. Suy lúc ĐỌC qua `payment_orders.queue_item_id` nên cả dòng
    mời (không hề biết tới hoá đơn) cũng có mã.
    """
    ws = create_ws(client, auth_header, "Audit Ref WS")
    sub = make_beta_sub(client, auth_header, username="audref", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "ord3@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]
    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-AUD-REF-1")
    )
    assert wh.status_code == 200 and wh.json().get("success") is True

    logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    by_action = {x["action"]: x for x in logs}
    for action in (
        "PAYMENT_ORDER_CREATED",
        "WALLET_ORDER_CREDITED",
        "MEMBER_INVITE_QUEUED",
        "WALLET_INVITE_CHARGED",
    ):
        assert action in by_action, sorted(by_action)
        got = (by_action[action].get("data") or {}).get("order_ref_code")
        assert got == order["ref_code"], (action, got)


def test_wallet_paid_command_has_no_order_ref_code(
    client: TestClient, auth_header: dict
) -> None:
    """Ví đủ tiền → không sinh hoá đơn ⇒ không được bịa mã cho lệnh."""
    ws = create_ws(client, auth_header, "Audit NoRef WS")
    sub = make_beta_sub(client, auth_header, username="audnoref", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "ord4@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text

    logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    queued = [x for x in logs if x["action"] == "MEMBER_INVITE_QUEUED"]
    assert queued, "phải có dòng mời"
    assert not (queued[0].get("data") or {}).get("order_ref_code")
