"""Test fixtures — đặt env trước khi import app để get_settings() cached đúng giá trị."""

import os

os.environ["DATABASE_URL"] = "postgresql+psycopg://autogpt:autogpt@localhost:5432/autogpt_test"
os.environ["JWT_SECRET"] = "test-only-secret-do-not-use-in-prod"
os.environ["JWT_ALGORITHM"] = "HS256"
os.environ["JWT_EXPIRE_MINUTES"] = "60"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:17173"
os.environ["SUPER_ADMIN_EMAIL"] = "superadmin@example.com"
os.environ["SUPER_ADMIN_USERNAME"] = "superadmin"
os.environ["SUPER_ADMIN_PASSWORD"] = "TestPassword123!"
os.environ["EXTENSION_API_KEY"] = "test-extension-api-key"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import Base, SessionLocal, engine
from app.main import app
from app.seed import seed_super_admin

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
