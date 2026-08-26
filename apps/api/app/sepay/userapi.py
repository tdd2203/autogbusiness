"""sepay/userapi.py — Kéo SAO KÊ ngân hàng từ API tài khoản SePay (my.sepay.vn).

KHÁC webhook: webhook là SePay đẩy sang mình lúc tiền về (mất là mất luôn, không phát
lại được). API này là mình chủ động HỎI — dùng để (1) dựng lại những ngày trước khi có
bảng `sepay_webhook_events`, (2) bắt khoản tiền ngân hàng đã nhận mà webhook không tới
/ bị từ chối.

    GET {base}/userapi/transactions/list
    Authorization: Bearer <API token>          (my.sepay.vn → Công ty → API Token)
    ?transaction_date_min=YYYY-MM-DD 00:00:00
    &transaction_date_max=YYYY-MM-DD 23:59:59
    &limit=…&account_number=…

Trả về `{"status":200, "transactions":[{id, transaction_date, amount_in, amount_out,
transaction_content, reference_number, account_number, bank_brand_name, …}]}`.

Đọc PHÒNG THỦ: SePay có đổi tên field / bọc thêm lớp thì cũng không được ném lỗi làm
sập trang đối soát — thiếu field nào thì để trống field đó.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

#: Trần số dòng xin mỗi lần gọi (SePay cho tối đa 5000).
MAX_LIMIT = 5000


def fetch_transactions(
    *,
    token: str,
    base: str = "https://my.sepay.vn",
    date_from: str,
    date_to: str,
    account_number: str = "",
    limit: int = MAX_LIMIT,
    timeout: float = 20.0,
) -> list[dict]:
    """Sao kê trong [date_from, date_to] (chuỗi `YYYY-MM-DD`, giờ VN theo SePay).

    Dùng `urllib` chứ không httpx: httpx chỉ nằm trong nhóm dev của pyproject, image
    production KHÔNG có — thêm import httpx vào đường chạy thật là sập API. Cùng cách
    services/telegram.py và services/email.py đang gọi HTTP ra ngoài.

    Ném `RuntimeError` kèm thông điệp tiếng Việt khi gọi hỏng — caller hiện thẳng cho
    super-admin thay vì nuốt lỗi rồi báo "0 giao dịch" (dễ tưởng nhầm là không có tiền).
    """
    params = {
        "transaction_date_min": f"{date_from} 00:00:00",
        "transaction_date_max": f"{date_to} 23:59:59",
        "limit": str(min(int(limit), MAX_LIMIT)),
    }
    if account_number:
        params["account_number"] = account_number
    url = f"{base.rstrip('/')}/userapi/transactions/list?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise RuntimeError(
                "API SePay từ chối token (401) — kiểm tra SEPAY_USER_API_TOKEN"
            ) from e
        detail = (e.read().decode("utf-8", "replace") if e.fp else "")[:200]
        raise RuntimeError(f"API SePay trả {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"không gọi được API SePay: {e.reason}") from e

    try:
        body = json.loads(raw or "null")
    except json.JSONDecodeError as e:
        raise RuntimeError("API SePay trả về không phải JSON") from e
    if not isinstance(body, dict):
        raise RuntimeError("API SePay trả về cấu trúc lạ")
    if str(body.get("status") or 200) not in ("200", "success"):
        raise RuntimeError(f"API SePay báo lỗi: {body.get('error') or body.get('messages')}")
    rows = body.get("transactions")
    if rows is None and isinstance(body.get("data"), dict):
        rows = body["data"].get("transactions")
    return [r for r in (rows or []) if isinstance(r, dict)]


def to_parsed(row: dict) -> dict:
    """Một dòng sao kê → dict "parsed" giống `normalize_sepay_payload` để ghi chung sổ.

    `amount_in` > 0 là tiền vào; `amount_out` > 0 là tiền ra (giữ lại để đối soát chứ
    không xử lý). Số tiền SePay trả dạng chuỗi ("100000.00") nên phải qua float.
    """

    def num(value) -> float:
        try:
            return float(str(value or 0).replace(",", ""))
        except ValueError:
            return 0.0

    amount_in = num(row.get("amount_in"))
    amount_out = num(row.get("amount_out"))
    incoming = amount_in > 0
    return {
        "format": "userapi",
        "amount": amount_in if incoming else amount_out,
        "transfer_type": "in" if incoming else "out",
        "is_incoming": incoming,
        "content": str(
            row.get("transaction_content") or row.get("code") or row.get("content") or ""
        ),
        "provider_txn_id": str(row.get("id") or row.get("reference_number") or ""),
        "account_number": str(row.get("account_number") or ""),
        "bank": str(row.get("bank_brand_name") or row.get("gateway") or ""),
        "currency": "VND",
    }
