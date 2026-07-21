"""Gửi email OTP đăng ký — ỦY THÁC cho dự án HostMail qua HTTP API.

Dự án này KHÔNG dựng SMTP. Việc gửi mail thật do HostMail (Mailcow/postfix) lo;
ở đây chỉ POST một yêu cầu gửi tới `POST {HOSTMAIL_API_BASE}{HOSTMAIL_SEND_PATH}`
với `Authorization: Bearer <HOSTMAIL_API_KEY>`.

Dev/test: nếu `HOSTMAIL_API_BASE` rỗng → GHI OTP RA LOG thay vì gọi API (cho phép
chạy end-to-end mà không cần HostMail thật). Tests monkeypatch `send_otp_email`.

Dùng urllib (thư viện chuẩn) — không thêm dependency runtime (httpx chỉ là dev-dep).
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from app.config import get_settings

logger = logging.getLogger(__name__)


class EmailSendError(RuntimeError):
    """HostMail từ chối/không gửi được — router dịch thành HTTP 502."""


def _render(code: str, ttl_minutes: int) -> tuple[str, str, str]:
    subject = "Mã xác thực đăng ký tài khoản"
    text = (
        f"Mã OTP đăng ký của bạn là: {code}\n"
        f"Mã có hiệu lực trong {ttl_minutes} phút.\n"
        f"Nếu bạn không yêu cầu đăng ký, hãy bỏ qua email này."
    )
    html = (
        f"<div style=\"font-family:system-ui,Arial,sans-serif;font-size:15px;color:#111\">"
        f"<p>Mã OTP đăng ký của bạn là:</p>"
        f"<p style=\"font-size:28px;font-weight:700;letter-spacing:4px;margin:12px 0\">{code}</p>"
        f"<p>Mã có hiệu lực trong <b>{ttl_minutes} phút</b>.</p>"
        f"<p style=\"color:#6b7280;font-size:13px\">Nếu bạn không yêu cầu đăng ký, hãy bỏ qua email này.</p>"
        f"</div>"
    )
    return subject, text, html


def send_otp_email(to: str, code: str) -> None:
    """Nhờ HostMail gửi email chứa mã OTP tới `to`. Raise EmailSendError nếu lỗi."""
    settings = get_settings()
    subject, text, html = _render(code, settings.otp_ttl_minutes)

    if not settings.hostmail_api_base:
        # Chế độ dev/test: không cấu hình HostMail → in OTP ra log để verify thủ công.
        logger.info(
            "[email] (DEV) OTP cho %s = %s (HOSTMAIL_API_BASE chưa cấu hình → KHÔNG gửi thật)",
            to,
            code,
        )
        return

    url = settings.hostmail_api_base.rstrip("/") + settings.hostmail_send_path
    body: dict[str, str] = {"to": to, "subject": subject, "text": text, "html": html}
    if settings.hostmail_from:
        body["from_email"] = settings.hostmail_from
    if settings.hostmail_from_name:
        body["from_name"] = settings.hostmail_from_name

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.hostmail_api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status // 100 != 2:
                raise EmailSendError(f"HostMail trả HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500] if e.fp else ""
        logger.warning("[email] HostMail HTTP %s khi gửi tới %s: %s", e.code, to, detail)
        raise EmailSendError(f"HostMail HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        logger.warning("[email] không kết nối được HostMail (%s) khi gửi tới %s", e.reason, to)
        raise EmailSendError(f"Không kết nối được HostMail: {e.reason}") from e
