"""Tuần 1.1 — verify JWT revocation qua token_version."""

import base64
import json

from fastapi.testclient import TestClient

from .conftest import SUPER_ADMIN_PASSWORD, SUPER_ADMIN_USERNAME


def _decode_payload(token: str) -> dict:
    payload = token.split(".")[1]
    padded = payload + "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


def test_login_token_contains_tv_zero(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": SUPER_ADMIN_USERNAME, "password": SUPER_ADMIN_PASSWORD},
    )
    assert resp.status_code == 200
    body = _decode_payload(resp.json()["access_token"])
    assert body["tv"] == 0
    assert body["is_super_admin"] is True


def test_me_works_with_valid_token(client: TestClient, auth_header: dict) -> None:
    resp = client.get("/api/v1/auth/me", headers=auth_header)
    assert resp.status_code == 200
    assert resp.json()["username"] == SUPER_ADMIN_USERNAME


def test_change_password_returns_new_token_and_invalidates_old(
    client: TestClient, auth_header: dict
) -> None:
    old_token = auth_header["Authorization"].split()[1]

    resp = client.post(
        "/api/v1/auth/change-password",
        json={"old_password": SUPER_ADMIN_PASSWORD, "new_password": "BrandNewPass456!"},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    new_token = resp.json()["access_token"]
    assert new_token != old_token
    assert _decode_payload(new_token)["tv"] == 1

    old_resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {old_token}"}
    )
    assert old_resp.status_code == 401

    new_resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {new_token}"}
    )
    assert new_resp.status_code == 200


def test_disable_user_invalidates_token(client: TestClient, auth_header: dict) -> None:
    create_resp = client.post(
        "/api/v1/users",
        json={
            "email": "sub1@example.com",
            "username": "sub1",
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "QUEUE_VIEW"],
        },
        headers=auth_header,
    )
    assert create_resp.status_code == 201, create_resp.text
    sub_id = create_resp.json()["id"]

    login_resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": "sub1", "password": "SubPassword123!"},
    )
    assert login_resp.status_code == 200
    sub_token = login_resp.json()["access_token"]
    assert _decode_payload(sub_token)["tv"] == 0

    me_ok = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {sub_token}"}
    )
    assert me_ok.status_code == 200

    disable_resp = client.patch(
        f"/api/v1/users/{sub_id}", json={"is_active": False}, headers=auth_header
    )
    assert disable_resp.status_code == 200

    me_blocked = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {sub_token}"}
    )
    assert me_blocked.status_code == 401


def test_reset_password_invalidates_token(client: TestClient, auth_header: dict) -> None:
    create_resp = client.post(
        "/api/v1/users",
        json={
            "email": "sub2@example.com",
            "username": "sub2",
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW"],
        },
        headers=auth_header,
    )
    assert create_resp.status_code == 201
    sub_id = create_resp.json()["id"]

    login_resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": "sub2", "password": "SubPassword123!"},
    )
    sub_token = login_resp.json()["access_token"]

    reset_resp = client.post(
        f"/api/v1/users/{sub_id}/reset-password",
        json={"new_password": "ResetForced456!"},
        headers=auth_header,
    )
    assert reset_resp.status_code == 204

    me_blocked = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {sub_token}"}
    )
    assert me_blocked.status_code == 401

    new_login = client.post(
        "/api/v1/auth/login",
        json={"identifier": "sub2", "password": "ResetForced456!"},
    )
    assert new_login.status_code == 200
    assert _decode_payload(new_login.json()["access_token"])["tv"] == 1


def test_invalid_token_signature_rejected(client: TestClient) -> None:
    resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": "Bearer not.a.valid.token"}
    )
    assert resp.status_code == 401


def test_old_token_without_tv_claim_rejected(client: TestClient) -> None:
    """Token cũ phát hành trước migration không có tv claim → reject."""
    import jose.jwt

    payload = {
        "sub": "00000000-0000-0000-0000-000000000000",
        "is_super_admin": False,
        "permissions": [],
        "iat": 0,
        "exp": 9999999999,
    }
    bad_token = jose.jwt.encode(
        payload, "test-only-secret-do-not-use-in-prod", algorithm="HS256"
    )
    resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {bad_token}"}
    )
    assert resp.status_code == 401
