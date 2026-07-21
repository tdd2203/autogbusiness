"""
sepay/config.py — Cấu hình SePay (đọc từ env, không phụ thuộc DB).

SePay bank-monitoring hoạt động thế này:
  1. Bạn đăng ký tài khoản ngân hàng trong dashboard SePay.
  2. Bạn hiển thị QR (VietQR) gồm: bank + số TK + số tiền + NỘI DUNG chuyển khoản.
     Nội dung = {CODE_PREFIX}{id_đơn/nạp}  (vd "NAP" + "664f...").
  3. Khách chuyển tiền → SePay bắn webhook về endpoint của bạn.
  4. Bạn khớp nội dung CK về đúng đơn/lần nạp, cộng tiền/giao hàng.

Auth webhook: SePay gửi header `Authorization: Apikey <SEPAY_APIKEY>`.
"""

import os
from dataclasses import dataclass


@dataclass
class SepayConfig:
    # ── Auth webhook ──
    apikey: str = ""          # SEPAY_APIKEY — khớp header "Apikey <key>"
    secret_key: str = ""      # SEPAY_SECRET_KEY — cho Bearer auth + ký PG (tuỳ chọn)

    # ── Payment Gateway (chỉ cần nếu dùng mode checkout-URL, xem sepay_pg.py) ──
    merchant_id: str = ""     # SEPAY_MERCHANT_ID
    env: str = "production"   # SEPAY_ENV: sandbox | production

    # ── Thông tin ngân hàng in lên QR ──
    bank_name: str = ""       # vd "ACB", "Vietcombank", "MB Bank"
    account_number: str = ""
    account_name: str = ""

    # ── Sinh & khớp mã ──
    code_prefix: str = "NAP"  # tiền tố nội dung CK
    amount_tolerance: int = 1000  # sai số cho phép khi so số tiền (VND)

    @classmethod
    def from_env(cls) -> "SepayConfig":
        return cls(
            apikey=os.getenv("SEPAY_APIKEY", ""),
            secret_key=os.getenv("SEPAY_SECRET_KEY", ""),
            merchant_id=os.getenv("SEPAY_MERCHANT_ID", ""),
            env=os.getenv("SEPAY_ENV", "production"),
            bank_name=os.getenv("SEPAY_BANK_NAME", ""),
            account_number=os.getenv("SEPAY_ACCOUNT_NUMBER", ""),
            account_name=os.getenv("SEPAY_ACCOUNT_NAME", ""),
            code_prefix=os.getenv("SEPAY_CODE_PREFIX", "NAP"),
            amount_tolerance=int(os.getenv("SEPAY_AMOUNT_TOLERANCE", "1000")),
        )
