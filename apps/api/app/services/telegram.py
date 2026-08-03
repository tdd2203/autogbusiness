"""Client Telegram Bot API — gọi HTTP trực tiếp, KHÔNG thêm dependency runtime.

Giống `services/email.py` (ủy thác HostMail qua urllib): dự án chỉ có `httpx` ở
dev-dependency nên module này dùng `urllib` chuẩn. Đồng bộ (blocking) — mọi nơi gọi
đều là job nền `threading.Timer` hoặc endpoint FastAPI khai báo `def` (chạy trong
threadpool), không chặn event loop.

⚠️ HAI RÀNG BUỘC CỦA TELEGRAM quyết định toàn bộ thiết kế tính năng:
  1. `sendMessage` **chỉ nhận chat_id dạng SỐ** (hoặc @username của KÊNH/GROUP công
     khai). KHÔNG gửi được cho một *người* qua @username → phải học chat_id từ /start
     (bảng `telegram_contacts`).
  2. Bot **không được nhắn trước** cho người chưa từng /start → lỗi 403
     "bot can't initiate conversation with a user". Đây là lỗi VĨNH VIỄN cho tới khi
     người đó mở bot, nên phân loại riêng để job nền thôi retry (xem `classify_error`).

Dùng `parse_mode=HTML` (không phải Markdown): email khách thường chứa dấu `_`
(`nguyen_van_a@gmail.com`) — Markdown sẽ hiểu là in nghiêng và Telegram trả 400.
Mọi giá trị động PHẢI đi qua `escape_html`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from app.config import get_settings

logger = logging.getLogger(__name__)

API_ROOT = "https://api.telegram.org"
# Telegram giới hạn 4096 ký tự/tin. Chừa biên cho phần đuôi (link + ghi chú).
MAX_MESSAGE_CHARS = 3800
_DEFAULT_TIMEOUT = 20


class TelegramError(RuntimeError):
    """Bot API trả về lỗi (ok=false) hoặc không gọi được.

    `code` là mã phân loại nội bộ (xem `classify_error`), KHÔNG phải HTTP status:
      - 'blocked'      : user chặn bot / tài khoản bị vô hiệu → thôi retry
      - 'not_started'  : người nhận chưa /start bot → thôi retry, chờ họ mở bot
      - 'chat_not_found': chat_id sai hoặc bot bị kick khỏi group → thôi retry
      - 'rate_limited' : 429 → retry sau
      - 'unauthorized' : token sai/bị thu hồi → cấu hình sai, thôi retry
      - 'network'/'unknown' : lỗi tạm → retry
    """

    def __init__(self, code: str, description: str, *, http_status: int | None = None):
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description
        self.http_status = http_status

    @property
    def permanent(self) -> bool:
        """True = thử lại cũng vô ích (job nền đánh dấu 'blocked' thay vì 'failed')."""
        return self.code in {"blocked", "not_started", "chat_not_found", "unauthorized"}


@dataclass(frozen=True)
class SentMessage:
    chat_id: int
    message_id: int


# ── Cấu hình lúc chạy: .env TRƯỚC, rồi tới bảng telegram_settings (nhập từ UI) ──


@dataclass
class RuntimeConfig:
    """Cấu hình bot đang HIỆU LỰC + nguồn của nó (để UI nói rõ đang lấy từ đâu)."""

    token: str = ""
    username: str = ""
    webhook_secret: str = ""
    admin_chat_ids: list[int] = field(default_factory=list)
    source: str = "none"  # 'env' | 'db' | 'none'
    # Giá trị TELEGRAM_BOT_TOKEN lúc nạp cache. Env đổi giữa chừng (đổi .env + reload,
    # hoặc test monkeypatch settings) ⇒ cache phải tự hỏng, xem `runtime_config`.
    env_token: str = ""


_config_cache: RuntimeConfig | None = None
_config_lock = threading.Lock()


def _fernet():
    """Khoá mã hoá suy từ JWT_SECRET — KHÔNG thêm biến môi trường mới (thêm biến ⇒
    lại phải SSH sửa .env, đúng thứ tính năng 'nhập token từ UI' muốn tránh)."""
    from cryptography.fernet import Fernet

    digest = hashlib.sha256(get_settings().jwt_secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(value: str) -> str:
    """Giải mã token. JWT_SECRET đã đổi ⇒ không giải được → trả rỗng (coi như chưa
    cấu hình) để super-admin nhập lại, thay vì làm sập cả API."""
    from cryptography.fernet import InvalidToken

    try:
        return _fernet().decrypt(value.encode()).decode()
    except (InvalidToken, ValueError) as exc:
        logger.warning("[telegram] không giải mã được token đã lưu (%s) — cần nhập lại", exc)
        return ""


def _parse_chat_ids(raw: str | None) -> list[int]:
    out: list[int] = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            continue
    return out


def _env_config(settings) -> RuntimeConfig:
    env_token = (settings.telegram_bot_token or "").strip()
    return RuntimeConfig(
        token=env_token,
        username=(settings.telegram_bot_username or "").strip().lstrip("@"),
        webhook_secret=(settings.telegram_webhook_secret or "").strip(),
        admin_chat_ids=settings.telegram_admin_chat_ids(),
        source="env",
        env_token=env_token,
    )


def _load_db_config() -> RuntimeConfig:
    """Đọc cấu hình super-admin đã nhập ở Dashboard. Import muộn để tránh vòng import
    (models → db → …) và để module này vẫn dùng được khi chưa có DB (test đơn vị)."""
    try:
        from app.db import SessionLocal
        from app.models import TelegramSettings

        with SessionLocal() as db:
            row = db.get(TelegramSettings, 1)
            if row and row.bot_token_encrypted:
                token = decrypt_secret(row.bot_token_encrypted)
                if token:
                    return RuntimeConfig(
                        token=token,
                        username=(row.bot_username or "").lstrip("@"),
                        webhook_secret=row.webhook_secret or "",
                        admin_chat_ids=_parse_chat_ids(row.admin_chat_id),
                        source="db",
                    )
    except Exception as exc:  # noqa: BLE001 — DB hỏng không được làm sập request
        logger.warning("[telegram] đọc cấu hình từ DB lỗi: %s", exc)
    return RuntimeConfig(source="none")


def runtime_config() -> RuntimeConfig:
    """Cấu hình đang hiệu lực.

    `.env` được ưu tiên và **KHÔNG cache** — đọc biến môi trường vốn rẻ, mà cache nó
    thì mọi thay đổi cấu hình giữa chừng (reload settings, test monkeypatch) đều đọc
    phải bản cũ. Chỉ nhánh DB mới cache (có truy vấn + giải mã); gọi `refresh_config()`
    sau khi super-admin lưu/xoá ở giao diện.
    """
    global _config_cache
    settings = get_settings()
    if (settings.telegram_bot_token or "").strip():
        return _env_config(settings)
    if _config_cache is None:
        with _config_lock:
            if _config_cache is None:
                _config_cache = _load_db_config()
    return _config_cache


def refresh_config() -> RuntimeConfig:
    """Xoá cache + nạp lại (gọi ngay sau khi super-admin lưu/xoá token)."""
    global _config_cache
    with _config_lock:
        _config_cache = None
    return runtime_config()


def generate_webhook_secret() -> str:
    """Secret ngẫu nhiên cho setWebhook — sinh giúp admin, khỏi phải tự nghĩ."""
    return secrets.token_urlsafe(32)


def bot_configured() -> bool:
    """False = chưa có token (env lẫn UI) → tính năng TẮT hoàn toàn."""
    return bool(runtime_config().token)


def webhook_secret() -> str:
    return runtime_config().webhook_secret


def admin_chat_ids() -> list[int]:
    return runtime_config().admin_chat_ids


def escape_html(value: object) -> str:
    """Thoát 3 ký tự Telegram HTML quan tâm. Bắt buộc cho MỌI dữ liệu động."""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def classify_error(description: str, http_status: int | None = None) -> str:
    """Xếp loại `description` của Bot API để quyết định có retry hay không."""
    text = (description or "").lower()
    if "bot was blocked by the user" in text or "user is deactivated" in text:
        return "blocked"
    if "bot can't initiate conversation" in text or "bot can't send messages to bots" in text:
        return "not_started"
    if "chat not found" in text or "chat_id is empty" in text or "bot was kicked" in text:
        return "chat_not_found"
    if "too many requests" in text or http_status == 429:
        return "rate_limited"
    if "unauthorized" in text or http_status == 401:
        return "unauthorized"
    if http_status is not None and 500 <= http_status < 600:
        return "server_error"
    return "unknown"


def call(
    method: str,
    payload: dict | None = None,
    *,
    timeout: int = _DEFAULT_TIMEOUT,
    token: str | None = None,
) -> dict:
    """Gọi 1 method Bot API, trả `result`. Raise `TelegramError` nếu không ok.

    `token` chỉ truyền khi cần kiểm tra một token CHƯA lưu (xác thực lúc admin nhập)."""
    token = (token or runtime_config().token).strip()
    if not token:
        raise TelegramError("not_configured", "Chưa cấu hình token bot Telegram")

    url = f"{API_ROOT}/bot{token}/{method}"
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        try:
            body = json.loads(raw or "{}")
        except json.JSONDecodeError:
            body = {}
        description = str(body.get("description") or raw or e.reason)[:500]
        raise TelegramError(
            classify_error(description, e.code), description, http_status=e.code
        ) from e
    except urllib.error.URLError as e:
        raise TelegramError("network", f"Không kết nối được Telegram: {e.reason}") from e
    except TimeoutError as e:  # urlopen timeout
        raise TelegramError("network", "Hết thời gian chờ Telegram") from e

    if not body.get("ok"):
        description = str(body.get("description") or "unknown error")[:500]
        raise TelegramError(classify_error(description), description)
    return body.get("result") or {}


def send_message(chat_id: int, html_text: str) -> SentMessage:
    """Gửi 1 tin (HTML). Raise `TelegramError` — nơi gọi tự quyết định retry."""
    result = call(
        "sendMessage",
        {
            "chat_id": chat_id,
            "text": html_text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
    )
    return SentMessage(chat_id=chat_id, message_id=int(result.get("message_id") or 0))


def get_me(token: str | None = None) -> dict:
    return call("getMe", token=token)


def verify_token(token: str) -> dict:
    """Kiểm tra token TRƯỚC KHI lưu (giống `master/services/telegram_api.verify_token`
    của Tele_Bot): token sai thì báo lỗi ngay tại form thay vì lưu rồi im lặng hỏng."""
    return get_me(token=token)


def bot_username() -> str:
    """@username của bot cho deep-link. Ưu tiên giá trị đã cấu hình (env/DB), nếu
    thiếu thì hỏi getMe rồi cache trong process (username bot gần như không đổi)."""
    configured = runtime_config().username
    if configured:
        return configured
    global _cached_username
    if _cached_username:
        return _cached_username
    _cached_username = str(get_me().get("username") or "")
    return _cached_username


_cached_username: str = ""


def set_webhook(url: str, secret: str) -> dict:
    """Đăng ký webhook. `allowed_updates=['message']` — tính năng chỉ cần lệnh chat."""
    payload: dict = {
        "url": url,
        "allowed_updates": ["message"],
        "drop_pending_updates": True,
    }
    if secret:
        payload["secret_token"] = secret
    return call("setWebhook", payload)


def delete_webhook() -> dict:
    return call("deleteWebhook", {"drop_pending_updates": False})


def get_webhook_info() -> dict:
    return call("getWebhookInfo")


def split_html_lines(header: str, lines: list[str], footer: str = "") -> list[str]:
    """Chia danh sách dòng thành nhiều tin nếu vượt `MAX_MESSAGE_CHARS`.

    Header lặp ở mỗi phần (kèm '(tiếp)') để người nhận không mất ngữ cảnh khi một
    đại lý có hàng trăm email đến hạn cùng ngày.
    """
    chunks: list[str] = []
    current: list[str] = []
    base_len = len(header) + len(footer) + 4

    def flush() -> None:
        if not current:
            return
        head = header if not chunks else f"{header} (tiếp)"
        parts = [head, "", *current]
        if footer:
            parts += ["", footer]
        chunks.append("\n".join(parts))
        current.clear()

    for line in lines:
        if current and base_len + sum(len(x) + 1 for x in current) + len(line) > MAX_MESSAGE_CHARS:
            flush()
        current.append(line)
    flush()
    return chunks
