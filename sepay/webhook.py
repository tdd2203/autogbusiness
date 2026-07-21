"""
sepay/webhook.py — Xử lý webhook SePay (phần lõi, framework-agnostic).

Luồng (rút gọn từ webhook/sepay.py gốc, bỏ Telegram/i18n/topup-order):
  1. Auth      — so header Authorization với SEPAY_APIKEY / SEPAY_SECRET_KEY
  2. Normalize — gom mọi format payload về dict chuẩn
  3. Filter    — bỏ giao dịch ra (outgoing) và IPN test của dashboard
  4. Idempotency — bỏ nếu txn đã xử lý
  5. Match     — tách {PREFIX}{id} khỏi nội dung CK
  6. Callback  — gọi on_paid(event) để bạn cộng tiền / giao hàng
  7. Mark      — ghi nhận đã xử lý (chỉ khi callback thành công)

`process_webhook` KHÔNG phụ thuộc web framework. Bên dưới có sẵn factory tạo
router FastAPI; muốn Flask/Django thì chỉ cần gọi process_webhook trong view.
"""

import logging
from dataclasses import dataclass, field
from typing import Callable

from .config import SepayConfig
from .payload import normalize_sepay_payload, build_idempotency_key, extract_prefixed_code
from .store import IdemStore

logger = logging.getLogger("sepay")


@dataclass
class SepayEvent:
    amount: float                 # số tiền nhận được (VND)
    content: str                  # nội dung CK thô
    code: str | None              # id tách được sau prefix (None nếu không khớp)
    provider_txn_id: str          # mã giao dịch SePay
    idempotency_key: str          # key chống trùng
    currency: str = "VND"
    raw: dict = field(default_factory=dict)      # payload gốc
    parsed: dict = field(default_factory=dict)   # payload đã normalize


# on_paid nhận SepayEvent, trả True nếu đã xử lý thành công (cộng tiền/giao hàng).
# Trả False → coi như "khớp nhưng không xử lý được" (không mark idempotency).
OnPaid = Callable[[SepayEvent], bool]


def process_webhook(
    *,
    headers: dict,
    body: dict,
    config: SepayConfig,
    store: IdemStore,
    on_paid: OnPaid,
    id_pattern: str = r"[0-9a-fA-F]{24}",
) -> dict:
    """
    Xử lý 1 webhook SePay. Trả về dict response (luôn HTTP 200 với SePay —
    trả 200 kèm note để SePay không spam retry, trừ khi auth fail thì tuỳ bạn).
    """
    # ── 1. Auth ──
    auth = headers.get("authorization", "") or headers.get("Authorization", "")
    if config.apikey or config.secret_key:
        ok = (
            (config.apikey and auth == f"Apikey {config.apikey}")
            or (config.secret_key and auth == f"Bearer {config.secret_key}")
            or (config.secret_key and auth == config.secret_key)
        )
        if not ok:
            logger.warning("[SePay] Auth fail")
            return {"success": False, "error": "Unauthorized"}

    # ── 2. Normalize ──
    parsed = normalize_sepay_payload(body)
    amount = parsed.get("amount", 0.0)
    content = parsed.get("content", "")

    # ── 3. Filter: test IPN & giao dịch ra ──
    if parsed.get("is_test"):
        return {"success": True, "note": "test ipn accepted"}
    if not parsed.get("is_incoming", True):
        return {"success": True, "note": "ignored - outgoing transfer"}
    if amount <= 0:
        return {"success": True, "note": "ignored - non-positive amount"}
    # PG IPN chưa SUCCESS thì bỏ
    if "order_invoice_number" in body and body.get("status") not in (None, "SUCCESS"):
        return {"success": True, "note": f"ignored pg status={body.get('status')}"}

    # ── 4. Idempotency ──
    idem = build_idempotency_key(body, parsed)
    if idem and store.seen(idem):
        logger.info(f"[SePay] Duplicate {idem}")
        return {"success": True, "note": "duplicate"}

    # ── 5. Match nội dung CK ──
    code = extract_prefixed_code(content, config.code_prefix, id_pattern=id_pattern)
    if not code:
        return {"success": True, "note": "no recognized code in content"}

    event = SepayEvent(
        amount=amount,
        content=content,
        code=code,
        provider_txn_id=parsed.get("provider_txn_id", ""),
        idempotency_key=idem or "",
        currency=parsed.get("currency", "VND"),
        raw=body,
        parsed=parsed,
    )

    # ── 6. Callback business logic ──
    try:
        ok = bool(on_paid(event))
    except Exception as exc:
        logger.error(f"[SePay] on_paid error: {exc}", exc_info=True)
        # Trả 200 để SePay retry sau (chưa mark idempotency).
        return {"success": True, "note": "handler error, will retry"}

    if not ok:
        return {"success": True, "note": "handler declined"}

    # ── 7. Mark đã xử lý (chỉ khi thành công) ──
    if idem:
        store.mark(idem)
    return {"success": True}


# ── FastAPI router (tuỳ chọn) ────────────────────────────────────────────────

def build_fastapi_router(config: SepayConfig, store: IdemStore, on_paid: OnPaid,
                         id_pattern: str = r"[0-9a-fA-F]{24}", path: str = "/webhook/sepay"):
    """
    Tạo APIRouter FastAPI cắm sẵn. Dùng:
        app.include_router(build_fastapi_router(cfg, store, my_on_paid))
    """
    from fastapi import APIRouter, Request

    router = APIRouter()

    @router.post(path)
    async def _sepay_webhook(request: Request):
        try:
            body = await request.json()
        except Exception:
            return {"success": False, "error": "Invalid JSON body"}
        return process_webhook(
            headers=dict(request.headers),
            body=body,
            config=config,
            store=store,
            on_paid=on_paid,
            id_pattern=id_pattern,
        )

    return router
