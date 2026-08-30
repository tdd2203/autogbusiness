"""Dòng tiền của 1 email — GET /workspaces/{ws}/members/{id}/payments.

Dựng lại đúng hình dạng ca stockbox.m (2026-08-04): mời hỏng → hoàn phí → mời lại
thành công. Panel phải cho thấy tiền THỰC THU, để "thu rồi hoàn hết mà vẫn còn hạn
dùng" không còn ẩn mình giữa ví và audit log.

Phủ:
  - Ghép khoản theo EMAIL (invite_fee/invite_refund neo theo queue_item_id).
  - Ghép khoản theo MEMBER_ID (renew_fee neo thẳng member.id).
  - Tổng thu / hoàn / thực thu.
  - Sub-admin chỉ thấy giao dịch trong ví CỦA MÌNH.

Xem app/routers/members/payments.md.
"""

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
EMAIL = "cashflow@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _bulk_invite(client: TestClient, token: str, ws_id: str, emails: list[str]) -> dict:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()


def _member(client: TestClient, ws_id: str, email: str, headers: dict) -> dict:
    r = client.get(f"/api/v1/workspaces/{ws_id}/members", headers=headers)
    assert r.status_code == 200, r.text
    return {m["email"]: m for m in r.json()}[email]


def _payments(client: TestClient, ws_id: str, member_id: str, headers: dict) -> dict:
    r = client.get(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/payments", headers=headers
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_payments_show_charge_refund_and_net(
    client: TestClient, auth_header: dict
) -> None:
    ws = create_ws(client, auth_header, "Cashflow WS")
    sub = make_beta_sub(client, auth_header, username="cashsub", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    # 1) Mời lần đầu → trừ phí, rồi task FAILED → hoàn phí.
    first = _bulk_invite(client, sub["token"], ws["id"], [EMAIL])
    assert wallet_of(client, sub["token"])["balance"] == 200_000
    r = client.patch(
        f"/api/v1/queue/{first['queue_item_id']}",
        json={"status": "FAILED", "error_code": "CONTENT_TIMEOUT"},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000

    # 2) Mời lại → trừ phí lần nữa (lần này giữ nguyên, không hoàn).
    _bulk_invite(client, sub["token"], ws["id"], [EMAIL])
    assert wallet_of(client, sub["token"])["balance"] == 200_000

    member = _member(client, ws["id"], EMAIL, auth_header)
    data = _payments(client, ws["id"], member["id"], auth_header)

    kinds = [e["kind"] for e in data["entries"]]
    assert sorted(kinds) == ["invite_fee", "invite_fee", "invite_refund"]
    assert data["charged_total"] == 2 * FEE
    assert data["refunded_total"] == FEE
    assert data["net_total"] == FEE  # thực thu đúng 1 lần phí
    # Mới nhất lên đầu.
    assert data["entries"][0]["created_at"] >= data["entries"][-1]["created_at"]


def test_payments_include_renew_fee_matched_by_member_id(
    client: TestClient, auth_header: dict
) -> None:
    ws = create_ws(client, auth_header, "Cashflow Renew WS")
    sub = make_beta_sub(client, auth_header, username="cashrenew", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])
    _bulk_invite(client, sub["token"], ws["id"], [EMAIL])
    member = _member(client, ws["id"], EMAIL, auth_header)

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/renew",
        json={"months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text

    data = _payments(client, ws["id"], member["id"], auth_header)
    # renew_fee KHÔNG mang email trong meta của ref, phải bắt được qua member_id.
    assert sorted(e["kind"] for e in data["entries"]) == ["invite_fee", "renew_fee"]
    assert data["net_total"] == 2 * FEE


def test_payments_hide_other_admins_wallet_from_sub_admin(
    client: TestClient, auth_header: dict
) -> None:
    """Email do đại lý KHÁC trả phí: super-admin thấy khoản đó, sub-admin thì không
    (số dư/giao dịch ví người khác không được lộ qua panel thành viên)."""
    ws = create_ws(client, auth_header, "Cashflow Visibility WS")
    payer = make_beta_sub(client, auth_header, username="cashpayer", balance=300_000)
    other = make_beta_sub(client, auth_header, username="cashother", balance=300_000)
    assign(client, auth_header, ws["id"], payer["id"])
    assign(client, auth_header, ws["id"], other["id"])

    _bulk_invite(client, payer["token"], ws["id"], [EMAIL])
    member = _member(client, ws["id"], EMAIL, auth_header)

    assert _payments(client, ws["id"], member["id"], auth_header)["net_total"] == FEE
    # `other` không mời member này → không thấy member (404 ở lớp visibility member).
    r = client.get(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/payments",
        headers=bearer(other["token"]),
    )
    assert r.status_code == 404, r.text


# ── Hoá đơn QR của lượt mời HỎNG → phải gạch (user 2026-08-27) ───────────────

def _webhook_body(note: str, amount: int, txn_id: str) -> dict:
    return {
        "transferType": "in",
        "transferAmount": amount,
        "content": note,
        "id": txn_id,
        "referenceCode": txn_id,
    }


def _qr_paid_invite(client: TestClient, sub: dict, ws: dict, email: str, txn_id: str) -> dict:
    """Ví rỗng → mời → 402 QR → webhook trả đủ tiền → order `paid` + đã thực thi."""
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": email, "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]
    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, txn_id))
    assert wh.status_code == 200 and wh.json().get("success") is True
    o = client.get(
        f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])
    ).json()
    assert o["status"] == "paid" and o["queue_item_id"], o
    return o


def test_qr_order_marked_refunded_when_its_invite_failed(
    client: TestClient, auth_header: dict
) -> None:
    """Nạp QR để mời → mời HỎNG → hoàn phí ⇒ hoá đơn phải mang `fee_refunded`.

    Ca thật imas_wangying@163.com (26/8/2026): 2 hoá đơn 330k đều khoe "Đã thanh
    toán" trong khi cả 2 lượt mời đều hỏng và phí đã hoàn sạch. Nhãn đó đánh lừa
    người đối soát → web gạch ngang hoá đơn theo cờ này.

    ⚠️ Mời hỏng thì member `pending` bị xoá luôn (phantom) → phải MỜI LẠI mới có
    member để mở panel; đúng hình dạng ca thật (hỏng vài lần rồi mới vào được).
    """
    ws = create_ws(client, auth_header, "Cashflow QR WS")
    sub = make_beta_sub(client, auth_header, username="cashqr", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    order = _qr_paid_invite(client, sub, ws, EMAIL, "ORD-CASH-VOID-1")
    member = _member(client, ws["id"], EMAIL, auth_header)
    # Chưa hoàn → hoá đơn vẫn là hoá đơn thật.
    data = _payments(client, ws["id"], member["id"], auth_header)
    assert [o["fee_refunded"] for o in data["orders"]] == [False]

    r = client.patch(
        f"/api/v1/queue/{order['queue_item_id']}",
        json={"status": "FAILED", "error_code": "CONTENT_TIMEOUT"},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text
    # Tiền QR ở LẠI ví (hoàn phí trả về ví, không trả về ngân hàng).
    assert wallet_of(client, sub["token"])["balance"] == FEE

    # Mời lại — ví đã đủ nên trừ thẳng, KHÔNG sinh hoá đơn QR thứ hai.
    _bulk_invite(client, sub["token"], ws["id"], [EMAIL])
    member = _member(client, ws["id"], EMAIL, auth_header)

    data = _payments(client, ws["id"], member["id"], auth_header)
    assert [o["fee_refunded"] for o in data["orders"]] == [True]
    assert data["net_total"] == FEE  # lượt mời lại là tiền thật, không bị gạch


# ── Hoá đơn mời ai, ai hỏng — `allocations` (user 2026-08-29) ────────────────

EMAIL_B = "cashflow-b@example.com"


def _qr_paid_bulk_invite(
    client: TestClient, sub: dict, ws: dict, emails: list[str], txn_id: str
) -> dict:
    """Ví rỗng → mời NHIỀU email → 402 QR gộp → webhook trả đủ → order `paid`."""
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]
    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], FEE * len(emails), txn_id)
    )
    assert wh.status_code == 200 and wh.json().get("success") is True
    o = client.get(
        f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])
    ).json()
    assert o["status"] == "paid" and o["queue_item_id"], o
    return o


def _backdate_members(ws_id: str, emails: list[str], minutes: int = 11) -> None:
    """Lùi mốc mời để vượt GUARD 10 PHÚT của phantom-cleanup: email 'tươi' lọt
    unverified được GIỮ chờ sync phân xử — không xoá, KHÔNG hoàn phí ngay."""
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


def _alloc(data: dict) -> dict[str, str]:
    assert len(data["orders"]) == 1, data["orders"]
    return {a["email"]: a["status"] for a in data["orders"][0]["allocations"]}


def test_order_allocations_show_who_the_money_invited(
    client: TestClient, auth_header: dict
) -> None:
    """Một hoá đơn trả cho CẢ LƯỢT mời: phải nói rõ email nào ăn phần nào, ai hỏng.

    Hoá đơn gộp (ca thật 29/8: 17 email, 5.610.000₫) mà panel chỉ hiện con số tổng
    thì không đối soát được. `allocations` trả ✓ cho email mời được, ✕ cho email đã
    hoàn phí — và `member_fee_refunded` chỉ bật trên panel CỦA EMAIL HỎNG, không kéo
    cả hoá đơn thành rỗng (email kia vẫn nhận được dịch vụ).
    """
    ws = create_ws(client, auth_header, "Cashflow Alloc WS")
    sub = make_beta_sub(client, auth_header, username="cashalloc", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    order_paid = _qr_paid_bulk_invite(
        client, sub, ws, [EMAIL, EMAIL_B], "ORD-CASH-ALLOC-1"
    )
    # Task xong nhưng verify không thấy EMAIL_B → chỉ hoàn phí của riêng nó.
    _backdate_members(ws["id"], [EMAIL, EMAIL_B])
    r = client.patch(
        f"/api/v1/queue/{order_paid['queue_item_id']}",
        json={
            "status": "COMPLETED",
            "result": {
                "verified_emails": [EMAIL],
                "unverified_emails": [EMAIL_B],
                "verify_scrape_failed": False,
            },
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text
    assert wallet_of(client, sub["token"])["balance"] == FEE  # phí của B quay về ví

    member = _member(client, ws["id"], EMAIL, auth_header)
    data = _payments(client, ws["id"], member["id"], auth_header)
    assert _alloc(data) == {EMAIL: "ok", EMAIL_B: "failed"}
    order = data["orders"][0]
    # Hoá đơn vẫn đổi được dịch vụ cho EMAIL ⇒ không gạch cả hoá đơn, và panel của
    # EMAIL không được coi đây là "hoá đơn thất bại".
    assert order["fee_refunded"] is False
    assert order["member_fee_refunded"] is False
    assert order["member_refunded_at"] is None

    # Mời lại B (ví đã có tiền hoàn) để có member mà mở panel — đúng hình dạng ca thật.
    _bulk_invite(client, sub["token"], ws["id"], [EMAIL_B])
    member_b = _member(client, ws["id"], EMAIL_B, auth_header)
    data_b = _payments(client, ws["id"], member_b["id"], auth_header)
    order_b = [o for o in data_b["orders"] if o["id"] == order["id"]]
    assert len(order_b) == 1, data_b["orders"]
    assert order_b[0]["member_fee_refunded"] is True
    assert order_b[0]["member_refunded_at"] is not None
    assert {a["email"]: a["status"] for a in order_b[0]["allocations"]} == {
        EMAIL: "ok",
        EMAIL_B: "failed",
    }


def test_order_allocations_mark_every_email_failed_when_task_failed(
    client: TestClient, auth_header: dict
) -> None:
    """Task hỏng cả lượt → mọi email `failed`, hoá đơn rỗng thật (`fee_refunded`)."""
    ws = create_ws(client, auth_header, "Cashflow Alloc Fail WS")
    sub = make_beta_sub(client, auth_header, username="cashallocfail", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    order = _qr_paid_bulk_invite(
        client, sub, ws, [EMAIL, EMAIL_B], "ORD-CASH-ALLOC-2"
    )
    r = client.patch(
        f"/api/v1/queue/{order['queue_item_id']}",
        json={"status": "FAILED", "error_code": "CONTENT_TIMEOUT"},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text

    _bulk_invite(client, sub["token"], ws["id"], [EMAIL])
    member = _member(client, ws["id"], EMAIL, auth_header)
    data = _payments(client, ws["id"], member["id"], auth_header)
    failed_order = [o for o in data["orders"] if o["id"] == order["id"]][0]
    assert failed_order["fee_refunded"] is True
    assert failed_order["member_fee_refunded"] is True
    assert {a["email"]: a["status"] for a in failed_order["allocations"]} == {
        EMAIL: "failed",
        EMAIL_B: "failed",
    }
