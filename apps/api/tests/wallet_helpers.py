"""Helper dùng chung cho các test Ví (feature 003-wallet-invite-payment)."""

from fastapi.testclient import TestClient

SUB_PASSWORD = "SubPassword123!"


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(client: TestClient, identifier: str, password: str = SUB_PASSWORD) -> str:
    r = client.post(
        "/api/v1/auth/login", json={"identifier": identifier, "password": password}
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def create_user(client: TestClient, auth_header: dict, username: str, permissions: list[str]) -> dict:
    r = client.post(
        "/api/v1/users",
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": SUB_PASSWORD,
            "permissions": permissions,
        },
        headers=auth_header,
    )
    assert r.status_code == 201, r.text
    return r.json()


def set_beta(client: TestClient, auth_header: dict, user_id: str, enabled: bool = True) -> dict:
    r = client.put(
        f"/api/v1/wallet/admin/users/{user_id}/beta",
        json={"enabled": enabled},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    return r.json()


def adjust(client: TestClient, auth_header: dict, user_id: str, amount: int, reason: str = "test topup") -> dict:
    r = client.post(
        f"/api/v1/wallet/admin/users/{user_id}/adjust",
        json={"amount_vnd": amount, "reason": reason},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    return r.json()


def set_settings(client: TestClient, auth_header: dict, **fields) -> dict:
    body = {
        "bank_name": "ACB",
        "account_number": "1234567890",
        "account_name": "NGUYEN VAN A",
        **fields,
    }
    r = client.put("/api/v1/wallet/admin/settings", json=body, headers=auth_header)
    assert r.status_code == 200, r.text
    return r.json()


def create_ws(client: TestClient, auth_header: dict, name: str, **extra) -> dict:
    r = client.post("/api/v1/workspaces", json={"name": name, **extra}, headers=auth_header)
    assert r.status_code == 201, r.text
    return r.json()


def assign(client: TestClient, auth_header: dict, ws_id: str, user_id: str) -> None:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id},
        headers=auth_header,
    )
    assert r.status_code == 201, r.text


def make_beta_sub(
    client: TestClient,
    auth_header: dict,
    *,
    username: str = "sub",
    perms: tuple[str, ...] = ("MEMBER_VIEW", "MEMBER_INVITE"),
    balance: int = 0,
) -> dict:
    """Tạo sub-admin đã bật cờ Ví, tuỳ chọn nạp sẵn số dư. Trả {id, token}."""
    user = create_user(client, auth_header, username, list(perms))
    set_beta(client, auth_header, user["id"], True)
    if balance:
        adjust(client, auth_header, user["id"], balance)
    return {"id": user["id"], "token": login(client, username)}


def wallet_of(client: TestClient, token: str) -> dict:
    r = client.get("/api/v1/wallet", headers=bearer(token))
    assert r.status_code == 200, r.text
    return r.json()
