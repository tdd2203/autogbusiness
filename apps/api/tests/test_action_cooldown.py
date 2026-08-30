"""Hạn mức THAO TÁC theo người dùng (`app/action_limit.py`) + trang chỉnh của
super-admin (`/api/v1/admin/rate-limits`).

Suite chung đặt RATE_LIMIT_ENABLED=false (xem conftest) nên cooldown TẮT ở mọi
test nghiệp vụ khác. File này bật lại bằng cách vá `_env_enabled` — vá hàm chứ
không sửa env vì `get_settings()` đã bị cache từ lúc import app.
"""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import action_limit
from app.db import SessionLocal
from app.models import User, Workspace
from app.security import hash_password


@pytest.fixture(autouse=True)
def _clean_state():
    """Bộ đếm + cache cấu hình là biến toàn cục trong process — dọn giữa các test,
    bằng không thứ tự chạy quyết định kết quả."""
    action_limit.reset_state()
    yield
    action_limit.reset_state()


@pytest.fixture
def limits_on(monkeypatch):
    """Bật hạn mức thao tác cho riêng test này (suite chung tắt qua env)."""
    monkeypatch.setattr(action_limit, "_env_enabled", lambda: True)
    action_limit.reset_state()
    yield


def _mk_workspace(db, name="WS") -> Workspace:
    ws = Workspace(name=name, extension_api_key=uuid4().hex)
    db.add(ws)
    db.flush()
    return ws


def _mk_sub_admin(db, username: str) -> User:
    u = User(
        email=f"{username}@example.com",
        username=username,
        password_hash=hash_password("SubAdmin123!"),
        is_super_admin=False,
        is_active=True,
        permissions=[
            "WORKSPACE_SYNC_TRIGGER",
            "WORKSPACE_FULL_SYNC",
            "MEMBER_VIEW",
            "MEMBER_REMOVE",
            "BILLING_PAY",
        ],
        invite_all_workspaces=True,
    )
    db.add(u)
    db.flush()
    return u


def _seed_sub_admin() -> tuple[str, str]:
    db = SessionLocal()
    try:
        ws = _mk_workspace(db)
        _mk_sub_admin(db, "coolsub")
        db.commit()
        return str(ws.id), "coolsub"
    finally:
        db.close()


def _login(client: TestClient, username: str) -> dict[str, str]:
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": username, "password": "SubAdmin123!"},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# --- Chặn bấm dồn ----------------------------------------------------------


def test_sync_billing_lan_hai_bi_chan(client: TestClient, limits_on):
    """Bấm "Đồng bộ hoá đơn" hai lần liên tiếp: lần hai 429 kèm số giây phải chờ."""
    ws_id, username = _seed_sub_admin()
    header = _login(client, username)

    first = client.post(f"/api/v1/workspaces/{ws_id}/sync-billing", headers=header)
    assert first.status_code == 202, first.text

    second = client.post(f"/api/v1/workspaces/{ws_id}/sync-billing", headers=header)
    assert second.status_code == 429, second.text
    detail = second.json()["detail"]
    assert detail["code"] == "ACTION_COOLDOWN"
    assert detail["action"] == "WORKSPACE_SYNC_BILLING"
    assert 0 < detail["retry_after_sec"] <= 60
    assert second.headers["Retry-After"] == str(detail["retry_after_sec"])


def test_workspace_khac_dem_rieng(client: TestClient, limits_on):
    """Dashboard lặp qua từng workspace rồi gọi một request cho mỗi cái — bộ đếm
    phải tách theo workspace, bằng không chính luồng hợp lệ đó tự đá mình."""
    db = SessionLocal()
    try:
        ws_a = _mk_workspace(db, "A")
        ws_b = _mk_workspace(db, "B")
        _mk_sub_admin(db, "coolsub")
        db.commit()
        a_id, b_id = str(ws_a.id), str(ws_b.id)
    finally:
        db.close()
    header = _login(client, "coolsub")

    assert client.post(f"/api/v1/workspaces/{a_id}/sync-billing", headers=header).status_code == 202
    assert client.post(f"/api/v1/workspaces/{b_id}/sync-billing", headers=header).status_code == 202


def test_super_admin_duoc_mien_tru_theo_mac_dinh(client: TestClient, auth_header, limits_on):
    db = SessionLocal()
    try:
        ws = _mk_workspace(db)
        db.commit()
        ws_id = str(ws.id)
    finally:
        db.close()

    for _ in range(3):
        resp = client.post(f"/api/v1/workspaces/{ws_id}/sync-billing", headers=auth_header)
        assert resp.status_code == 202, resp.text


def test_tat_mien_tru_thi_super_admin_cung_bi_chan(
    client: TestClient, auth_header, limits_on
):
    db = SessionLocal()
    try:
        ws = _mk_workspace(db)
        db.commit()
        ws_id = str(ws.id)
    finally:
        db.close()

    saved = client.put(
        "/api/v1/admin/rate-limits",
        headers=auth_header,
        json={"enabled": True, "exempt_super_admin": False, "cooldowns": {}},
    )
    assert saved.status_code == 200, saved.text

    assert client.post(f"/api/v1/workspaces/{ws_id}/sync-billing", headers=auth_header).status_code == 202
    assert client.post(f"/api/v1/workspaces/{ws_id}/sync-billing", headers=auth_header).status_code == 429


def test_dat_0_giay_la_bo_han_muc(client: TestClient, auth_header, limits_on):
    ws_id, username = _seed_sub_admin()
    header = _login(client, username)

    saved = client.put(
        "/api/v1/admin/rate-limits",
        headers=auth_header,
        json={
            "enabled": True,
            "exempt_super_admin": True,
            "cooldowns": {"WORKSPACE_SYNC_BILLING": 0},
        },
    )
    assert saved.status_code == 200, saved.text

    for _ in range(3):
        resp = client.post(f"/api/v1/workspaces/{ws_id}/sync-billing", headers=header)
        assert resp.status_code == 202, resp.text


def test_tat_han_muc_thi_bam_bao_nhieu_cung_duoc(client: TestClient, auth_header, limits_on):
    ws_id, username = _seed_sub_admin()
    header = _login(client, username)

    client.put(
        "/api/v1/admin/rate-limits",
        headers=auth_header,
        json={"enabled": False, "exempt_super_admin": True, "cooldowns": {}},
    )
    for _ in range(3):
        assert client.post(f"/api/v1/workspaces/{ws_id}/sync-billing", headers=header).status_code == 202


# --- Đồng bộ toàn bộ: cooldown dài, tính theo DB ----------------------------


def test_full_sync_doc_so_giay_tu_cau_hinh(client: TestClient, auth_header, limits_on):
    """Đổi cooldown full-sync xuống 1 giây thì admin phụ sync lại được ngay —
    chứng minh mốc 5 tiếng không còn là hằng số chôn trong code."""
    ws_id, username = _seed_sub_admin()
    header = _login(client, username)

    assert client.post(f"/api/v1/workspaces/{ws_id}/sync", headers=header).status_code == 202
    blocked = client.post(f"/api/v1/workspaces/{ws_id}/sync", headers=header)
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "FULL_SYNC_COOLDOWN"

    client.put(
        "/api/v1/admin/rate-limits",
        headers=auth_header,
        json={
            "enabled": True,
            "exempt_super_admin": True,
            "cooldowns": {"WORKSPACE_FULL_SYNC": 0},
        },
    )
    assert client.post(f"/api/v1/workspaces/{ws_id}/sync", headers=header).status_code == 202


def test_sync_quota_khop_voi_cau_hinh(client: TestClient, auth_header, limits_on):
    ws_id, username = _seed_sub_admin()
    header = _login(client, username)

    quota = client.get(f"/api/v1/workspaces/{ws_id}/sync-quota", headers=header)
    assert quota.status_code == 200
    assert quota.json()["full_sync_allowed"] is True

    assert client.post(f"/api/v1/workspaces/{ws_id}/sync", headers=header).status_code == 202
    assert client.get(f"/api/v1/workspaces/{ws_id}/sync-quota", headers=header).json()[
        "full_sync_allowed"
    ] is False

    client.put(
        "/api/v1/admin/rate-limits",
        headers=auth_header,
        json={
            "enabled": True,
            "exempt_super_admin": True,
            "cooldowns": {"WORKSPACE_FULL_SYNC": 0},
        },
    )
    assert client.get(f"/api/v1/workspaces/{ws_id}/sync-quota", headers=header).json()[
        "full_sync_allowed"
    ] is True


# --- Trang cấu hình --------------------------------------------------------


def test_chi_super_admin_xem_duoc_trang_han_muc(client: TestClient):
    _seed_sub_admin_ws = _seed_sub_admin()
    header = _login(client, _seed_sub_admin_ws[1])
    assert client.get("/api/v1/admin/rate-limits", headers=header).status_code == 403
    assert client.get("/api/v1/admin/rate-limits").status_code == 401


def test_get_tra_ve_catalog_day_du(client: TestClient, auth_header):
    resp = client.get("/api/v1/admin/rate-limits", headers=auth_header)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    keys = {a["key"] for a in body["actions"]}
    assert keys == {spec.key for spec in action_limit.ACTIONS}
    assert body["enabled"] is True
    for item in body["actions"]:
        assert item["seconds"] == item["default_sec"]
        assert item["label"] and item["hint"]


def test_luu_gia_tri_bi_kep_ve_tran_va_bo_key_la(client: TestClient, auth_header):
    resp = client.put(
        "/api/v1/admin/rate-limits",
        headers=auth_header,
        json={
            "enabled": True,
            "exempt_super_admin": True,
            "cooldowns": {
                "WORKSPACE_SYNC_BILLING": 10**9,  # vượt trần → kẹp
                "KHONG_TON_TAI": 30,  # key lạ → bỏ
                "WALLET_TOPUP": -5,  # âm → 0
            },
        },
    )
    assert resp.status_code == 200, resp.text
    by_key = {a["key"]: a for a in resp.json()["actions"]}
    assert by_key["WORKSPACE_SYNC_BILLING"]["seconds"] == by_key["WORKSPACE_SYNC_BILLING"]["max_sec"]
    assert by_key["WALLET_TOPUP"]["seconds"] == 0
    assert "KHONG_TON_TAI" not in by_key

    again = client.get("/api/v1/admin/rate-limits", headers=auth_header).json()
    assert {a["key"]: a["seconds"] for a in again["actions"]}[
        "WORKSPACE_SYNC_BILLING"
    ] == by_key["WORKSPACE_SYNC_BILLING"]["max_sec"]


def test_cong_tac_moi_truong_tat_thi_effective_false(client: TestClient, auth_header):
    """RATE_LIMIT_ENABLED=false (mặc định của suite) → đã lưu enabled=True vẫn
    không có hiệu lực; giao diện phải phân biệt được hai thứ đó."""
    body = client.get("/api/v1/admin/rate-limits", headers=auth_header).json()
    assert body["enabled"] is True
    assert body["effective"] is False


# --- Đường tạo task thô không được đi vòng cooldown -------------------------


def test_post_queue_khong_di_vong_duoc_cooldown(client: TestClient, limits_on):
    """`POST /queue` tạo được QueueItem bất kỳ loại nào — nếu không gác thì mọi
    cooldown ở các endpoint riêng chỉ là trang trí."""
    ws_id, username = _seed_sub_admin()
    header = _login(client, username)

    body = {"type": "SYNC_BILLING", "workspace_id": ws_id, "payload": {}}
    first = client.post("/api/v1/queue", headers=header, json=body)
    assert first.status_code == 201, first.text

    second = client.post("/api/v1/queue", headers=header, json=body)
    assert second.status_code == 429, second.text
    assert second.json()["detail"]["code"] == "ACTION_COOLDOWN"


def test_post_queue_ton_trong_cooldown_full_sync(client: TestClient, limits_on):
    ws_id, username = _seed_sub_admin()
    header = _login(client, username)

    assert client.post(f"/api/v1/workspaces/{ws_id}/sync", headers=header).status_code == 202

    blocked = client.post(
        "/api/v1/queue",
        headers=header,
        json={"type": "SYNC_DATA", "workspace_id": ws_id, "payload": {}},
    )
    assert blocked.status_code == 429, blocked.text
    assert blocked.json()["detail"]["code"] == "FULL_SYNC_COOLDOWN"
