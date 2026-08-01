"""US3 — Rút tiền: hold khi tạo, settle/reject bởi super-admin, không rút quá khả dụng.

Phủ FR-021..026 + US3 scenario 5 (held không dùng để trả phí mời).
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


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    """Ghim phí mời = 100k + cấu hình ngân hàng. test_held_not_usable_for_invite giả
    định 3 email = 300k; nếu không ghim, phí mặc định test = 0 → mời miễn phí → sai."""
    set_settings(client, auth_header, invite_fee_vnd=100_000)


def _withdraw(client: TestClient, token: str, amount: int, bank="ACB - 123 - A", note=None):
    return client.post(
        "/api/v1/wallet/withdrawals",
        json={"amount_vnd": amount, "bank_account": bank, "note": note},
        headers=bearer(token),
    )


def test_withdraw_holds_balance(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="wd1", balance=500_000)
    r = _withdraw(client, sub["token"], 300_000)
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "pending"

    w = wallet_of(client, sub["token"])
    assert w["balance"] == 200_000  # khả dụng giảm
    assert w["held"] == 300_000  # phần rút bị giữ
    assert w["total"] == 500_000


def test_withdraw_exceeding_available_rejected(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="wd2", balance=100_000)
    r = _withdraw(client, sub["token"], 300_000)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "INSUFFICIENT_BALANCE"
    assert wallet_of(client, sub["token"])["balance"] == 100_000


def test_settle_deducts_held(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="wd3", balance=500_000)
    wid = _withdraw(client, sub["token"], 300_000).json()["id"]

    # Super-admin thấy yêu cầu chờ + đánh dấu đã chi.
    pending = client.get("/api/v1/wallet/admin/withdrawals?status=pending", headers=auth_header).json()
    assert any(x["id"] == wid for x in pending)

    r = client.post(f"/api/v1/wallet/admin/withdrawals/{wid}/settle", headers=auth_header)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "settled"

    w = wallet_of(client, sub["token"])
    assert w["held"] == 0
    assert w["balance"] == 200_000
    assert w["total"] == 200_000  # tiền đã rời ví
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    assert any(t["kind"] == "withdraw_settle" for t in txns)


def test_reject_refunds_held(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="wd4", balance=500_000)
    wid = _withdraw(client, sub["token"], 300_000).json()["id"]

    r = client.post(
        f"/api/v1/wallet/admin/withdrawals/{wid}/reject",
        json={"reason": "sai STK"},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected"

    w = wallet_of(client, sub["token"])
    assert w["held"] == 0
    assert w["balance"] == 500_000  # hoàn về khả dụng


def test_settle_twice_conflicts(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="wd5", balance=500_000)
    wid = _withdraw(client, sub["token"], 100_000).json()["id"]
    assert client.post(f"/api/v1/wallet/admin/withdrawals/{wid}/settle", headers=auth_header).status_code == 200
    # Lần 2 → 409 (không còn pending)
    assert client.post(f"/api/v1/wallet/admin/withdrawals/{wid}/settle", headers=auth_header).status_code == 409


def test_held_not_usable_for_invite(client: TestClient, auth_header: dict) -> None:
    """US3 scenario 5 — phần đang giữ để rút KHÔNG dùng trả phí mời được."""
    ws = create_ws(client, auth_header, "Held WS")
    sub = make_beta_sub(client, auth_header, username="wd6", balance=500_000)
    assign(client, auth_header, ws["id"], sub["id"])

    _withdraw(client, sub["token"], 300_000)  # còn khả dụng 200k, held 300k
    # Mời 3 email (300k) > 200k khả dụng → 402 (không đụng held).
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": ["h1@example.com", "h2@example.com", "h3@example.com"], "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    w = wallet_of(client, sub["token"])
    assert w["balance"] == 200_000 and w["held"] == 300_000
