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


@lru_cache
def get_settings() -> Settings:
    return Settings()
