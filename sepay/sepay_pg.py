"""
sepay/sepay_pg.py — (TUỲ CHỌN) SePay Payment Gateway: build checkout URL đã ký.

Đây là mode KHÁC với bank-monitoring: thay vì tự show VietQR + chờ webhook, bạn
đẩy khách sang trang checkout của SePay bằng 1 URL GET đã ký HMAC-SHA256.
Chỉ dùng nếu bạn đăng ký gói Payment Gateway. Đa số dùng bank-monitoring là đủ.
"""

import base64
import hashlib
import hmac
from urllib.parse import urlencode, quote

from .config import SepayConfig

# Các field được ký — đúng thứ tự SePay yêu cầu.
_SIGNED_FIELDS = [
    "merchant", "env", "operation", "payment_method", "order_amount", "currency",
    "order_invoice_number", "order_description", "customer_id", "agreement_id",
    "agreement_name", "agreement_type", "agreement_payment_frequency",
    "agreement_amount_per_payment", "success_url", "error_url", "cancel_url", "order_id",
]


def _base_url(config: SepayConfig) -> str:
    return ("https://pay.sepay.vn/v1/checkout" if config.env == "production"
            else "https://pay-sandbox.sepay.vn/v1/checkout")


def _sign(config: SepayConfig, fields: dict) -> str:
    raw = ",".join(f"{k}={fields[k]}" for k in _SIGNED_FIELDS if fields.get(k) is not None)
    mac = hmac.new(config.secret_key.encode(), raw.encode(), hashlib.sha256)
    return base64.b64encode(mac.digest()).decode()


def build_checkout_url(config: SepayConfig, order_invoice_number: str, amount: int, description: str = "") -> str:
    """Checkout URL dạng GET, mọi param đã ký. Redirect khách tới đây."""
    fields = {
        "merchant": config.merchant_id,
        "env": config.env,
        "operation": "PURCHASE",
        "payment_method": "BANK_TRANSFER",
        "order_amount": amount,
        "currency": "VND",
        "order_invoice_number": order_invoice_number,
        "order_description": description,
    }
    fields["signature"] = _sign(config, fields)
    return f"{_base_url(config)}/init?{urlencode(fields)}"


def build_qr_image_url(checkout_url: str, size: int = 300) -> str:
    """QR PNG bọc checkout_url (qrserver.com)."""
    return f"https://api.qrserver.com/v1/create-qr-code/?size={size}x{size}&data={quote(checkout_url)}"
