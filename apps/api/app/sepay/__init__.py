"""
sepay — Module thanh toán SePay standalone (bank-monitoring + VietQR).

Trích & tách coupling từ dự án gốc (MongoDB / Telegram / i18n / topup-order).
Chỉ còn phần lõi: sinh QR, chuẩn hoá webhook, chống trùng, khớp mã, callback.

Xem README.md và example_fastapi.py.
"""

from .config import SepayConfig
from .payload import (
    normalize_sepay_payload,
    build_idempotency_key,
    extract_prefixed_code,
    build_transfer_note,
)
from .qr import qr_png_bytes, qr_image_url, build_emv_qr_string, vietqr_bank_id
from .store import IdemStore, InMemoryStore, MongoStore
from .webhook import SepayEvent, process_webhook, build_fastapi_router

__all__ = [
    "SepayConfig",
    "normalize_sepay_payload", "build_idempotency_key",
    "extract_prefixed_code", "build_transfer_note",
    "qr_png_bytes", "qr_image_url", "build_emv_qr_string", "vietqr_bank_id",
    "IdemStore", "InMemoryStore", "MongoStore",
    "SepayEvent", "process_webhook", "build_fastapi_router",
]
