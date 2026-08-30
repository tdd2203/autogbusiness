from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(..., alias="DATABASE_URL")

    jwt_secret: str = Field(..., alias="JWT_SECRET")
    jwt_algorithm: str = Field("HS256", alias="JWT_ALGORITHM")
    jwt_expire_minutes: int = Field(720, alias="JWT_EXPIRE_MINUTES")

    frontend_origin: str = Field("http://localhost:17173", alias="FRONTEND_ORIGIN")

    super_admin_email: str = Field(..., alias="SUPER_ADMIN_EMAIL")
    super_admin_username: str = Field(..., alias="SUPER_ADMIN_USERNAME")
    super_admin_password: str = Field(..., alias="SUPER_ADMIN_PASSWORD")

    # ---- Ví & SePay (feature 003-wallet-invite-payment) ----
    # Secret webhook SePay — KHÔNG lưu DB (Nguyên tắc IV). Rỗng = webhook chấp
    # nhận không cần auth (chỉ dùng khi demo local). Prod PHẢI set để chặn giả mạo.
    sepay_apikey: str = Field("", alias="SEPAY_APIKEY")
    sepay_secret_key: str = Field("", alias="SEPAY_SECRET_KEY")
    # Secret HMAC-SHA256 (whsec_...) — SePay ký body, gửi chữ ký ở header
    # X-Sepay-Signature; server verify bằng secret này. Chỉ dùng khi auth method=hmac.
    sepay_webhook_secret: str = Field("", alias="SEPAY_WEBHOOK_SECRET")
    # Token API TÀI KHOẢN SePay (my.sepay.vn → Công ty → API Token). KHÁC hai key
    # trên: hai key kia để XÁC THỰC webhook SePay bắn tới, token này để mình CHỦ ĐỘNG
    # gọi sang SePay kéo sao kê ngân hàng về đối soát. Rỗng = tắt tính năng kéo sao kê
    # (webhook vẫn chạy bình thường).
    sepay_user_api_token: str = Field("", alias="SEPAY_USER_API_TOKEN")
    sepay_user_api_base: str = Field("https://my.sepay.vn", alias="SEPAY_USER_API_BASE")
    # Phí mời mặc định (VND) khi seed payment_settings lần đầu. Sau đó super-admin
    # sửa runtime qua UI (đọc từ DB, không đọc lại env này).
    wallet_invite_fee_default: int = Field(380_000, alias="WALLET_INVITE_FEE_DEFAULT")
    # Tài khoản test bật sẵn cờ Ví để demo. Rỗng = KHÔNG tạo (an toàn, không seed
    # tài khoản có mật khẩu yếu). Đặt mật khẩu mạnh trong .env để bật demo.
    wallet_test_username: str = Field("wallet_tester", alias="WALLET_TEST_USERNAME")
    wallet_test_password: str = Field("", alias="WALLET_TEST_PASSWORD")

    # ---- Gửi email qua API HostMail (đăng ký bằng OTP) ----
    # Việc GỬI mail được giao cho dự án HostMail qua HTTP API — dự án này KHÔNG
    # dựng SMTP, chỉ gọi API. hostmail_api_base RỖNG = chế độ dev/test: OTP được
    # GHI RA LOG thay vì gọi API thật (xem services/email.py) — cho phép test
    # end-to-end mà không cần HostMail thật.
    hostmail_api_base: str = Field("", alias="HOSTMAIL_API_BASE")
    hostmail_api_key: str = Field("", alias="HOSTMAIL_API_KEY")
    # Đường dẫn endpoint gửi mail trên HostMail (nối vào api_base).
    hostmail_send_path: str = Field("/send", alias="HOSTMAIL_SEND_PATH")
    # Địa chỉ + tên hiển thị "From" khi HostMail gửi mail OTP.
    hostmail_from: str = Field("", alias="HOSTMAIL_FROM")
    hostmail_from_name: str = Field("AutoGPT Dashboard", alias="HOSTMAIL_FROM_NAME")

    # ---- Tham số OTP đăng ký ----
    otp_ttl_minutes: int = Field(10, alias="OTP_TTL_MINUTES")
    otp_max_attempts: int = Field(5, alias="OTP_MAX_ATTEMPTS")
    otp_resend_cooldown_sec: int = Field(60, alias="OTP_RESEND_COOLDOWN_SEC")

    # ---- Nhắc gia hạn qua Telegram (services/telegram.py + renewal_reminder.py) ----
    # Token bot lấy từ @BotFather. RỖNG = TẮT HẲN tính năng (job nền không chạy,
    # endpoint trả 503) — mặc định an toàn cho dev/test.
    telegram_bot_token: str = Field("", alias="TELEGRAM_BOT_TOKEN")
    # @username của bot — chỉ để dựng deep-link t.me/<bot>?start=<token>. Rỗng =
    # tự hỏi Bot API (getMe) rồi cache trong process.
    telegram_bot_username: str = Field("", alias="TELEGRAM_BOT_USERNAME")
    # Secret gửi kèm setWebhook; Telegram trả lại ở header X-Telegram-Bot-Api-Secret-Token.
    # Rỗng = KHÔNG kiểm tra (chỉ dùng local). Prod PHẢI set để chặn giả mạo update.
    telegram_webhook_secret: str = Field("", alias="TELEGRAM_WEBHOOK_SECRET")
    # Chat nhận BẢN TỔNG HỢP (group admin). Nhiều đích ngăn cách bằng dấu phẩy.
    # ID group thường ÂM (vd -1001234567890). Rỗng = không gửi digest.
    telegram_admin_chat_id: str = Field("", alias="TELEGRAM_ADMIN_CHAT_ID")

    # Các mốc nhắc TRƯỚC hạn (số ngày còn lại), ngăn cách bằng dấu phẩy. Mặc định
    # "3,1" = nhắc khi còn ≤3 ngày và khi còn ≤1 ngày. Mỗi email chỉ nhận ĐÚNG 1 tin
    # cho mỗi mốc (chặn trùng bằng dedupe_key trong bảng telegram_notifications).
    renewal_reminder_days: str = Field("3,1", alias="RENEWAL_REMINDER_DAYS")
    # Giờ gửi trong ngày (giờ địa phương theo offset dưới). Job nền quét mỗi 5′ nhưng
    # CHỈ tạo tin mới trong giờ này → không nhắn lúc nửa đêm.
    renewal_reminder_hour: int = Field(9, alias="RENEWAL_REMINDER_HOUR")
    # Lệch giờ địa phương so với UTC (VN = +7, không có DST nên offset cố định là
    # ĐÚNG TUYỆT ĐỐI — tránh phụ thuộc tzdata có thể thiếu trong image slim).
    renewal_reminder_utc_offset: int = Field(7, alias="RENEWAL_REMINDER_UTC_OFFSET")

    # ---- Giới hạn tài nguyên (tối ưu RAM 2026-08-04) ----
    # Kết nối DB thường trực (db.py). Mỗi kết nối = 1 backend process phía
    # Postgres (~5–10MB RSS) nên pool giữ nhỏ; `max_overflow` là kết nối TẠM,
    # SQLAlchemy đóng ngay khi trả về pool → không tốn RAM lúc rảnh.
    # ⚠️ pool_size + max_overflow PHẢI nhỏ hơn `max_connections` của Postgres
    # (đặt trong docker-compose.yml), chừa chỗ cho alembic lúc startup + psql tay.
    db_pool_size: int = Field(5, alias="DB_POOL_SIZE")
    db_max_overflow: int = Field(10, alias="DB_MAX_OVERFLOW")
    # Tái tạo kết nối cũ hơn ngưỡng này (giây) — tránh dùng lại kết nối đã bị
    # Postgres/tunnel đóng phía kia mà pool chưa biết.
    db_pool_recycle_sec: int = Field(1800, alias="DB_POOL_RECYCLE_SEC")
    # Trần thời gian cho MỘT câu SQL và cho việc CHỜ KHOÁ (mili-giây, 0 = tắt).
    # Postgres mặc định chờ vô hạn cả hai: một câu chạy loạn hoặc một transaction bị
    # bỏ quên đang giữ khoá là mọi request sau xếp hàng cho tới khi pool cạn, và
    # trình duyệt chỉ thấy màn hình quay mãi. Xem db.py.
    # 60s cho câu SQL vì endpoint nặng nhất đo được vẫn dưới 30s; 10s cho khoá vì
    # chờ lâu hơn thế là đang dồn hàng chứ không phải đang tới lượt.
    db_statement_timeout_ms: int = Field(60_000, alias="DB_STATEMENT_TIMEOUT_MS")
    db_lock_timeout_ms: int = Field(10_000, alias="DB_LOCK_TIMEOUT_MS")
    # Số thread tối đa của threadpool anyio (xem main.py::_apply_thread_limit).
    thread_pool_size: int = Field(16, alias="THREAD_POOL_SIZE")

    # ---- Chống DDoS / rate-limit (app/ratelimit.py) ----
    # Tắt khẩn cấp khi nghi limiter chặn nhầm traffic thật: RATE_LIMIT_ENABLED=false
    # → deploy lại, KHÔNG cần sửa code.
    rate_limit_enabled: bool = Field(True, alias="RATE_LIMIT_ENABLED")
    # Trần THÔ theo IP — chỉ để chặn flood, đặt cao hơn nhu cầu thật nhiều lần
    # vì một IP có thể là NAT của cả văn phòng / nhiều profile MoreLogin.
    rate_limit_per_ip_per_min: int = Field(3000, alias="RATE_LIMIT_PER_IP_PER_MIN")
    # Trần theo DANH TÍNH (X-API-KEY hoặc Bearer; không có thì rơi về IP). Một
    # extension lúc scrape gửi nhiều nhất ~3-4 req/s (progress throttle 300ms),
    # nên 900/phút = 15 req/s là rộng rãi cho một client đơn lẻ.
    rate_limit_per_client_per_min: int = Field(900, alias="RATE_LIMIT_PER_CLIENT_PER_MIN")
    # Login/register/OTP/đổi mật khẩu — theo IP. Mỗi lần là một lần bcrypt hoặc
    # một email OTP, nên siết chặt: đây là hạn mức chống dò mật khẩu.
    rate_limit_auth_per_min: int = Field(20, alias="RATE_LIMIT_AUTH_PER_MIN")
    # Webhook công khai (SePay/Telegram) — theo IP.
    rate_limit_webhook_per_min: int = Field(120, alias="RATE_LIMIT_WEBHOOK_PER_MIN")
    # Trần request đang xử lý đồng thời. Endpoint đều là `def` (sync) nên chạy
    # trong threadpool `THREAD_POOL_SIZE`; vượt trần này = hàng đợi đã quá dài,
    # trả 503 ngay còn hơn để mọi request cùng timeout.
    rate_limit_max_inflight: int = Field(80, alias="RATE_LIMIT_MAX_INFLIGHT")
    # Trần kết nối SSE toàn hệ thống (đếm riêng vì kết nối sống rất lâu).
    rate_limit_max_streams: int = Field(200, alias="RATE_LIMIT_MAX_STREAMS")
    # Trần kết nối SSE trên MỖI workspace (một API key bị lộ không được phép
    # tự mở hàng trăm stream). Xem routers/queue/extension_poll.py.
    rate_limit_streams_per_workspace: int = Field(
        8, alias="RATE_LIMIT_STREAMS_PER_WORKSPACE"
    )
    # Trần kích thước body (byte). Phải >= client_max_body_size của nginx.
    rate_limit_max_body_bytes: int = Field(8 * 1024 * 1024, alias="RATE_LIMIT_MAX_BODY_BYTES")
    # Số khoá tối đa giữ trong bộ nhớ limiter (~100 byte/khoá). Trần này khiến
    # flood từ hàng vạn IP giả không làm phình RAM của chính limiter.
    rate_limit_max_keys: int = Field(20_000, alias="RATE_LIMIT_MAX_KEYS")
    # IP được MIỄN hoàn toàn (cron/monitoring nội bộ), ngăn cách bằng dấu phẩy.
    rate_limit_trusted_ips: str = Field("", alias="RATE_LIMIT_TRUSTED_IPS")

    def rate_limit_trusted_ip_set(self) -> set[str]:
        """Parse `RATE_LIMIT_TRUSTED_IPS` → set IP. Rỗng/rác → set rỗng."""
        return {p.strip() for p in (self.rate_limit_trusted_ips or "").split(",") if p.strip()}

    def telegram_admin_chat_ids(self) -> list[int]:
        """Parse `TELEGRAM_ADMIN_CHAT_ID` → danh sách id số. Bỏ qua phần rác."""
        out: list[int] = []
        for part in (self.telegram_admin_chat_id or "").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                out.append(int(part))
            except ValueError:
                continue
        return out

    def reminder_day_buckets(self) -> list[int]:
        """Parse `RENEWAL_REMINDER_DAYS` → danh sách mốc ngày GIẢM DẦN (vd [3, 1]).

        Rỗng/rác → về mặc định [3, 1]. Giảm dần vì logic chọn mốc lấy giá trị NHỎ
        NHẤT còn áp dụng được (xem renewal_reminder._bucket_for)."""
        out: list[int] = []
        for part in (self.renewal_reminder_days or "").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                value = int(part)
            except ValueError:
                continue
            if value > 0:
                out.append(value)
        return sorted(set(out), reverse=True) or [3, 1]


@lru_cache
def get_settings() -> Settings:
    return Settings()
