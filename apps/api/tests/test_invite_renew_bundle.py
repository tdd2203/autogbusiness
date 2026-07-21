"""Paste modal GỘP gia hạn + mời: email đang ACTIVE trong danh sách paste → GIA HẠN
(cộng dồn + phí gia hạn) thay vì mời trùng; email mới → mời như thường. Phí gộp chung:
ví đủ trừ cả 2 loại, ví thiếu tạo 1 hoá đơn QR gộp. Xem [[subscription-cycle-model]]
/ invite.py::perform_invite_core (nhánh active → perform_renew_core)."""
from fastapi.testclient import TestClient
from tests.wallet_helpers import (
    assign, bearer, create_ws, make_beta_sub, set_settings, wallet_of,
)

FEE = 100_000


def test_bulk_invite_charges_invite_and_renew_together(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)
    ws = create_ws(client, auth_header, "Mix WS")  # no seat_total → seat guard off
    sub = make_beta_sub(client, auth_header, username="mixer", balance=1_000_000)
    assign(client, auth_header, ws["id"], sub["id"])
    tok = sub["token"]

    # 1) sub mời a@ (mới) → member pending, invited_by=sub, trừ 1 invite_fee.
    r = client.post(f"/api/v1/workspaces/{ws['id']}/members/invite",
                    json={"email": "a@example.com", "role": "member"}, headers=bearer(tok))
    assert r.status_code == 201, r.text
    assert wallet_of(client, tok)["balance"] == 900_000

    # 2) promote a@ -> active (như đã tham gia + sync về)
    client.post(f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
                json={"members": [{"email": "a@example.com", "chatgpt_role": "member", "status": "active"}]},
                headers={"X-API-KEY": ws["extension_api_key"]})

    # 3) PASTE gộp: a@ (active → GIA HẠN +1) + b@ (mới) qua bulk-invite.
    r = client.post(f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
                    json={"invites": [{"email": "a@example.com", "subscription_months": 1},
                                      {"email": "b@example.com", "subscription_months": 1}],
                          "role": "member"}, headers=bearer(tok))
    assert r.status_code == 202, r.text
    resp = r.json()
    assert resp["renewed_count"] == 1 and resp["invited_count"] == 1, resp

    # Ví trừ CẢ renew_fee (a@) + invite_fee (b@) = 200k → 900k - 200k = 700k.
    assert wallet_of(client, tok)["balance"] == 700_000, "phải trừ cả phí gia hạn lẫn mời"

    txns = client.get("/api/v1/wallet/transactions", headers=bearer(tok)).json()["items"]
    renews = [t for t in txns if t["kind"] == "renew_fee"]
    invites = [t for t in txns if t["kind"] == "invite_fee"]
    assert len(renews) == 1 and renews[0]["amount"] == -FEE, txns
    assert len(invites) == 2, txns  # a@ (bước 1) + b@ (bước 3)

    members = {m["email"]: m for m in client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=bearer(tok)).json()}
    assert members["a@example.com"]["status"] == "active"
    assert members["b@example.com"]["status"] == "pending"


def test_bulk_invite_insufficient_bundles_renew_and_invite_into_one_qr(
    client: TestClient, auth_header: dict
) -> None:
    """Ví KHÔNG đủ → 1 hoá đơn QR gộp TỔNG phí (gia hạn active + mời mới)."""
    set_settings(client, auth_header, invite_fee_vnd=FEE)
    ws = create_ws(client, auth_header, "QR WS")
    sub = make_beta_sub(client, auth_header, username="qrmix", balance=150_000)
    assign(client, auth_header, ws["id"], sub["id"])
    tok = sub["token"]

    # a@ mới → active (đủ 150k cho 1 lần mời, còn 50k)
    client.post(f"/api/v1/workspaces/{ws['id']}/members/invite",
                json={"email": "a@example.com", "role": "member"}, headers=bearer(tok))
    client.post(f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
                json={"members": [{"email": "a@example.com", "chatgpt_role": "member", "status": "active"}]},
                headers={"X-API-KEY": ws["extension_api_key"]})
    assert wallet_of(client, tok)["balance"] == 50_000

    # PASTE a@ (gia hạn 100k) + b@ (mời 100k) = 200k > 50k → 1 QR gộp.
    r = client.post(f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
                    json={"invites": [{"email": "a@example.com", "subscription_months": 1},
                                      {"email": "b@example.com", "subscription_months": 1}],
                          "role": "member"}, headers=bearer(tok))
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]
    assert order["kind"] == "invite"
    assert order["amount_vnd"] == 2 * FEE, "QR phải gộp phí gia hạn + mời"
    # Chưa trừ tiền, b@ chưa tạo.
    assert wallet_of(client, tok)["balance"] == 50_000
    emails = [m["email"] for m in client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=bearer(tok)).json()]
    assert "b@example.com" not in emails
