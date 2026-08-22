"""Chống DDoS / rate-limit ở tầng ứng dụng (xem `ratelimit.md`).

Đây là tầng THỨ HAI trong ba tầng phòng thủ:

  1. Cloudflare (WAF + Rate limiting rules) — chặn trước khi vào tunnel.
  2. nginx `apps/web/nginx.conf` — `limit_req`/`limit_conn` theo IP thật, chặn
     flood thô mà không đánh thức Python.
  3. Module này — giới hạn CHÍNH XÁC theo nhóm endpoint + trần request đồng thời,
     vì chỉ ở đây mới biết đâu là `/auth/login` (đắt: bcrypt) và đâu là poll rẻ.

Vì sao tự viết thay vì dùng slowapi/redis:

  * API chạy **một** worker uvicorn (xem `apps/api/Dockerfile`), nên bộ đếm
    trong-process là chính xác tuyệt đối — không cần Redis (thêm một service
    nữa trên VPS 2GB là đắt hơn giá trị nó mang lại).
  * Bộ nhớ có TRẦN cứng (`rate_limit_max_keys` + LRU). Rất quan trọng: một
    limiter lưu dict theo IP mà không giới hạn sẽ TỰ BIẾN THÀNH lỗ hổng DoS
    bộ nhớ khi bị flood từ hàng vạn IP giả.

Thuật toán: token bucket. `rate` = số request/giây được nạp lại, `capacity` =
số request được phép dồn cục (burst). Cho phép client đang rảnh dồn một nhịp
ngắn (dashboard load trang gọi ~10 API cùng lúc) nhưng chặn dòng chảy liên tục.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Phân loại đường dẫn
# ---------------------------------------------------------------------------
# Endpoint ĐẮT + nhạy cảm: mỗi lần gọi là một lần băm bcrypt (~100ms CPU) hoặc
# một lần gửi mail OTP. Vài chục request/giây vào đây là đủ ghim CPU VPS →
# phải siết riêng, chặt hơn nhiều so với API thường.
AUTH_PATHS: frozenset[str] = frozenset(
    {
        "/api/v1/auth/login",
        "/api/v1/auth/register",
        "/api/v1/auth/verify-otp",
        "/api/v1/auth/resend-otp",
        "/api/v1/auth/change-password",
    }
)

# Webhook công khai (SePay, Telegram): không có JWT, ai cũng POST được. Chữ ký
# HMAC/secret đã chặn giả mạo, nhưng KHÔNG chặn được flood — mỗi request vẫn
# tốn một lần verify + một truy vấn DB.
WEBHOOK_PREFIX = "/webhook/"

# SSE giữ kết nối MỞ vô hạn → không tính vào trần request đồng thời (nếu tính,
# vài chục extension online là chiếm hết slot của traffic thường), mà có trần
# riêng. Xem thêm `routers/queue/extension_poll.py`.
STREAM_PATHS: frozenset[str] = frozenset({"/api/v1/queue/stream"})

# Miễn trừ hoàn toàn: healthcheck của Docker/uptime-monitor gọi liên tục và
# phải KHÔNG BAO GIỜ bị chặn, nếu không container tự bị đánh dấu unhealthy.
EXEMPT_PATHS: frozenset[str] = frozenset({"/health", "/docs", "/openapi.json"})


@dataclass(frozen=True)
class Rule:
    """Một luật token bucket: `per_min` request/phút, dồn tối đa `burst` cái."""

    per_min: int
    burst: int

    @property
    def rate(self) -> float:
        return self.per_min / 60.0


def _rule(per_min: int, divisor: int, floor: int) -> Rule:
    """Suy ra burst từ hạn mức phút: burst = 1/`divisor` hạn mức (tối thiểu `floor`)."""
    return Rule(per_min=max(1, per_min), burst=max(floor, max(1, per_min) // divisor))


class _Buckets:
    """Kho token bucket có TRẦN bộ nhớ (LRU) — xem giải thích đầu file."""

    def __init__(self, max_keys: int) -> None:
        self._max_keys = max(64, max_keys)
        # key -> [tokens, thời điểm cập nhật cuối (monotonic)]
        self._data: OrderedDict[str, list[float]] = OrderedDict()
        self._last_sweep = time.monotonic()

    def hit(self, key: str, rule: Rule, now: float) -> float:
        """Tiêu 1 token. Trả 0.0 = cho qua; >0 = số giây phải chờ (bị chặn)."""
        entry = self._data.get(key)
        if entry is None:
            entry = [float(rule.burst), now]
            self._data[key] = entry
        else:
            elapsed = now - entry[1]
            if elapsed > 0:
                entry[0] = min(float(rule.burst), entry[0] + elapsed * rule.rate)
                entry[1] = now
            self._data.move_to_end(key)

        if entry[0] >= 1.0:
            entry[0] -= 1.0
            self._evict(now)
            return 0.0

        self._evict(now)
        return max(0.001, (1.0 - entry[0]) / rule.rate)

    def _evict(self, now: float) -> None:
        # Quét định kỳ: bucket đã đầy lại và im lặng lâu thì xoá cho nhẹ RAM.
        if now - self._last_sweep >= 60.0:
            self._last_sweep = now
            stale = [k for k, v in self._data.items() if now - v[1] > 300.0]
            for k in stale:
                self._data.pop(k, None)
        # Trần cứng: flood từ hàng vạn IP giả không được phép làm phình RAM.
        while len(self._data) > self._max_keys:
            self._data.popitem(last=False)

    def __len__(self) -> int:  # dùng trong test
        return len(self._data)


@dataclass(frozen=True)
class Rejection:
    """Quyết định từ chối một request."""

    status: int
    code: str
    message: str
    retry_after: int


def _header(scope: Scope, name: bytes) -> str | None:
    for k, v in scope.get("headers") or ():
        if k == name:
            return v.decode("latin-1")
    return None


def client_ip(scope: Scope) -> str:
    """IP thật của client, theo thứ tự tin cậy GIẢM DẦN.

    1. `CF-Connecting-IP` — Cloudflare LUÔN ghi đè header này ở biên, client
       không đặt xuyên qua được. Đặt đầu tiên để phòng trường hợp tunnel được
       cấu hình trỏ THẲNG vào api:8000 (bỏ qua nginx): khi đó `X-Client-IP`
       không do ai ghi đè nữa và sẽ giả mạo được nếu ta tin nó trước.
    2. `X-Client-IP` — do nginx của stack này đặt (`proxy_set_header` ghi đè giá
       trị client gửi lên). Dùng khi truy cập không qua Cloudflare.
    3. `scope["client"]` — gọi thẳng (extension → localhost:18000 lúc dev).

    KHÔNG dùng `X-Forwarded-For`: nginx NỐI THÊM vào chuỗi client tự khai, nên
    kẻ tấn công chỉ cần đặt sẵn một IP rác ở đầu chuỗi là thoát rate-limit.
    """
    for name in (b"cf-connecting-ip", b"x-client-ip"):
        value = _header(scope, name)
        if value:
            return value.split(",")[0].strip()
    client = scope.get("client")
    return client[0] if client else "unknown"


def _identity(scope: Scope, ip: str) -> str:
    """Khoá "danh tính" — mịn hơn IP.

    Nhiều extension chạy trên CÙNG một máy/IP (profile MoreLogin, văn phòng dùng
    chung NAT) là chuyện bình thường ở dự án này. Nếu chỉ đếm theo IP thì mười
    extension hợp lệ sẽ tự đá nhau. Nên: có `X-API-KEY`/Bearer thì đếm theo băm
    của nó; không có thì mới rơi về IP.

    Chỉ BĂM, không giải mã/xác thực — middleware chạy trước router, không được
    phép tốn CPU. Token giả vẫn tạo được khoá riêng, nhưng trần theo IP
    (`per_ip`) vẫn phủ lên trên nên xoay token không thoát được giới hạn.
    """
    for name in (b"x-api-key", b"authorization"):
        value = _header(scope, name)
        if value:
            digest = hashlib.sha256(value.encode("utf-8", "ignore")).hexdigest()[:16]
            return f"c:{digest}"
    return f"i:{ip}"


class RateLimiter:
    """Bộ đếm dùng chung cho middleware (tách riêng để test không cần dựng app)."""

    def __init__(self, settings: Settings) -> None:
        self.enabled = settings.rate_limit_enabled
        self.per_ip = _rule(settings.rate_limit_per_ip_per_min, 6, 20)
        self.per_client = _rule(settings.rate_limit_per_client_per_min, 6, 20)
        self.auth = _rule(settings.rate_limit_auth_per_min, 2, 5)
        self.webhook = _rule(settings.rate_limit_webhook_per_min, 4, 10)
        self.max_inflight = settings.rate_limit_max_inflight
        self.max_streams = settings.rate_limit_max_streams
        self.max_body_bytes = settings.rate_limit_max_body_bytes
        self.trusted_ips = settings.rate_limit_trusted_ip_set()

        self._buckets = _Buckets(settings.rate_limit_max_keys)
        self._lock = threading.Lock()
        self._inflight = 0
        self._streams = 0
        # Thống kê để log GỘP — tuyệt đối không log/ghi audit từng request bị
        # chặn, vì đúng lúc bị flood thì chính việc ghi log lại là khuếch đại tải.
        self._blocked = 0
        self._blocked_since = time.monotonic()

    # -- kiểm tra hạn mức ---------------------------------------------------
    def check(self, scope: Scope) -> Rejection | None:
        """Trả `None` = cho qua, hoặc `Rejection` để middleware trả lỗi ngay."""
        if not self.enabled:
            return None
        path = scope.get("path", "")
        if path in EXEMPT_PATHS:
            return None
        # Preflight CORS không mang dữ liệu và bị trình duyệt tự phát sinh —
        # chặn nó chỉ làm hỏng app chứ không cản được kẻ tấn công.
        if scope.get("method") == "OPTIONS":
            return None

        ip = client_ip(scope)
        if ip in self.trusted_ips:
            return None

        # Chặn body quá khổ TRƯỚC khi đọc byte nào (rẻ nhất có thể).
        rejection = self._check_body(scope)
        if rejection is not None:
            return rejection

        now = time.monotonic()
        identity = _identity(scope, ip)
        checks: list[tuple[str, Rule]] = [
            (f"ip:{ip}", self.per_ip),
            (f"cl:{identity}", self.per_client),
        ]
        if path in AUTH_PATHS:
            # Brute-force mật khẩu/OTP đếm theo IP, KHÔNG theo danh tính: kẻ tấn
            # công không gửi token nên "danh tính" của nó chính là thứ nó điều khiển.
            checks.append((f"au:{ip}", self.auth))
        elif path.startswith(WEBHOOK_PREFIX):
            checks.append((f"wh:{ip}", self.webhook))

        with self._lock:
            for key, rule in checks:
                wait = self._buckets.hit(key, rule, now)
                if wait > 0:
                    self._note_blocked(now)
                    return Rejection(
                        status=429,
                        code="RATE_LIMITED",
                        message=(
                            "Bạn thao tác quá nhanh. Vui lòng chờ một chút rồi thử lại."
                        ),
                        retry_after=max(1, int(wait + 0.999)),
                    )
        return None

    def _check_body(self, scope: Scope) -> Rejection | None:
        raw = _header(scope, b"content-length")
        if not raw:
            return None
        try:
            size = int(raw)
        except ValueError:
            return None
        if size > self.max_body_bytes:
            return Rejection(
                status=413,
                code="PAYLOAD_TOO_LARGE",
                message="Dữ liệu gửi lên quá lớn.",
                retry_after=1,
            )
        return None

    # -- trần đồng thời -----------------------------------------------------
    def acquire(self, path: str) -> Rejection | None:
        """Giữ một slot đồng thời. `None` = giữ được (nhớ gọi `release`)."""
        if not self.enabled:
            return None
        if path in EXEMPT_PATHS:
            return None
        with self._lock:
            if path in STREAM_PATHS:
                if self._streams >= self.max_streams:
                    return Rejection(
                        status=503,
                        code="TOO_MANY_STREAMS",
                        message="Máy chủ đang quá tải kết nối realtime. Thử lại sau.",
                        retry_after=15,
                    )
                self._streams += 1
                return None
            if self._inflight >= self.max_inflight:
                # 503 chứ không 429: đây là quá tải TỨC THỜI của server (threadpool
                # + pool DB chỉ 15 kết nối), không phải client vượt hạn mức.
                self._note_blocked(time.monotonic())
                return Rejection(
                    status=503,
                    code="SERVER_BUSY",
                    message="Máy chủ đang bận. Vui lòng thử lại sau giây lát.",
                    retry_after=2,
                )
            self._inflight += 1
        return None

    def release(self, path: str) -> None:
        if not self.enabled or path in EXEMPT_PATHS:
            return
        with self._lock:
            if path in STREAM_PATHS:
                self._streams = max(0, self._streams - 1)
            else:
                self._inflight = max(0, self._inflight - 1)

    # -- log gộp ------------------------------------------------------------
    def _note_blocked(self, now: float) -> None:
        """Gọi khi ĐANG giữ `self._lock`."""
        self._blocked += 1
        if now - self._blocked_since >= 60.0:
            logger.warning(
                "rate-limit: đã chặn %d request trong %.0f giây "
                "(đang xử lý %d, stream %d)",
                self._blocked,
                now - self._blocked_since,
                self._inflight,
                self._streams,
            )
            self._blocked = 0
            self._blocked_since = now

    def stats(self) -> dict[str, int]:  # dùng trong test / debug
        with self._lock:
            return {
                "inflight": self._inflight,
                "streams": self._streams,
                "keys": len(self._buckets),
            }


def _reject(rejection: Rejection) -> JSONResponse:
    return JSONResponse(
        status_code=rejection.status,
        content={
            "detail": {
                "code": rejection.code,
                "message": rejection.message,
                "retry_after_sec": rejection.retry_after,
            }
        },
        headers={"Retry-After": str(rejection.retry_after)},
    )


class RateLimitMiddleware:
    """Middleware ASGI thuần (không dùng `BaseHTTPMiddleware`).

    `BaseHTTPMiddleware` bọc mỗi request trong một task group + memory stream;
    với endpoint SSE chạy vô hạn thì đó là chi phí giữ nguyên suốt đời kết nối.
    Middleware này chỉ cần đọc header rồi cho qua/chặn nên viết thẳng ASGI vừa
    rẻ hơn vừa đếm được đúng lúc response kết thúc (kể cả stream).
    """

    def __init__(self, app: ASGIApp, limiter: RateLimiter | None = None) -> None:
        self.app = app
        self.limiter = limiter or RateLimiter(get_settings())

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        rejection = self.limiter.check(scope)
        if rejection is not None:
            await _reject(rejection)(scope, receive, send)
            return

        path = scope.get("path", "")
        rejection = self.limiter.acquire(path)
        if rejection is not None:
            await _reject(rejection)(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            self.limiter.release(path)


# ---------------------------------------------------------------------------
# Trần kết nối SSE theo workspace
# ---------------------------------------------------------------------------
# Middleware ở trên chỉ đếm được TỔNG số stream vì lúc đó chưa xác thực xong.
# Trần theo workspace phải đặt trong chính endpoint (sau khi resolve API key):
# một API key bị lộ, hoặc một extension lỗi vòng reconnect, không được phép một
# mình ăn hết `rate_limit_max_streams` slot của cả hệ thống.
_ws_streams: dict[str, int] = {}
_ws_streams_lock = threading.Lock()


def acquire_workspace_stream(workspace_id: object) -> bool:
    """Giữ một slot SSE cho workspace. `False` = đã chạm trần → gọi 429."""
    settings = get_settings()
    if not settings.rate_limit_enabled:
        return True
    limit = settings.rate_limit_streams_per_workspace
    key = str(workspace_id)
    with _ws_streams_lock:
        current = _ws_streams.get(key, 0)
        if current >= limit:
            return False
        _ws_streams[key] = current + 1
    return True


def release_workspace_stream(workspace_id: object) -> None:
    key = str(workspace_id)
    with _ws_streams_lock:
        current = _ws_streams.get(key, 0) - 1
        if current > 0:
            _ws_streams[key] = current
        else:
            _ws_streams.pop(key, None)
