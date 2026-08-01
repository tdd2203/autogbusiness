"""US2 — Bắt buộc số dư & trừ phí khi mời.

Phủ FR-014..020, SC-006 (non-beta không đổi luồng) + luồng "ví trước, QR sau"
(user 2026-07-13): ví thiếu → hoá đơn QR thay cho lỗi.

Phí mặc định hệ thống giờ = 380k; test GHIM về 100k qua settings (fixture `_pin_fee`)
để giữ nguyên các con số + cấu hình sẵn ngân hàng để nhánh QR dựng được mã.
"""

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_user,
    create_ws,
    login,
    make_beta_sub,
    set_beta,
    set_settings,
    wallet_of,
)

FEE = 100_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    """Ghim phí mặc định = 100k + cấu hình ngân hàng (để nhánh QR hoạt động)."""
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _invite(client: TestClient, token: str, ws_id: str, email: str, **extra):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", **extra},
        headers=bearer(token),
    )


def _bulk(client: TestClient, token: str, ws_id: str, emails: list[str]):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=bearer(token),
    )


def test_invite_charges_fee_when_enough(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Fee WS")  # no seat_total → seat guard off
    sub = make_beta_sub(client, auth_header, username="payer", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "a@example.com")
    assert r.status_code == 201, r.text

    assert wallet_of(client, sub["token"])["balance"] == 200_000
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    fees = [t for t in txns if t["kind"] == "invite_fee"]
    assert len(fees) == 1
    assert fees[0]["amount"] == -FEE
    assert fees[0]["meta"]["email"] == "a@example.com"


def test_invite_insufficient_creates_qr_order(client: TestClient, auth_header: dict) -> None:
    """Ví thiếu → 402 PAYMENT_QR_REQUIRED + hoá đơn QR pending, KHÔNG tạo member/queue,
    số dư không đổi (user 2026-07-13: tạo QR thay cho lỗi)."""
    ws = create_ws(client, auth_header, "Broke WS")
    sub = make_beta_sub(client, auth_header, username="broke", balance=50_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "nope@example.com")
    assert r.status_code == 402, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "PAYMENT_QR_REQUIRED"
    order = detail["order"]
    assert order["kind"] == "invite"
    assert order["amount_vnd"] == FEE
    assert order["status"] == "pending"
    assert order["qr_url"] and "vietqr.app" in order["qr_url"] and "template=qronly" in order["qr_url"]
    assert order["note"].startswith("ORDER") and order["note"].endswith(order["ref_code"])

    # Không trừ tiền, không tạo member.
    assert wallet_of(client, sub["token"])["balance"] == 50_000
    members = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=bearer(sub["token"])
    ).json()
    emails = [m["email"] for m in (members if isinstance(members, list) else members.get("items", []))]
    assert "nope@example.com" not in emails

    # Có đúng 1 hoá đơn pending khớp số tiền.
    orders = client.get("/api/v1/wallet/orders", headers=bearer(sub["token"])).json()
    assert len(orders) == 1
    assert orders[0]["status"] == "pending" and orders[0]["amount_vnd"] == FEE


def test_reinvite_still_valid_member_is_free(client: TestClient, auth_header: dict) -> None:
    """CÒN HẠN + bị xoá → mời lại KHÔNG bị tính phí (user 2026-07-14): đã trả cho kỳ
    này rồi, xoá không hoàn tiền → mời lại chỉ tiếp tục kỳ cũ. Số dư giữ nguyên, không
    sinh giao dịch invite_fee mới, không đòi QR."""
    ws = create_ws(client, auth_header, "Reinvite WS")
    sub = make_beta_sub(client, auth_header, username="reinviter", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    # Mời lần đầu (gói 1 tháng → còn hạn ≈ now+30) → trừ 1× phí.
    r = _invite(client, sub["token"], ws["id"], "keep@example.com", subscription_months=1)
    assert r.status_code == 201, r.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE

    # Xoá (member pending → REVOKE_INVITES) rồi giả lập extension hoàn tất → removed.
    # Dùng super-admin để xoá (sub chỉ có MEMBER_VIEW/INVITE, không có MEMBER_REMOVE).
    dr = client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{r.json()['id']}",
        headers=auth_header,
    )
    assert dr.status_code == 202, dr.text
    revoke = next(
        q
        for q in client.get("/api/v1/queue?limit=50", headers=auth_header).json()
        if q["type"] == "REVOKE_INVITES"
    )
    client.patch(
        f"/api/v1/queue/{revoke['id']}",
        json={"status": "COMPLETED", "result": {"data": {"results": [{"email": "keep@example.com", "ok": True}]}}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    # Mời lại → MIỄN PHÍ: số dư KHÔNG đổi, vẫn đúng 1 giao dịch invite_fee (của lần đầu).
    r2 = _invite(client, sub["token"], ws["id"], "keep@example.com", subscription_months=1)
    assert r2.status_code == 201, r2.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE, (
        "mời lại email còn hạn KHÔNG được trừ phí lần 2"
    )
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    assert len([t for t in txns if t["kind"] == "invite_fee"]) == 1


def test_bulk_charges_per_email(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Bulk WS")
    sub = make_beta_sub(client, auth_header, username="bulker", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _bulk(client, sub["token"], ws["id"], ["b1@example.com", "b2@example.com", "b3@example.com"])
    assert r.status_code == 202, r.text
    assert r.json()["count"] == 3
    assert wallet_of(client, sub["token"])["balance"] == 0
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    assert len([t for t in txns if t["kind"] == "invite_fee"]) == 3


def test_bulk_insufficient_creates_qr_order(client: TestClient, auth_header: dict) -> None:
    """Bulk ví thiếu → QR cho TỔNG phí, không tạo member/queue, số dư nguyên vẹn."""
    ws = create_ws(client, auth_header, "Bulk Broke")
    sub = make_beta_sub(client, auth_header, username="bulkbroke", balance=250_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _bulk(client, sub["token"], ws["id"], ["c1@example.com", "c2@example.com", "c3@example.com"])
    assert r.status_code == 402, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "PAYMENT_QR_REQUIRED"
    assert detail["order"]["amount_vnd"] == 3 * FEE
    assert detail["order"]["kind"] == "invite"
    # Không tạo gì, số dư nguyên vẹn.
    assert wallet_of(client, sub["token"])["balance"] == 250_000


def test_super_admin_invite_free(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Super Free WS")
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "sfree@example.com", "role": "member"},
        headers=auth_header,
    )
    assert r.status_code == 201, r.text
    # Không có giao dịch invite_fee nào trong hệ thống (kiểm qua admin của super).
    users = client.get("/api/v1/wallet/admin/users", headers=auth_header).json()
    super_id = next(u["user_id"] for u in users if u["is_super_admin"])
    txns = client.get(
        f"/api/v1/wallet/admin/users/{super_id}/transactions", headers=auth_header
    ).json()["items"]
    assert [t for t in txns if t["kind"] == "invite_fee"] == []


def test_per_member_fee_overrides_default(client: TestClient, auth_header: dict) -> None:
    """FR-014 — super-admin đặt phí RIÊNG cho member → lần mời sau trừ theo phí đó."""
    ws = create_ws(client, auth_header, "PerMember WS")
    sub = make_beta_sub(client, auth_header, username="permember", balance=500_000)
    assign(client, auth_header, ws["id"], sub["id"])

    # Mời lần đầu (member mới) → phí mặc định 100k.
    r = _invite(client, sub["token"], ws["id"], "pm@example.com")
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 400_000

    # Super-admin đặt phí riêng 250k cho member này.
    fr = client.put(
        f"/api/v1/wallet/admin/members/{member_id}/fee",
        json={"fee_vnd": 250_000},
        headers=auth_header,
    )
    assert fr.status_code == 200, fr.text
    assert fr.json()["fee_vnd"] == 250_000

    # Mời lại (member pending → re-invite qua bulk) → trừ đúng 250k (phí riêng).
    br = _bulk(client, sub["token"], ws["id"], ["pm@example.com"])
    assert br.status_code == 202, br.text
    assert wallet_of(client, sub["token"])["balance"] == 150_000  # 400k - 250k


def test_member_fee_zero_is_free(client: TestClient, auth_header: dict) -> None:
    """Super-admin đặt phí = 0 cho member → mời không trừ tiền."""
    ws = create_ws(client, auth_header, "FreeMember WS")
    sub = make_beta_sub(client, auth_header, username="freemember", balance=100_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "z@example.com")
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 0  # default 100k trừ hết

    client.put(
        f"/api/v1/wallet/admin/members/{member_id}/fee",
        json={"fee_vnd": 0},
        headers=auth_header,
    )
    # Re-invite → phí 0 → không trừ (balance vẫn 0, không âm, không 402).
    br = _bulk(client, sub["token"], ws["id"], ["z@example.com"])
    assert br.status_code == 202, br.text
    assert wallet_of(client, sub["token"])["balance"] == 0


def test_non_beta_sub_invite_free(client: TestClient, auth_header: dict) -> None:
    """SC-006 — user KHÔNG bật cờ Ví: mời miễn phí, không đổi luồng."""
    ws = create_ws(client, auth_header, "NonBeta WS")
    user = create_user(client, auth_header, "nonbeta", ["MEMBER_VIEW", "MEMBER_INVITE"])
    # wallet_beta MẶC ĐỊNH True (user 2026-07-14) → phải TẮT cờ để đúng kịch bản
    # SC-006 "user không bật Ví". Không tắt → user bị tính phí như beta.
    set_beta(client, auth_header, user["id"], enabled=False)
    assign(client, auth_header, ws["id"], user["id"])
    token = login(client, "nonbeta")

    r = _invite(client, token, ws["id"], "free@example.com")
    assert r.status_code == 201, r.text

    # /wallet bị 403 (chưa bật cờ), và admin thấy user không có giao dịch nào.
    assert client.get("/api/v1/wallet", headers=bearer(token)).status_code == 403
    txns = client.get(
        f"/api/v1/wallet/admin/users/{user['id']}/transactions", headers=auth_header
    ).json()["items"]
    assert txns == []
