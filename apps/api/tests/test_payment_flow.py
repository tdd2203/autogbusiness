"""Feature 003 (bổ sung, user 2026-07-13) — "Ví trước, QR sau" cho mời/gia hạn.

Phủ:
  - Ví ĐỦ → trừ ví + tạo member/queue ngay (invite & renew).
  - Ví THIẾU → 402 PAYMENT_QR_REQUIRED + hoá đơn pending, KHÔNG tạo gì.
  - Webhook nhận đúng tiền (mã ORDER) → credit ví + THỰC THI mời/gia hạn (net ví 0).
  - Mời QR-paid rồi task FAILED → hoàn phí về ví (tiền QR ở lại ví, không mất).
  - Webhook sai số tiền → declined, không credit/thực thi (nạp thất bại, không làm gì).
  - Webhook idempotent (trùng txn không cộng/thực thi 2 lần).
  - Phí 2 tầng: user default (đại lý) + override theo member.

Phí GHIM = 100k (mặc định hệ thống giờ 380k) + cấu hình ngân hàng (fixture `_pin_fee`).
"""

from datetime import datetime, timedelta, timezone

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


def _invite(client: TestClient, token: str, ws_id: str, email: str, **extra):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", **extra},
        headers=bearer(token),
    )


def _members(client: TestClient, token: str, ws_id: str) -> list[dict]:
    data = client.get(f"/api/v1/workspaces/{ws_id}/members", headers=bearer(token)).json()
    return data if isinstance(data, list) else data.get("items", [])


def _txn_kinds(client: TestClient, token: str) -> list[str]:
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(token)).json()["items"]
    return [t["kind"] for t in txns]


# ── Invite: ví đủ → trừ thẳng ────────────────────────────────────────────────

def test_invite_wallet_sufficient_charges_and_creates(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Enough WS")
    sub = make_beta_sub(client, auth_header, username="enough", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "a@example.com")
    assert r.status_code == 201, r.text
    assert wallet_of(client, sub["token"])["balance"] == 200_000
    assert "a@example.com" in [m["email"] for m in _members(client, sub["token"], ws["id"])]


# ── Invite: ví thiếu → QR → trả tiền → thực thi ──────────────────────────────

def test_invite_qr_paid_executes_invite(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "QR Invite WS")
    sub = make_beta_sub(client, auth_header, username="qrinv", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "q1@example.com")
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]
    assert order["kind"] == "invite" and order["amount_vnd"] == FEE
    # Chưa thực thi: chưa có member.
    assert "q1@example.com" not in [m["email"] for m in _members(client, sub["token"], ws["id"])]

    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-INV-1"))
    assert wh.status_code == 200 and wh.json().get("success") is True

    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])).json()
    assert o["status"] == "paid" and o["queue_item_id"]
    # Member được tạo (pending), ví net 0 (credit 100k − phí 100k).
    assert "q1@example.com" in [m["email"] for m in _members(client, sub["token"], ws["id"])]
    assert wallet_of(client, sub["token"])["balance"] == 0
    kinds = _txn_kinds(client, sub["token"])
    assert "order_topup" in kinds and "invite_fee" in kinds


def test_invite_qr_fulfillment_blocked_when_email_owned_by_other(
    client: TestClient, auth_header: dict
) -> None:
    """Cửa sổ chờ trả tiền: order QR tạo lúc 402 CHƯA tạo Member nên email còn trống.
    Nếu tài khoản KHÁC mời trúng email đó trước khi A trả tiền → lúc A trả, fulfillment
    phải KIỂM lại chủ-sở-hữu và TỪ CHỐI thực thi (không cướp email/không ghi đè
    invited_by). Tiền QR vẫn credit vào ví A (không mất), KHÔNG trừ phí, order không
    có queue_item. Xem [[invite-owner-lock]]."""
    ws = create_ws(client, auth_header, "QR Owner Race WS")
    a = make_beta_sub(client, auth_header, username="qrracea", balance=0)
    b = make_beta_sub(client, auth_header, username="qrraceb", balance=FEE)
    assign(client, auth_header, ws["id"], a["id"])
    assign(client, auth_header, ws["id"], b["id"])

    # A ví rỗng → 402 + order (chưa tạo member).
    r = _invite(client, a["token"], ws["id"], "race@example.com")
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]

    # B (đủ ví) mời trúng cùng email TRƯỚC khi A trả → member owned by B.
    rb = _invite(client, b["token"], ws["id"], "race@example.com")
    assert rb.status_code in (200, 201), rb.text

    # A trả QR → fulfillment gặp email đã thuộc B → từ chối thực thi.
    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-RACE-1"))
    assert wh.status_code == 200 and wh.json().get("success") is True

    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(a["token"])).json()
    assert o["status"] == "paid"
    assert o["queue_item_id"] is None  # KHÔNG thực thi → không có queue
    # Tiền QR credit vào ví A nhưng KHÔNG trừ phí mời (action bị chặn).
    assert wallet_of(client, a["token"])["balance"] == FEE
    assert "invite_fee" not in _txn_kinds(client, a["token"])


def test_order_amount_mismatch_declines(client: TestClient, auth_header: dict) -> None:
    """Nạp KHÔNG thành công (sai số tiền) → không credit, không thực thi, order pending."""
    ws = create_ws(client, auth_header, "Mismatch WS")
    sub = make_beta_sub(client, auth_header, username="mmorder", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    order = _invite(client, sub["token"], ws["id"], "m1@example.com").json()["detail"]["order"]

    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], 50_000, "ORD-MM-1"))
    assert wh.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert "m1@example.com" not in [m["email"] for m in _members(client, sub["token"], ws["id"])]
    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])).json()
    assert o["status"] == "pending"


def test_order_webhook_idempotent(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Idem Order WS")
    sub = make_beta_sub(client, auth_header, username="idemorder", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    order = _invite(client, sub["token"], ws["id"], "d1@example.com").json()["detail"]["order"]

    body = _webhook_body(order["note"], FEE, "ORD-IDEM-1")
    client.post("/webhook/sepay", json=body)
    assert wallet_of(client, sub["token"])["balance"] == 0
    # Gửi lại cùng txn → duplicate, không cộng/thực thi lần 2.
    client.post("/webhook/sepay", json=body)
    assert wallet_of(client, sub["token"])["balance"] == 0
    kinds = _txn_kinds(client, sub["token"])
    assert kinds.count("order_topup") == 1 and kinds.count("invite_fee") == 1
    assert len([m for m in _members(client, sub["token"], ws["id"]) if m["email"] == "d1@example.com"]) == 1


def test_order_duplicate_invoice_credited_as_topup(client: TestClient, auth_header: dict) -> None:
    """Thanh toán TRÙNG hoá đơn (user quét lại QR đã lưu → giao dịch NH khác, cùng mã
    ORDER đã paid): KHÔNG mời lần 2, nhưng cộng thẳng khoản trùng vào ví dạng nạp tiền
    + cờ duplicate_invoice để tiền không bị mất (user 2026-07-27)."""
    ws = create_ws(client, auth_header, "Dup Invoice WS")
    sub = make_beta_sub(client, auth_header, username="dupinv", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    order = _invite(client, sub["token"], ws["id"], "dup1@example.com").json()["detail"]["order"]

    # Lần 1: thanh toán đúng → mời + net ví 0.
    client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-DUP-1"))
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert len([m for m in _members(client, sub["token"], ws["id"]) if m["email"] == "dup1@example.com"]) == 1

    # Lần 2: CÙNG nội dung (mã ORDER) nhưng txn NH KHÁC → trùng hoá đơn → cộng ví FEE.
    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-DUP-2"))
    assert wh.status_code == 200 and wh.json().get("success") is True
    assert wallet_of(client, sub["token"])["balance"] == FEE

    # KHÔNG mời/trừ phí lần 2; khoản trùng ghi là `topup` cờ duplicate_invoice.
    kinds = _txn_kinds(client, sub["token"])
    assert kinds.count("invite_fee") == 1
    assert len([m for m in _members(client, sub["token"], ws["id"]) if m["email"] == "dup1@example.com"]) == 1
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    dup = [t for t in txns if (t.get("meta") or {}).get("duplicate_invoice")]
    assert len(dup) == 1 and dup[0]["kind"] == "topup" and dup[0]["amount"] == FEE


def test_invite_qr_paid_then_failed_refunds_to_wallet(client: TestClient, auth_header: dict) -> None:
    """Mời lỗi thì không trừ tiền; tiền QR ở lại ví (user 2026-07-13)."""
    ws = create_ws(client, auth_header, "QR Fail WS")
    sub = make_beta_sub(client, auth_header, username="qrfail", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    order = _invite(client, sub["token"], ws["id"], "f1@example.com").json()["detail"]["order"]

    client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-FAIL-1"))
    assert wallet_of(client, sub["token"])["balance"] == 0
    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])).json()
    qid = o["queue_item_id"]
    assert qid

    # Task mời FAILED → hoàn phí về ví → ví = đúng số tiền QR đã nạp (100k).
    r = client.patch(
        f"/api/v1/queue/{qid}",
        json={"status": "FAILED", "error_code": "UI_ELEMENT_NOT_FOUND"},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text
    assert wallet_of(client, sub["token"])["balance"] == FEE
    assert "invite_refund" in _txn_kinds(client, sub["token"])


# ── Renew: phí dùng chung mã hoá đơn ─────────────────────────────────────────

def test_renew_wallet_charges_fee(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Renew WS")
    sub = make_beta_sub(client, auth_header, username="renewpay", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "rn@example.com")
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 200_000

    # Phí gia hạn = FEE/tháng × 2 tháng = 200k → 200k − 200k = 0.
    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/renew",
        json={"months": 2},
        headers=bearer(sub["token"]),
    )
    assert rr.status_code == 200, rr.text
    assert rr.json()["subscription_months"] == 2
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert "renew_fee" in _txn_kinds(client, sub["token"])


def test_renew_qr_paid_executes_renew(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Renew QR WS")
    sub = make_beta_sub(client, auth_header, username="renewqr", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "rq@example.com")  # trừ 100k → 0
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 0

    # Gia hạn 3 tháng → phí = FEE × 3 = 300k; ví 0 → QR đúng 300k.
    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/renew",
        json={"months": 3},
        headers=bearer(sub["token"]),
    )
    assert rr.status_code == 402, rr.text
    order = rr.json()["detail"]["order"]
    assert order["kind"] == "renew" and order["amount_vnd"] == 3 * FEE

    client.post("/webhook/sepay", json=_webhook_body(order["note"], 3 * FEE, "ORD-RENEW-1"))
    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])).json()
    assert o["status"] == "paid" and str(o["member_id"]) == member_id
    assert wallet_of(client, sub["token"])["balance"] == 0
    m = next(m for m in _members(client, sub["token"], ws["id"]) if m["id"] == member_id)
    assert m["subscription_months"] == 3


# ── Phí 2 tầng: user default + override member ───────────────────────────────

def test_user_fee_and_member_override(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "TwoTier WS")
    sub = make_beta_sub(client, auth_header, username="twotier", balance=1_000_000)
    assign(client, auth_header, ws["id"], sub["id"])

    # Đặt phí mặc định RIÊNG của user (đại lý) = 200k → override global 100k.
    fr = client.put(
        f"/api/v1/wallet/admin/users/{sub['id']}/fee",
        json={"invite_fee_vnd": 200_000},
        headers=auth_header,
    )
    assert fr.status_code == 200 and fr.json()["invite_fee_vnd"] == 200_000

    r = _invite(client, sub["token"], ws["id"], "u1@example.com")
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 800_000  # trừ phí user 200k

    # Override phí RIÊNG member = 50k → thắng phí user.
    client.put(
        f"/api/v1/wallet/admin/members/{member_id}/fee",
        json={"fee_vnd": 50_000},
        headers=auth_header,
    )
    # Hết hạn thì mới có kỳ MỚI để tính phí: từ 26/8/2026 mời lại trong kỳ ĐANG chạy
    # là miễn phí ở mọi cửa vào (xem tests/test_reinvite_free_by_period.py).
    past = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    er = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/subscription",
        json={"subscription_end_at": past},
        headers=auth_header,
    )
    assert er.status_code == 200, er.text
    br = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": ["u1@example.com"], "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert br.status_code == 202, br.text
    assert wallet_of(client, sub["token"])["balance"] == 750_000  # 800k − 50k


# ── Đổi hạn (subscription) — phí theo số tháng, dùng chung ví/QR như gia hạn ──

def _patch_sub(client: TestClient, token: str, ws_id: str, member_id: str, body: dict):
    return client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json=body,
        headers=bearer(token),
    )


def test_subscription_extend_charges_fee_by_months(
    client: TestClient, auth_header: dict
) -> None:
    """Đổi hạn KÉO DÀI 2 tháng → phí = FEE/tháng × 2 (như gia hạn), trừ thẳng ví."""
    ws = create_ws(client, auth_header, "Sub Extend WS")
    sub = make_beta_sub(client, auth_header, username="subext", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "se@example.com")  # 1 tháng → −100k
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 200_000

    # months-only → cộng dồn (kéo dài) → phí = FEE × 2 = 200k → 200k − 200k = 0.
    rr = _patch_sub(client, sub["token"], ws["id"], member_id, {"subscription_months": 2})
    assert rr.status_code == 200, rr.text
    assert rr.json()["subscription_months"] == 2
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert "renew_fee" in _txn_kinds(client, sub["token"])


def test_subscription_qr_when_insufficient(client: TestClient, auth_header: dict) -> None:
    """Ví thiếu khi đổi hạn 3 tháng → QR (mã ORDER kind=subscription) đúng FEE×3;
    webhook nhận đủ → áp đổi hạn, net ví 0."""
    ws = create_ws(client, auth_header, "Sub QR WS")
    sub = make_beta_sub(client, auth_header, username="subqr", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "sq@example.com")  # −100k → 0
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 0

    rr = _patch_sub(client, sub["token"], ws["id"], member_id, {"subscription_months": 3})
    assert rr.status_code == 402, rr.text
    order = rr.json()["detail"]["order"]
    assert order["kind"] == "subscription" and order["amount_vnd"] == 3 * FEE

    client.post("/webhook/sepay", json=_webhook_body(order["note"], 3 * FEE, "ORD-SUB-1"))
    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])).json()
    assert o["status"] == "paid" and str(o["member_id"]) == member_id
    assert wallet_of(client, sub["token"])["balance"] == 0
    m = next(m for m in _members(client, sub["token"], ws["id"]) if m["id"] == member_id)
    assert m["subscription_months"] == 3


# ── Hết hạn 5 phút: mã QR chỉ tồn tại 5 phút (user 2026-07-13) ────────────────

def _backdate_order(order_id: str, minutes: int) -> None:
    """Lùi created_at của hoá đơn để giả lập quá hạn."""
    import uuid

    from app.db import SessionLocal
    from app.models import PaymentOrder

    with SessionLocal() as db:
        o = db.get(PaymentOrder, uuid.UUID(order_id))
        o.created_at = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        db.commit()


def test_poll_marks_order_expired_after_ttl(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Expire Poll WS")
    sub = make_beta_sub(client, auth_header, username="exppoll", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    order = _invite(client, sub["token"], ws["id"], "ep@example.com").json()["detail"]["order"]

    _backdate_order(order["id"], 11)  # quá 10 phút (TTL mới — user 2026-07-14)
    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])).json()
    assert o["status"] == "expired"


def test_expired_order_payment_credits_wallet_not_fulfilled(client: TestClient, auth_header: dict) -> None:
    """Chuyển khoản TRỄ (mã đã hết hạn) → tiền vào Ví (không mất), KHÔNG thực thi mã cũ."""
    ws = create_ws(client, auth_header, "Expire Pay WS")
    sub = make_beta_sub(client, auth_header, username="exppay", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    order = _invite(client, sub["token"], ws["id"], "xp@example.com").json()["detail"]["order"]

    _backdate_order(order["id"], 11)
    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-EXP-1"))
    assert wh.status_code == 200

    # Tiền vào ví (credit), KHÔNG trừ phí, KHÔNG tạo member.
    assert wallet_of(client, sub["token"])["balance"] == FEE
    assert "xp@example.com" not in [m["email"] for m in _members(client, sub["token"], ws["id"])]
    o = client.get(f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])).json()
    assert o["status"] == "expired"
    kinds = _txn_kinds(client, sub["token"])
    assert "order_topup" in kinds and "invite_fee" not in kinds
