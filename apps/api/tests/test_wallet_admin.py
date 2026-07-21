"""US4 — Quản trị Ví (super-admin): cấu hình phí, cờ beta, xem ví, nạp demo.

Phủ FR-027..032, guard permission, đổi phí áp lần mời sau.
"""

from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_user,
    create_ws,
    login,
    make_beta_sub,
    set_settings,
    wallet_of,
)


def test_admin_endpoints_require_super_admin(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="notadmin")
    h = bearer(sub["token"])
    assert client.get("/api/v1/wallet/admin/settings", headers=h).status_code == 403
    assert client.get("/api/v1/wallet/admin/users", headers=h).status_code == 403
    assert client.get("/api/v1/wallet/admin/withdrawals", headers=h).status_code == 403


def test_update_fee_applies_to_next_invite(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=150_000)
    ws = create_ws(client, auth_header, "Fee Change WS")
    sub = make_beta_sub(client, auth_header, username="feechange", balance=150_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "fc@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text
    assert wallet_of(client, sub["token"])["balance"] == 0  # trừ đúng 150k


def test_toggle_beta_preserves_balance(client: TestClient, auth_header: dict) -> None:
    """FR-032 — tắt cờ Ví không làm mất số dư/giao dịch."""
    sub = make_beta_sub(client, auth_header, username="toggle", balance=200_000)

    # Tắt cờ
    r = client.put(
        f"/api/v1/wallet/admin/users/{sub['id']}/beta",
        json={"enabled": False},
        headers=auth_header,
    )
    assert r.status_code == 200 and r.json()["wallet_beta"] is False

    # User giờ không vào được /wallet (403) nhưng số dư vẫn còn (super-admin xem được).
    assert client.get("/api/v1/wallet", headers=bearer(sub["token"])).status_code == 403
    users = client.get("/api/v1/wallet/admin/users", headers=auth_header).json()
    row = next(u for u in users if u["user_id"] == sub["id"])
    assert row["balance"] == 200_000

    # Bật lại → thấy nguyên số dư.
    client.put(
        f"/api/v1/wallet/admin/users/{sub['id']}/beta",
        json={"enabled": True},
        headers=auth_header,
    )
    assert wallet_of(client, sub["token"])["balance"] == 200_000


def test_admin_adjust_creates_txn_and_audit(client: TestClient, auth_header: dict) -> None:
    user = create_user(client, auth_header, "adjustme", ["MEMBER_VIEW"])
    r = client.post(
        f"/api/v1/wallet/admin/users/{user['id']}/adjust",
        json={"amount_vnd": 500_000, "reason": "nạp demo"},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "adjust"
    assert r.json()["amount"] == 500_000

    txns = client.get(
        f"/api/v1/wallet/admin/users/{user['id']}/transactions", headers=auth_header
    ).json()["items"]
    assert any(t["kind"] == "adjust" and t["amount"] == 500_000 for t in txns)

    audit = client.get("/api/v1/audit-logs", headers=auth_header).json()
    audit_items = audit if isinstance(audit, list) else audit.get("items", [])
    assert any(a["action"] == "WALLET_ADJUSTED" for a in audit_items)


def test_settings_get_reports_webhook_config(client: TestClient, auth_header: dict) -> None:
    s = client.get("/api/v1/wallet/admin/settings", headers=auth_header).json()
    # Không set SEPAY_APIKEY trong test → false; không lộ secret.
    assert s["sepay_webhook_configured"] is False
    assert "invite_fee_vnd" in s
