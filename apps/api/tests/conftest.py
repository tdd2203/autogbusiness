"""Test fixtures — đặt env trước khi import app để get_settings() cached đúng giá trị."""

import os

# Ưu tiên DATABASE_URL từ môi trường (vd chạy trong container qua scripts/test-api.sh,
# nối tới host "postgres"). Nếu không có, mặc định localhost cho trường hợp đã expose port.
os.environ.setdefault(
    "DATABASE_URL", "postgresql+psycopg://autogpt:autogpt@localhost:5432/autogpt_test"
)

# Chốt an toàn: fixture bên dưới DROP/TRUNCATE toàn bộ bảng. Chỉ cho phép chạy trên
# database có tên chứa "test" để không bao giờ xoá nhầm DB production (autogpt_dashboard).
_db_name = os.environ["DATABASE_URL"].rsplit("/", 1)[-1].split("?", 1)[0]
if "test" not in _db_name:
    raise RuntimeError(
        f"Từ chối chạy test trên database không phải test: {_db_name!r}. "
        "Đặt DATABASE_URL trỏ tới DB có tên chứa 'test'."
    )

os.environ["JWT_SECRET"] = "test-only-secret-do-not-use-in-prod"
os.environ["JWT_ALGORITHM"] = "HS256"
os.environ["JWT_EXPIRE_MINUTES"] = "60"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:17173"
os.environ["SUPER_ADMIN_EMAIL"] = "superadmin@example.com"
os.environ["SUPER_ADMIN_USERNAME"] = "superadmin"
os.environ["SUPER_ADMIN_PASSWORD"] = "TestPassword123!"
os.environ["EXTENSION_API_KEY"] = "test-extension-api-key"

# TẮT rate-limit cho toàn bộ suite: mọi test chia sẻ CÙNG một client (TestClient →
# IP "testclient"), nên bộ đếm theo IP sẽ cộng dồn qua hàng nghìn request của cả
# suite và bắt đầu trả 429 ở giữa chừng — lỗi giả, không liên quan nghiệp vụ.
# `test_rate_limit.py` tự dựng app + Settings riêng có BẬT để kiểm tra limiter.
os.environ["RATE_LIMIT_ENABLED"] = "false"

# Bí mật webhook HMAC cho SePay — test_wallet_hmac ký body bằng đúng secret này
# (SECRET = "test-hmac-secret-do-not-use"). Thiếu biến này → sepay_hmac_secret_configured=False.
os.environ["SEPAY_WEBHOOK_SECRET"] = "test-hmac-secret-do-not-use"

# Phí mời mặc định toàn hệ thống = 0 trong môi trường test: các test nghiệp vụ cũ
# (mời/gia hạn/subscription) không quan tâm Ví nên phải MIỄN PHÍ như trước feature 003.
# Các test Ví chuyên biệt tự GHIM phí riêng (fixture _pin_fee) hoặc tạo PaymentSettings
# riêng (test_financial_report), nên không bị ảnh hưởng bởi giá trị 0 này.
os.environ["WALLET_INVITE_FEE_DEFAULT"] = "0"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import Base, SessionLocal, engine
from app.main import app
from app.seed import seed_payment_settings, seed_super_admin

SUPER_ADMIN_PASSWORD = "TestPassword123!"
SUPER_ADMIN_USERNAME = "superadmin"


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture(autouse=True)
def _reset_db():
    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(text(f'TRUNCATE TABLE "{table.name}" RESTART IDENTITY CASCADE'))
    db = SessionLocal()
    try:
        seed_super_admin(db)
        # Khớp app thật (main.py lifespan): seed cấu hình thanh toán singleton (id=1)
        # với phí mời lấy từ env WALLET_INVITE_FEE_DEFAULT (=0 trong test). Không seed
        # dòng này → get_payment_settings tạo lazy với server_default 380k của model,
        # bỏ qua env → mọi lời mời beta bị tính phí → test nghiệp vụ cũ 402.
        seed_payment_settings(db)
    finally:
        db.close()
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def super_admin_token(client: TestClient) -> str:
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": SUPER_ADMIN_USERNAME, "password": SUPER_ADMIN_PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


@pytest.fixture
def auth_header(super_admin_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {super_admin_token}"}
