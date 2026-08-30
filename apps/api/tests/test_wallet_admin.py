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

    assert any(
        t["kind"] == "adjust" and (t.get("meta") or {}).get("reason") == "nạp demo" for t in txns
    )

    audit = client.get("/api/v1/audit-logs", headers=auth_header).json()
    audit_items = audit if isinstance(audit, list) else audit.get("items", [])
    assert any(a["action"] == "WALLET_ADJUSTED" for a in audit_items)


def test_admin_transactions_carry_reconcile_fields(client: TestClient, auth_header: dict) -> None:
    """Modal quản trị phải lần được từ khoản tiền ra tận lệnh đã chạy và người bấm
    nút. Trang Ví của người dùng cố ý không có mấy trường này — bản admin thì bắt
    buộc, nếu không thì đối soát phải mò trong DB (user 2026-08-29)."""
    set_settings(client, auth_header, invite_fee_vnd=120_000)
    ws = create_ws(client, auth_header, "Trace WS")
    sub = make_beta_sub(client, auth_header, username="tracefields", balance=120_000)
    assign(client, auth_header, ws["id"], sub["id"])
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "trace@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text

    items = client.get(
        f"/api/v1/wallet/admin/users/{sub['id']}/transactions", headers=auth_header
    ).json()["items"]

    fee = next(t for t in items if t["kind"] == "invite_fee")
    assert fee["seq"] > 0  # khoá sắp xếp thật của sổ cái
    assert fee["actor_email"]  # chính chủ ví bấm mời
    assert fee["member_email"] == "trace@example.com"
    assert fee["queue_item_id"] == fee["ref_id"]
    assert fee["queue_item_type"] == "INVITE_MEMBER"
    assert fee["workspace_id"] == ws["id"]
    assert fee["workspace_name"] == "Trace WS"

    # Nạp demo do super-admin ghi → phải quy được về đúng người bấm.
    topup = next(t for t in items if t["kind"] == "adjust")
    assert topup["actor_email"]
    assert topup["queue_item_id"] is None and topup["ref_code"] is None


def test_admin_daily_summary_matches_owner_view(client: TestClient, auth_header: dict) -> None:
    """Trang Quản trị Ví hiện ĐÚNG giao diện trang Ví cho tài khoản khác, nên hai thẻ
    tổng kết ngày phải ra cùng con số — nếu lệch thì super-admin và chủ ví đang nhìn
    hai sự thật khác nhau (user 2026-08-29)."""
    set_settings(client, auth_header, invite_fee_vnd=100_000)
    ws = create_ws(client, auth_header, "Daily WS")
    sub = make_beta_sub(client, auth_header, username="dailysame", balance=100_000)
    assign(client, auth_header, ws["id"], sub["id"])
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "daily@example.com", "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text

    mine = client.get("/api/v1/wallet/daily-summary", headers=bearer(sub["token"]))
    assert mine.status_code == 200, mine.text
    admin_view = client.get(
        f"/api/v1/wallet/admin/users/{sub['id']}/daily-summary", headers=auth_header
    )
    assert admin_view.status_code == 200, admin_view.text
    assert admin_view.json() == mine.json()
    assert mine.json()["invite_count"] == 1


def test_admin_daily_summary_requires_super_admin(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="dailyguard")
    r = client.get(
        f"/api/v1/wallet/admin/users/{sub['id']}/daily-summary", headers=bearer(sub["token"])
    )
    assert r.status_code == 403


def test_admin_adjust_requires_reason(client: TestClient, auth_header: dict) -> None:
    """Nạp/điều chỉnh phải kèm lý do — thiếu hoặc để trắng đều 422 (user 2026-08-14)."""
    user = create_user(client, auth_header, "adjustnoreason", ["MEMBER_VIEW"])
    url = f"/api/v1/wallet/admin/users/{user['id']}/adjust"
    for body in ({"amount_vnd": 500_000}, {"amount_vnd": 500_000, "reason": "   "}):
        r = client.post(url, json=body, headers=auth_header)
        assert r.status_code == 422, r.text

    txns = client.get(
        f"/api/v1/wallet/admin/users/{user['id']}/transactions", headers=auth_header
    ).json()["items"]
    assert not txns


def test_settings_get_reports_webhook_config(client: TestClient, auth_header: dict) -> None:
    s = client.get("/api/v1/wallet/admin/settings", headers=auth_header).json()
    # Không set SEPAY_APIKEY trong test → false; không lộ secret.
    assert s["sepay_webhook_configured"] is False
    assert "invite_fee_vnd" in s
