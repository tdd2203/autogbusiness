"""Test cho tầng chống DDoS / rate-limit (app/ratelimit.py, xem ratelimit.md).

Các test này KHÔNG chạm DB và KHÔNG dùng app thật: chúng dựng một FastAPI tí hon
rồi bọc `RateLimitMiddleware` với `Settings` đã sửa hạn mức xuống rất thấp. Lý do:
suite chung đã TẮT rate-limit qua `RATE_LIMIT_ENABLED=false` trong conftest (mọi
test dùng chung một "IP" testclient nên bộ đếm sẽ cộng dồn cả suite).
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import get_settings
from app.ratelimit import (
    RateLimiter,
    RateLimitMiddleware,
    _Buckets,
    _rule,
    acquire_workspace_stream,
    client_ip,
    release_workspace_stream,
)


def _settings(**overrides):
    """Settings thật của môi trường test, chỉ ghi đè phần rate-limit."""
    base = {
        "rate_limit_enabled": True,
        "rate_limit_per_ip_per_min": 3000,
        "rate_limit_per_client_per_min": 900,
        "rate_limit_auth_per_min": 20,
        "rate_limit_webhook_per_min": 120,
        "rate_limit_max_inflight": 80,
        "rate_limit_max_streams": 200,
        "rate_limit_streams_per_workspace": 8,
        "rate_limit_max_body_bytes": 8 * 1024 * 1024,
        "rate_limit_max_keys": 20_000,
        "rate_limit_trusted_ips": "",
    }
    base.update(overrides)
    return get_settings().model_copy(update=base)


def _client(**overrides) -> TestClient:
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/v1/ping")
    def ping():
        return {"ok": True}

    @app.post("/api/v1/auth/login")
    def login():
        return {"ok": True}

    @app.get("/api/v1/auth/me")
    def me():
        return {"ok": True}

    @app.post("/webhook/sepay")
    def webhook():
        return {"ok": True}

    app.add_middleware(RateLimitMiddleware, limiter=RateLimiter(_settings(**overrides)))
    return TestClient(app)


def _ip(addr: str) -> dict[str, str]:
    return {"X-Client-IP": addr}


# ---------------------------------------------------------------------------
# Hạn mức chung
# ---------------------------------------------------------------------------
def test_vuot_han_muc_tra_429_kem_retry_after():
    # burst = per_min // 6 nhưng tối thiểu 20 → 20 request lọt, cái thứ 21 bị chặn.
    c = _client(rate_limit_per_client_per_min=60)
    codes = [c.get("/api/v1/ping", headers=_ip("1.1.1.1")).status_code for _ in range(21)]
    assert codes[:20] == [200] * 20
    assert codes[20] == 429

    res = c.get("/api/v1/ping", headers=_ip("1.1.1.1"))
    assert res.status_code == 429
    assert res.headers["Retry-After"]
    detail = res.json()["detail"]
    assert detail["code"] == "RATE_LIMITED"
    assert detail["retry_after_sec"] >= 1


def test_moi_ip_co_han_muc_rieng():
    c = _client(rate_limit_per_client_per_min=60)
    for _ in range(21):
        c.get("/api/v1/ping", headers=_ip("2.2.2.2"))
    assert c.get("/api/v1/ping", headers=_ip("2.2.2.2")).status_code == 429
    # IP khác KHÔNG bị vạ lây.
    assert c.get("/api/v1/ping", headers=_ip("3.3.3.3")).status_code == 200


def test_cung_ip_khac_api_key_duoc_dem_rieng():
    """Nhiều extension sau CÙNG một NAT (profile MoreLogin) không được đá nhau."""
    c = _client(rate_limit_per_client_per_min=60, rate_limit_per_ip_per_min=100_000)
    h1 = {**_ip("4.4.4.4"), "X-API-KEY": "key-a"}
    h2 = {**_ip("4.4.4.4"), "X-API-KEY": "key-b"}
    for _ in range(21):
        c.get("/api/v1/ping", headers=h1)
    assert c.get("/api/v1/ping", headers=h1).status_code == 429
    assert c.get("/api/v1/ping", headers=h2).status_code == 200


def test_tran_theo_ip_van_phu_len_tren_khi_xoay_api_key():
    """Xoay API key để tạo danh tính mới KHÔNG thoát được trần theo IP."""
    c = _client(rate_limit_per_ip_per_min=60, rate_limit_per_client_per_min=100_000)
    codes = [
        c.get("/api/v1/ping", headers={**_ip("5.5.5.5"), "X-API-KEY": f"key-{i}"}).status_code
        for i in range(25)
    ]
    assert codes.count(429) > 0


# ---------------------------------------------------------------------------
# Endpoint nhạy cảm
# ---------------------------------------------------------------------------
def test_login_bi_siet_chat_hon_api_thuong():
    """Hạn mức MẶC ĐỊNH cho login = 20/phút, burst = 20 // 2 = 10."""
    c = _client()
    codes = [c.post("/api/v1/auth/login", headers=_ip("6.6.6.6")).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10
    assert codes[10] == 429
    # Hạn mức auth KHÔNG đụng tới các endpoint khác của cùng IP.
    assert c.get("/api/v1/ping", headers=_ip("6.6.6.6")).status_code == 200


def test_auth_me_khong_dinh_han_muc_login():
    """/auth/me được dashboard gọi liên tục — chỉ các path nhạy cảm mới bị siết."""
    c = _client()
    for _ in range(15):
        c.post("/api/v1/auth/login", headers=_ip("7.7.7.7"))
    assert c.get("/api/v1/auth/me", headers=_ip("7.7.7.7")).status_code == 200


def test_webhook_co_han_muc_rieng():
    """Hạn mức MẶC ĐỊNH cho webhook = 120/phút, burst = 120 // 4 = 30."""
    c = _client()
    codes = [c.post("/webhook/sepay", headers=_ip("8.8.8.8")).status_code for _ in range(31)]
    assert codes[:30] == [200] * 30
    assert codes[30] == 429


# ---------------------------------------------------------------------------
# Miễn trừ
# ---------------------------------------------------------------------------
def test_health_khong_bao_gio_bi_chan():
    """Chặn /health = container tự bị đánh dấu unhealthy rồi restart vòng lặp."""
    c = _client(rate_limit_per_ip_per_min=1, rate_limit_per_client_per_min=1)
    for _ in range(50):
        assert c.get("/health", headers=_ip("9.9.9.9")).status_code == 200


def test_preflight_options_khong_bi_chan():
    c = _client(rate_limit_per_ip_per_min=1, rate_limit_per_client_per_min=1)
    for _ in range(10):
        assert c.options("/api/v1/ping", headers=_ip("9.9.9.10")).status_code != 429


def test_ip_tin_cay_duoc_mien():
    c = _client(
        rate_limit_per_client_per_min=1,
        rate_limit_trusted_ips="10.0.0.5, 10.0.0.6",
    )
    for _ in range(30):
        assert c.get("/api/v1/ping", headers=_ip("10.0.0.5")).status_code == 200


def test_tat_han_thi_khong_chan_gi():
    c = _client(rate_limit_enabled=False, rate_limit_per_client_per_min=1)
    for _ in range(30):
        assert c.get("/api/v1/ping", headers=_ip("11.11.11.11")).status_code == 200


# ---------------------------------------------------------------------------
# Body quá khổ
# ---------------------------------------------------------------------------
def test_body_qua_lon_bi_tu_choi_413():
    c = _client(rate_limit_max_body_bytes=1024)
    res = c.post("/webhook/sepay", content=b"x" * 4096, headers=_ip("12.12.12.12"))
    assert res.status_code == 413
    assert res.json()["detail"]["code"] == "PAYLOAD_TOO_LARGE"


# ---------------------------------------------------------------------------
# Nguồn IP
# ---------------------------------------------------------------------------
def test_uu_tien_cf_connecting_ip_hon_x_client_ip():
    """CF ghi đè CF-Connecting-IP ở biên nên nó đáng tin hơn mọi header khác."""
    scope = {
        "type": "http",
        "headers": [(b"x-client-ip", b"1.2.3.4"), (b"cf-connecting-ip", b"5.6.7.8")],
        "client": ("172.18.0.9", 1234),
    }
    assert client_ip(scope) == "5.6.7.8"


def test_bo_qua_x_forwarded_for_gia_mao():
    """XFF do client tự khai (nginx chỉ nối thêm) → không được dùng làm khoá."""
    scope = {
        "type": "http",
        "headers": [(b"x-forwarded-for", b"9.9.9.9, 1.1.1.1")],
        "client": ("172.18.0.9", 1234),
    }
    assert client_ip(scope) == "172.18.0.9"


# ---------------------------------------------------------------------------
# Trần bộ nhớ của chính limiter
# ---------------------------------------------------------------------------
def test_kho_bucket_co_tran_cung():
    """Flood từ hàng vạn IP giả không được làm phình RAM của limiter."""
    buckets = _Buckets(max_keys=64)
    rule = _rule(600, 6, 20)
    for i in range(5000):
        buckets.hit(f"ip:10.{i // 256}.{i % 256}.1", rule, 1000.0)
    assert len(buckets) <= 64


def test_bucket_nap_lai_token_theo_thoi_gian():
    buckets = _Buckets(max_keys=100)
    rule = _rule(60, 6, 20)  # 1 req/s, burst 20
    now = 1000.0
    for _ in range(20):
        assert buckets.hit("k", rule, now) == 0.0
    assert buckets.hit("k", rule, now) > 0  # hết token
    # 5 giây sau → nạp lại 5 token.
    now += 5.0
    assert [buckets.hit("k", rule, now) == 0.0 for _ in range(5)] == [True] * 5
    assert buckets.hit("k", rule, now) > 0


# ---------------------------------------------------------------------------
# Trần kết nối SSE theo workspace
# ---------------------------------------------------------------------------
@pytest.fixture
def _ws_limit(monkeypatch):
    import app.ratelimit as rl

    monkeypatch.setattr(rl, "get_settings", lambda: _settings(rate_limit_streams_per_workspace=3))
    yield


def test_tran_stream_moi_workspace(_ws_limit):
    ws = "ws-test-1"
    try:
        assert [acquire_workspace_stream(ws) for _ in range(3)] == [True, True, True]
        assert acquire_workspace_stream(ws) is False
        # Nhả một slot → mở lại được đúng một kết nối.
        release_workspace_stream(ws)
        assert acquire_workspace_stream(ws) is True
        assert acquire_workspace_stream(ws) is False
        # Workspace khác không bị ảnh hưởng.
        assert acquire_workspace_stream("ws-test-2") is True
    finally:
        for _ in range(4):
            release_workspace_stream(ws)
        release_workspace_stream("ws-test-2")
