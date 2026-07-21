"""Tự đăng ký bằng OTP email.

Mock việc gửi mail bằng cách patch `app.routers.auth.send_otp_email` (auth.py đã
import tên này vào namespace của nó) — bắt lại (email, code) để verify, không gọi
HostMail thật.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import _purge_expired_otps_once
from app.models import EmailOtp, User


@pytest.fixture
def captured(monkeypatch) -> list[tuple[str, str]]:
    """Chặn gửi mail; lưu (email, code) mỗi lần 'gửi'."""
    box: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.routers.auth.send_otp_email",
        lambda to, code: box.append((to, code)),
    )
    return box


def _register(client: TestClient, email="new@user.com", username="newbie", password="secret12"):
    return client.post(
        "/api/v1/auth/register",
        json={"email": email, "username": username, "password": password},
    )


def test_register_creates_pending_and_sends(client, captured):
    resp = _register(client)
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == "new@user.com"
    assert resp.json()["expires_in_sec"] == 600
    # Đúng 1 mail gửi, chưa tạo User.
    assert len(captured) == 1 and captured[0][0] == "new@user.com"
    with SessionLocal() as db:
        assert db.execute(select(EmailOtp).where(EmailOtp.email == "new@user.com")).scalar_one_or_none()
        assert db.execute(select(User).where(User.email == "new@user.com")).scalar_one_or_none() is None


def test_register_conflict_existing_user(client, captured):
    # superadmin đã seed (username 'superadmin').
    resp = _register(client, email="x@y.com", username="superadmin")
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["username_taken"] is True
    assert captured == []  # không gửi mail khi trùng


def test_verify_wrong_then_success(client, captured):
    _register(client)
    _, code = captured[0]

    bad = client.post("/api/v1/auth/verify-otp", json={"email": "new@user.com", "code": "000000"})
    assert bad.status_code == 400
    assert "Còn 4 lần" in bad.json()["detail"]

    ok = client.post("/api/v1/auth/verify-otp", json={"email": "new@user.com", "code": code})
    assert ok.status_code == 200, ok.text
    token = ok.json()["access_token"]

    # Token đăng nhập được; user active, quyền rỗng, pending đã xoá.
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["email"] == "new@user.com"
    assert me.json()["permissions"] == []
    assert me.json()["is_active"] is True
    assert me.json()["is_super_admin"] is False
    with SessionLocal() as db:
        assert db.execute(select(EmailOtp).where(EmailOtp.email == "new@user.com")).scalar_one_or_none() is None


def test_verify_max_attempts_deletes_pending(client, captured):
    _register(client)
    for _ in range(5):
        r = client.post("/api/v1/auth/verify-otp", json={"email": "new@user.com", "code": "999999"})
        assert r.status_code == 400
    # Lần thứ 6 vượt ngưỡng → buộc đăng ký lại + xoá pending.
    r6 = client.post("/api/v1/auth/verify-otp", json={"email": "new@user.com", "code": "999999"})
    assert r6.status_code == 400 and "đăng ký lại" in r6.json()["detail"]
    with SessionLocal() as db:
        assert db.execute(select(EmailOtp).where(EmailOtp.email == "new@user.com")).scalar_one_or_none() is None


def test_verify_expired(client, captured):
    _register(client)
    _, code = captured[0]
    with SessionLocal() as db:
        otp = db.execute(select(EmailOtp).where(EmailOtp.email == "new@user.com")).scalar_one()
        otp.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    r = client.post("/api/v1/auth/verify-otp", json={"email": "new@user.com", "code": code})
    assert r.status_code == 400 and "hết hạn" in r.json()["detail"]


def test_resend_cooldown_then_new_code(client, captured):
    _register(client)
    first_code = captured[0][1]

    # Ngay lập tức → 429 cooldown.
    r = client.post("/api/v1/auth/resend-otp", json={"email": "new@user.com"})
    assert r.status_code == 429

    # Lùi last_sent_at quá cooldown → gửi lại được, mã mới.
    with SessionLocal() as db:
        otp = db.execute(select(EmailOtp).where(EmailOtp.email == "new@user.com")).scalar_one()
        otp.last_sent_at = datetime.now(timezone.utc) - timedelta(seconds=120)
        db.commit()
    r2 = client.post("/api/v1/auth/resend-otp", json={"email": "new@user.com"})
    assert r2.status_code == 200, r2.text
    assert len(captured) == 2
    new_code = captured[1][1]
    # Mã cũ không còn verify được; mã mới thì được.
    assert client.post(
        "/api/v1/auth/verify-otp", json={"email": "new@user.com", "code": first_code}
    ).status_code == 400
    assert client.post(
        "/api/v1/auth/verify-otp", json={"email": "new@user.com", "code": new_code}
    ).status_code == 200


def test_purge_expired_otps(client, captured):
    _register(client, email="keep@a.com", username="keepa")
    _register(client, email="gone@a.com", username="gonea")
    with SessionLocal() as db:
        otp = db.execute(select(EmailOtp).where(EmailOtp.email == "gone@a.com")).scalar_one()
        otp.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()

    _purge_expired_otps_once()

    with SessionLocal() as db:
        assert db.execute(select(EmailOtp).where(EmailOtp.email == "gone@a.com")).scalar_one_or_none() is None
        assert db.execute(select(EmailOtp).where(EmailOtp.email == "keep@a.com")).scalar_one_or_none() is not None
