"""Xác thực webhook HMAC-SHA256 (feature 003 bổ sung).

Khi phương thức xác thực = 'hmac', SePay ký body và gửi chữ ký ở header
X-Sepay-Signature; server verify bằng SEPAY_WEBHOOK_SECRET. Chữ ký đúng → cộng ví;
sai/thiếu → từ chối (không cộng).
"""

import hashlib
import hmac
import json

from fastapi.testclient import TestClient

from tests.wallet_helpers import bearer, make_beta_sub, set_settings, wallet_of

SECRET = "test-hmac-secret-do-not-use"  # khớp conftest SEPAY_WEBHOOK_SECRET
TS = "1783860000"  # X-SePay-Timestamp giả lập (unix seconds)


def _sign(raw: bytes, timestamp: str = TS) -> str:
    """Ký ĐÚNG cơ chế SePay: 'sha256=' + HMAC-SHA256(secret, '{timestamp}.{payload}')."""
    signed = f"{timestamp}.{raw.decode()}".encode()
    return "sha256=" + hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()


def _sig_headers(raw: bytes, timestamp: str = TS) -> dict:
    return {
        "Content-Type": "application/json",
        "X-SePay-Signature": _sign(raw, timestamp),
        "X-SePay-Timestamp": timestamp,
    }


def _raw(note: str, amount: int, txn_id: str) -> bytes:
    return json.dumps(
        {"transferType": "in", "transferAmount": amount, "content": note, "id": txn_id, "referenceCode": txn_id}
    ).encode()


def _switch_to_hmac(client: TestClient, auth_header: dict) -> None:
    r = client.put(
        "/api/v1/wallet/admin/settings",
        json={"bank_name": "ACB", "account_number": "1234567890", "account_name": "A", "sepay_auth_method": "hmac"},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert r.json()["sepay_auth_method"] == "hmac"
    assert r.json()["sepay_hmac_secret_configured"] is True
    assert r.json()["sepay_webhook_configured"] is True  # secret của method đang chọn đã có


def test_hmac_valid_signature_credits(client: TestClient, auth_header: dict) -> None:
    _switch_to_hmac(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="hmacok")
    topup = client.post("/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(sub["token"])).json()

    raw = _raw(topup["note"], 200_000, "HMAC-1")
    r = client.post("/webhook/sepay", content=raw, headers=_sig_headers(raw))
    assert r.status_code == 200, r.text
    assert r.json().get("success") is True
    assert wallet_of(client, sub["token"])["balance"] == 200_000


def test_hmac_tampered_timestamp_rejected(client: TestClient, auth_header: dict) -> None:
    """Chữ ký ký với timestamp khác timestamp gửi ở header → server tính lại lệch → từ chối.
    (Chứng minh timestamp nằm trong chuỗi ký {timestamp}.{payload}.)"""
    _switch_to_hmac(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="hmacts")
    topup = client.post("/api/v1/wallet/topups", json={"amount_vnd": 100_000}, headers=bearer(sub["token"])).json()
    raw = _raw(topup["note"], 100_000, "HMAC-TS")
    headers = {
        "Content-Type": "application/json",
        "X-SePay-Signature": _sign(raw, "1111111111"),  # ký với ts này
        "X-SePay-Timestamp": "9999999999",  # nhưng gửi ts khác
    }
    r = client.post("/webhook/sepay", content=raw, headers=headers)
    assert r.json().get("success") is False
    assert wallet_of(client, sub["token"])["balance"] == 0


def test_hmac_invalid_signature_rejected(client: TestClient, auth_header: dict) -> None:
    _switch_to_hmac(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="hmacbad")
    topup = client.post("/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(sub["token"])).json()
    raw = _raw(topup["note"], 200_000, "HMAC-BAD")
    r = client.post(
        "/webhook/sepay",
        content=raw,
        headers={"Content-Type": "application/json", "X-SePay-Signature": "sha256=deadbeef", "X-SePay-Timestamp": TS},
    )
    assert r.status_code == 200
    assert r.json().get("success") is False  # Unauthorized
    assert wallet_of(client, sub["token"])["balance"] == 0


def test_hmac_missing_signature_rejected(client: TestClient, auth_header: dict) -> None:
    _switch_to_hmac(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="hmacmissing")
    topup = client.post("/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(sub["token"])).json()
    raw = _raw(topup["note"], 200_000, "HMAC-NONE")
    r = client.post("/webhook/sepay", content=raw, headers={"Content-Type": "application/json"})
    assert r.json().get("success") is False
    assert wallet_of(client, sub["token"])["balance"] == 0


def test_auth_method_none_skips_verification(client: TestClient, auth_header: dict) -> None:
    """Phương thức 'Không xác thực' → webhook không cần chữ ký vẫn cộng ví."""
    r = set_settings(client, auth_header, sepay_auth_method="none")
    assert r["sepay_auth_method"] == "none"
    sub = make_beta_sub(client, auth_header, username="noneauth")
    topup = client.post("/api/v1/wallet/topups", json={"amount_vnd": 50_000}, headers=bearer(sub["token"])).json()
    raw = _raw(topup["note"], 50_000, "NONE-1")
    r = client.post("/webhook/sepay", content=raw, headers={"Content-Type": "application/json"})
    assert r.json().get("success") is True
    assert wallet_of(client, sub["token"])["balance"] == 50_000
