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
