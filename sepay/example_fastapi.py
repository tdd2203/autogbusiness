"""
example_fastapi.py — Ví dụ hoàn chỉnh: show QR → chờ webhook → confirm.

Chạy:  uvicorn example_fastapi:app --port 8000
"""

from fastapi import FastAPI
from fastapi.responses import Response

from sepay import (
    SepayConfig, InMemoryStore, SepayEvent,
    build_transfer_note, qr_png_bytes, qr_image_url, build_fastapi_router,
)

app = FastAPI()

# 1) Cấu hình (thực tế đọc từ env: SepayConfig.from_env())
cfg = SepayConfig(
    apikey="your_sepay_apikey",
    bank_name="ACB",
    account_number="1234567890",
    account_name="NGUYEN VAN A",
    code_prefix="NAP",
)

# 2) Kho idempotency. Production: MongoStore(db.sepay_idem) hoặc Redis.
store = InMemoryStore()

# Giả lập "DB đơn hàng" — thực tế là bảng orders/topup của bạn.
PENDING: dict[str, dict] = {}   # code -> {amount, status}


# 3) Tạo đơn + trả QR ────────────────────────────────────────────────────────
@app.post("/pay/create")
def create_payment(order_id: str, amount: int):
    """Sinh nội dung CK + QR cho FE hiển thị."""
    note = build_transfer_note(cfg.code_prefix, order_id)   # "NAP<order_id>"
    PENDING[order_id] = {"amount": amount, "status": "pending"}
    return {
        "note": note,
        "amount": amount,
        "bank": cfg.bank_name,
        "account_number": cfg.account_number,
        "account_name": cfg.account_name,
        # FE chỉ cần nhét vào <img src>:
        "qr_url": qr_image_url(cfg.bank_name, cfg.account_number, cfg.account_name, amount, note),
    }


@app.get("/pay/qr.png")
def qr_png(order_id: str, amount: int):
    """QR render local (nếu bank có trong BIN map)."""
    note = build_transfer_note(cfg.code_prefix, order_id)
    return Response(qr_png_bytes(cfg.bank_name, cfg.account_number, amount, note),
                    media_type="image/png")


@app.get("/pay/status")
def status(order_id: str):
    """FE poll cái này để biết đã trả tiền chưa."""
    return {"status": PENDING.get(order_id, {}).get("status", "unknown")}


# 4) Callback khi SePay báo có tiền vào ───────────────────────────────────────
def on_paid(event: SepayEvent) -> bool:
    order = PENDING.get(event.code)
    if not order:
        return False   # không có đơn khớp
    # Kiểm tra số tiền (sai số cho phép)
    if abs(event.amount - order["amount"]) > cfg.amount_tolerance:
        return False
    if order["status"] == "paid":
        return True    # đã xử lý rồi (idempotency cũng đã chặn ở tầng trên)

    # >>> Business logic của bạn: cộng số dư / giao hàng / cập nhật đơn <<<
    order["status"] = "paid"
    print(f"[PAID] order={event.code} amount={event.amount} txn={event.provider_txn_id}")
    return True


# 5) Cắm router webhook  → SePay POST tới /webhook/sepay
app.include_router(build_fastapi_router(cfg, store, on_paid))
