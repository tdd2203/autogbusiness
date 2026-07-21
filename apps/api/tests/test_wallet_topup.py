"""US1 — Nạp tiền vào Ví qua SePay: tạo lệnh nạp, webhook cộng tiền, idempotent.

Phủ SC-002 (webhook lặp không cộng đúp) và FR-013 (tiền vào không khớp → không cộng).
"""

from fastapi.testclient import TestClient

from tests.wallet_helpers import bearer, make_beta_sub, set_settings, wallet_of


def _webhook_body(note: str, amount: int, txn_id: str) -> dict:
    """Payload SePay bank-monitoring v2 (transferType=in)."""
    return {
        "transferType": "in",
        "transferAmount": amount,
        "content": note,
        "id": txn_id,
        "referenceCode": txn_id,
    }


def test_create_topup_returns_qr_and_note(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="napper")

    r = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(sub["token"])
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["amount_vnd"] == 200_000
    assert body["status"] == "pending"
    # Nội dung CK = tiền tố + MÃ NẠP CỐ ĐỊNH của user (KHÔNG phải ref_code per-order).
    assert body["note"].startswith("NAP")
    assert body["qr_url"] and "vietqr.app" in body["qr_url"] and "template=qronly" in body["qr_url"]
    assert body["bank_name"] == "ACB"

    # Mã nạp CỐ ĐỊNH theo user (user 2026-07-14): tạo lệnh khác vẫn ra CÙNG nội dung CK.
    body2 = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 500_000}, headers=bearer(sub["token"])
    ).json()
    assert body2["note"] == body["note"]


def test_topup_requires_bank_configured(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="nobank")
    # Chưa cấu hình ngân hàng → 409 BANK_NOT_CONFIGURED
    r = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 50_000}, headers=bearer(sub["token"])
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "BANK_NOT_CONFIGURED"


def test_webhook_credits_balance_and_marks_paid(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="creditme")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(sub["token"])
    ).json()

    wh = client.post("/webhook/sepay", json=_webhook_body(topup["note"], 200_000, "SP-CREDIT-1"))
    assert wh.status_code == 200, wh.text
    assert wh.json().get("success") is True

    # Số dư tăng đúng, lệnh nạp = paid, có giao dịch topup.
    assert wallet_of(client, sub["token"])["balance"] == 200_000
    status = client.get(
        f"/api/v1/wallet/topups/{topup['id']}", headers=bearer(sub["token"])
    ).json()
    assert status["status"] == "paid"
    assert status["paid_amount_vnd"] == 200_000

    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    topup_txns = [t for t in txns if t["kind"] == "topup"]
    assert len(topup_txns) == 1
    assert topup_txns[0]["amount"] == 200_000


def test_webhook_is_idempotent(client: TestClient, auth_header: dict) -> None:
    """SC-002 — gửi lại cùng giao dịch (trùng txn id) KHÔNG cộng lần 2."""
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="dedupe")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 150_000}, headers=bearer(sub["token"])
    ).json()

    body = _webhook_body(topup["note"], 150_000, "SP-DUP-1")
    first = client.post("/webhook/sepay", json=body)
    assert first.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 150_000

    # Lần 2 (cùng txn id) → duplicate, số dư không đổi.
    second = client.post("/webhook/sepay", json=body)
    assert second.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 150_000
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(sub["token"])).json()["items"]
    assert len([t for t in txns if t["kind"] == "topup"]) == 1


def test_webhook_no_matching_order_does_not_credit(client: TestClient, auth_header: dict) -> None:
    """FR-013 — nội dung CK không khớp lệnh nạp nào → không cộng ví."""
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="stranger")
    # Mã không tồn tại (24 hex bất kỳ)
    wh = client.post(
        "/webhook/sepay",
        json=_webhook_body("NAP" + "a" * 24, 500_000, "SP-NOMATCH-1"),
    )
    assert wh.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 0


def test_multiflow_order_unknown_code_declined(client: TestClient, auth_header: dict) -> None:
    """Mã đa luồng: luồng ORDER giờ CÓ consumer (feature 003) — mã ORDER<code> KHÔNG
    khớp hoá đơn nào → declined, KHÔNG cộng ví; luồng NAP vẫn cộng ví."""
    codes = [
        {"key": "topup", "label": "Nạp tiền", "prefix": "NAP", "suffix_min": 3, "suffix_max": 30, "enabled": True},
        {"key": "order", "label": "Đơn hàng", "prefix": "ORDER", "suffix_min": 6, "suffix_max": 30, "enabled": True},
    ]
    r = client.put(
        "/api/v1/wallet/admin/settings",
        json={"bank_name": "ACB", "account_number": "1234567890", "account_name": "A", "payment_codes": codes},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert [c["key"] for c in r.json()["payment_codes"]] == ["topup", "order"]
    assert r.json()["webhook_url"].endswith("/webhook/sepay")

    sub = make_beta_sub(client, auth_header, username="orderer")
    # Mã ORDER không khớp hoá đơn nào → handle_order trả False → declined, không cộng.
    wh = client.post("/webhook/sepay", json=_webhook_body("ORDER1234567", 200_000, "SP-ORDER-1"))
    assert wh.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 0

    # NAP vẫn cộng ví bình thường (ưu tiên luồng topup).
    topup = client.post("/api/v1/wallet/topups", json={"amount_vnd": 100_000}, headers=bearer(sub["token"])).json()
    client.post("/webhook/sepay", json=_webhook_body(topup["note"], 100_000, "SP-NAP-AFTER-ORDER"))
    assert wallet_of(client, sub["token"])["balance"] == 100_000


def test_numeric_suffix_type_only_matches_digits(client: TestClient, auth_header: dict) -> None:
    """Kiểu hậu tố 'Số nguyên' chỉ khớp chữ số; có chữ cái → không nhận diện."""
    codes = [
        {"key": "topup", "label": "Nạp", "prefix": "NAP", "suffix_min": 3, "suffix_max": 30, "suffix_type": "alphanumeric", "enabled": True},
        {"key": "paynum", "label": "Số", "prefix": "PAY", "suffix_min": 3, "suffix_max": 30, "suffix_type": "numeric", "enabled": True},
    ]
    r = client.put(
        "/api/v1/wallet/admin/settings",
        json={"bank_name": "ACB", "account_number": "1", "account_name": "A", "payment_codes": codes},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text

    # PAY + chữ → numeric KHÔNG khớp → không nhận diện.
    wh = client.post("/webhook/sepay", json=_webhook_body("PAYabc123", 50_000, "NUM-1"))
    assert "no recognized code" in (wh.json().get("note") or ""), wh.json()
    # PAY + toàn số → khớp (recognized-not-handled).
    wh2 = client.post("/webhook/sepay", json=_webhook_body("PAY123456", 50_000, "NUM-2"))
    assert "not handled" in (wh2.json().get("note") or ""), wh2.json()


def test_webhook_topup_credits_actual_amount_on_fixed_code(
    client: TestClient, auth_header: dict
) -> None:
    """Mã NẠP cố định theo user (user 2026-07-14): khớp ĐÚNG MÃ USER → cộng ĐÚNG SỐ
    TIỀN NHẬN ĐƯỢC, bất kể số tiền gợi ý trên lệnh nạp. (Khác luồng ORDER mời/gia hạn
    vẫn từ chối khi lệch tiền — xem handle_order.)"""
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="anyamount")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(sub["token"])
    ).json()
    # Chuyển 100k dù lệnh gợi ý 200k → vẫn cộng ĐÚNG 100k (không còn "đối soát" cho nạp).
    wh = client.post("/webhook/sepay", json=_webhook_body(topup["note"], 100_000, "SP-MM-1"))
    assert wh.status_code == 200
    assert wh.json().get("success") is True
    assert wallet_of(client, sub["token"])["balance"] == 100_000
    # Lệnh nạp pending gần số tiền nhất được đánh dấu 'paid' để modal phản hồi.
    status = client.get(
        f"/api/v1/wallet/topups/{topup['id']}", headers=bearer(sub["token"])
    ).json()
    assert status["status"] == "paid"
    assert status["paid_amount_vnd"] == 100_000


def test_webhook_topup_credits_without_pending_order(
    client: TestClient, auth_header: dict
) -> None:
    """QR nạp cố định có thể LƯU LẠI: tiền về đúng mã user vẫn cộng dù KHÔNG có lệnh
    nạp pending nào (user quét QR đã lưu, không mở modal tạo lệnh)."""
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="savedqr")
    # Tạo 1 lệnh để BE sinh mã cố định + lấy note, rồi để nó hết pending bằng cách
    # thanh toán; lần nạp thứ 2 dùng LẠI note đó KHÔNG tạo lệnh mới.
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 100_000}, headers=bearer(sub["token"])
    ).json()
    client.post("/webhook/sepay", json=_webhook_body(topup["note"], 100_000, "SV-1"))
    assert wallet_of(client, sub["token"])["balance"] == 100_000
    # Nạp lại bằng CÙNG mã cố định (note không đổi), không có lệnh pending nào.
    wh = client.post("/webhook/sepay", json=_webhook_body(topup["note"], 70_000, "SV-2"))
    assert wh.status_code == 200
    assert wh.json().get("success") is True
    assert wallet_of(client, sub["token"])["balance"] == 170_000
