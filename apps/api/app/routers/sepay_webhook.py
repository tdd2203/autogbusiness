"""SePay webhook — nhận "tiền vào", định tuyến theo MÃ ĐA LUỒNG (NAP nạp / ORDER đơn).

Endpoint TOP-LEVEL `/webhook/sepay` (khớp cấu hình SePay dashboard). Auth
`Authorization: Apikey <SEPAY_APIKEY>` (env). Một session request cho toàn bộ
(store + credit), commit 1 lần. Xem app/sepay_integration.process_multiflow_webhook.
"""

import json
import logging

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.deps import get_session
from app.routers.wallet._shared import get_payment_settings
from app.sepay_integration import process_multiflow_webhook

logger = logging.getLogger("sepay_webhook")

router = APIRouter(tags=["sepay"])


@router.post("/webhook/sepay")
async def sepay_webhook(request: Request, db: Session = Depends(get_session)) -> dict:
    # Đọc BYTES gốc (cần cho HMAC-SHA256 khớp byte-for-byte) rồi mới parse JSON.
    raw_body = await request.body()
    try:
        body = json.loads(raw_body or b"null")
    except Exception:
        return {"success": False, "error": "Invalid JSON body"}
    if not isinstance(body, dict):
        return {"success": False, "error": "Invalid JSON body"}

    settings_row = get_payment_settings(db)
    result = process_multiflow_webhook(db, dict(request.headers), raw_body, body, settings_row)
    db.commit()
    return result
