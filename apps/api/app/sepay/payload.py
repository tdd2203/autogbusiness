"""
sepay/payload.py — Chuẩn hoá payload webhook SePay + sinh idempotency key.

SePay có nhiều format payload (bank v1/v2, Payment Gateway IPN). Hàm
`normalize_sepay_payload` gom hết về 1 dict chuẩn:
    {format, amount, content, provider_txn_id, currency, is_incoming, ...}

`extract_prefixed_code` tách id ra khỏi nội dung CK theo tiền tố (NAP664f... → 664f...).
`build_idempotency_key` sinh key chống cộng tiền đúp — ưu tiên txn id của SePay.
"""

import hashlib
import re


def normalize_sepay_payload(raw: dict) -> dict:
    """Trích các trường ổn định từ payload SePay thô (mọi format)."""
    p: dict = {}

    if isinstance(raw.get("order"), dict) or isinstance(raw.get("transaction"), dict):
        # SePay Payment Gateway IPN — dạng lồng (order/transaction)
        order = raw.get("order") or {}
        transaction = raw.get("transaction") or {}
        notification_type = str(raw.get("notification_type") or "")
        order_status = str(order.get("order_status") or "")
        transaction_status = str(transaction.get("transaction_status") or "")

        p["format"] = "sepay_pg_ipn"
        p["amount"] = float(order.get("order_amount") or transaction.get("transaction_amount") or 0)
        p["content"] = (order.get("order_invoice_number") or order.get("order_id")
                        or order.get("order_description") or "")
        p["provider_txn_id"] = str(transaction.get("transaction_id") or transaction.get("id")
                                   or order.get("id") or "")
        p["reference_number"] = str(order.get("order_id") or "")
        p["status"] = transaction_status or order_status or notification_type
        p["currency"] = (transaction.get("transaction_currency") or order.get("order_currency") or "VND")
        p["is_test"] = bool((order.get("custom_data") or {}).get("webhook_test"))
        p["is_incoming"] = (notification_type == "PAYMENT_SUCCESS"
                            or order_status == "CAPTURED" or transaction_status == "APPROVED")

    elif "order_invoice_number" in raw:
        # SePay Payment Gateway IPN — dạng phẳng
        p["format"] = "sepay_pg_ipn"
        p["amount"] = float(raw.get("order_amount", 0) or 0)
        p["content"] = raw.get("order_invoice_number", "")
        p["provider_txn_id"] = str(raw.get("transaction_id", "") or "")
        p["status"] = raw.get("status", "")
        p["currency"] = raw.get("currency", "VND")
        p["is_incoming"] = p["status"] == "SUCCESS"

    elif "transferType" in raw:
        # SePay bank monitoring v2  ← format phổ biến nhất hiện nay
        p["format"] = "sepay_bank_v2"
        p["amount"] = float(raw.get("transferAmount", 0) or 0)
        p["transfer_type"] = raw.get("transferType", "")
        p["is_incoming"] = raw.get("transferType") == "in"
        p["content"] = (raw.get("code") or raw.get("transactionContent") or raw.get("content") or "")
        p["provider_txn_id"] = str(raw.get("id", "") or raw.get("referenceCode", "") or "")
        p["account_number"] = raw.get("toAccountNumber", raw.get("accountNumber", ""))
        p["bank"] = raw.get("gateway", raw.get("bankBrandName", ""))
        p["currency"] = "VND"

    else:
        # SePay bank monitoring v1 (amountIn)
        p["format"] = "sepay_bank_v1"
        p["amount"] = float(raw.get("amountIn", 0) or 0)
        p["is_incoming"] = p["amount"] > 0
        p["content"] = (raw.get("code") or raw.get("transactionContent") or raw.get("content") or "")
        p["provider_txn_id"] = str(raw.get("id", "") or "")
        p["account_number"] = raw.get("toAccountNumber", raw.get("accountNumber", ""))
        p["bank"] = raw.get("gateway", raw.get("bankBrandName", ""))
        p["currency"] = "VND"

    return p


def build_idempotency_key(raw: dict, parsed: dict) -> str | None:
    """Key chống trùng. Ưu tiên txn id của SePay; fallback hash(amount+content)."""
    txn_id = (parsed.get("provider_txn_id")
              or str(raw.get("id", "") or "")
              or str(raw.get("transaction_id", "") or ""))
    if txn_id:
        return f"sepay:{txn_id}"

    content = parsed.get("content", "")
    amount = parsed.get("amount", 0)
    if content and amount:
        return "sha:" + hashlib.sha256(f"sepay:{amount}:{content}".encode()).hexdigest()[:24]
    return None


_PREFIX_RE = re.compile(r"^[A-Za-z]{2,6}$")


def extract_prefixed_code(content: str, prefix: str, *, id_pattern: str = r"[0-9a-fA-F]{24}") -> str | None:
    """
    Tách id ra khỏi nội dung CK theo tiền tố.
      extract_prefixed_code("Chuyen tien NAP664f0a...", "NAP") -> "664f0a..."

    id_pattern mặc định = 24 hex (Mongo ObjectId). Đổi thành r"\\d+" nếu id là số
    tự tăng, hoặc r"[A-Za-z0-9]+" cho id tuỳ ý.
    """
    clean = str(prefix or "").strip().upper()
    if not _PREFIX_RE.fullmatch(clean):
        return None
    m = re.search(rf"{re.escape(clean)}({id_pattern})", str(content or ""), re.IGNORECASE)
    return m.group(1) if m else None


def build_transfer_note(prefix: str, ref_id: str) -> str:
    """Nội dung CK để in lên QR: {PREFIX}{id}. Đây là thứ webhook sẽ khớp lại."""
    return f"{str(prefix or '').strip().upper()}{ref_id}"
