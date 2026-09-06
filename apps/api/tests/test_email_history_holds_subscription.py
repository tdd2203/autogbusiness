"""Trang Mời thành viên phải trỏ email cũ về ĐÚNG workspace đang giữ hạn.

Ca thật 6/9/2026: một email được chuyển hạn sang trong workspace CHATGPT PRO nhưng
lệnh mời hỏng ngay (chưa vào được lần nào). Đại lý dán lại email đó ở trang Mời thì
`/auto-invite/email-history` trả rỗng — vì luật cũ đòi đã tham gia thật (`joined_at`
NOT NULL) và đủ 30 ngày — nên trang coi đây là email MỚI và bốc workspace được gán
(GPT1, đang hết suất) làm đích.

Phủ: bản ghi chưa từng vào nhưng CÒN HẠN vẫn ra lịch sử và làm mặc định; workspace
đang giữ hạn xếp trên workspace dùng lâu hơn; bản ghi không có hạn vẫn phải đủ 30
ngày; suất của workspace ngoài phần được gán vẫn đọc được để trang Mời hiện chip.
"""

import uuid as _uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Member, Workspace

EMAIL = "karonkaut@example.org"


def _sub_admin(client: TestClient, auth_header: dict, n: str = "agent1") -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": f"{n}@example.com",
            "username": n,
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE"],
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    login = client.post(
        "/api/v1/auth/login", json={"identifier": n, "password": "SubPassword123!"}
    )
    return {
        "id": resp.json()["id"],
        "header": {"Authorization": f"Bearer {login.json()['access_token']}"},
    }


def _ws(client: TestClient, auth_header: dict, name: str) -> str:
    resp = client.post("/api/v1/workspaces", json={"name": name}, headers=auth_header)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _assign(client: TestClient, auth_header: dict, user_id: str, ws_ids: list[str]) -> None:
    resp = client.put(
        f"/api/v1/invite-config/users/{user_id}",
        json={"all_workspaces": False, "workspace_ids": ws_ids},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text


def _seed_member(
    ws_id: str,
    user_id: str,
    *,
    email: str = EMAIL,
    status: str = "removed",
    joined_days_ago: int | None = None,
    used_days: int = 0,
    end_at: datetime | None = None,
) -> None:
    """Dựng 1 Member đúng như luồng thật để lại: mời hỏng thì `joined_at` NULL."""
    now = datetime.now(timezone.utc)
    joined = None if joined_days_ago is None else now - timedelta(days=joined_days_ago)
    if status != "removed":
        removed = None
    elif joined is None:
        removed = now  # mời hỏng: chưa vào lần nào đã bị đánh dấu rời
    else:
        removed = joined + timedelta(days=used_days)
    with SessionLocal() as db:
        db.add(
            Member(
                workspace_id=_uuid.UUID(ws_id),
                email=email,
                status=status,
                joined_at=joined,
                removed_at=removed,
                subscription_end_at=end_at,
                invited_by_user_id=_uuid.UUID(user_id),
            )
        )
        db.commit()


def _history(client: TestClient, header: dict, email: str = EMAIL) -> dict:
    resp = client.post(
        "/api/v1/auto-invite/email-history",
        json={"emails": [email], "platform": "gpt"},
        headers=header,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["emails"]


def test_chua_tung_vao_nhung_con_han_van_ra_workspace_cu(
    client: TestClient, auth_header: dict
) -> None:
    """Chuyển hạn sang rồi mời hỏng: chưa vào lần nào vẫn phải trỏ về workspace cũ."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    # Đại lý giờ chỉ còn được gán GPT1 — workspace giữ hạn không nằm trong phần cấp.
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed_member(
        pro,
        sub["id"],
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )

    entry = _history(client, sub["header"])[EMAIL]
    assert entry["default_workspace_id"] == pro
    assert [w["workspace_id"] for w in entry["workspaces"]] == [pro]
    assert entry["workspaces"][0]["usage_days"] is None
    assert entry["workspaces"][0]["holds_subscription"] is True


def test_workspace_giu_han_xep_tren_workspace_dung_lau_hon(
    client: TestClient, auth_header: dict
) -> None:
    """Email từng ở lâu tại GPT1 nhưng hạn đang nằm ở CHATGPT PRO → mặc định là PRO."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed_member(gpt1, sub["id"], joined_days_ago=200, used_days=120)
    _seed_member(
        pro,
        sub["id"],
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )

    entry = _history(client, sub["header"])[EMAIL]
    assert entry["default_workspace_id"] == pro
    assert [w["workspace_id"] for w in entry["workspaces"]] == [pro, gpt1]


def test_ban_ghi_khong_han_van_phai_du_30_ngay(
    client: TestClient, auth_header: dict
) -> None:
    """Ngưỡng 30 ngày giữ nguyên cho bản ghi chưa từng có hạn sử dụng."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed_member(pro, sub["id"], joined_days_ago=10, used_days=3)

    assert _history(client, sub["header"]) == {}


def test_suat_cua_workspace_ngoai_phan_gan_van_doc_duoc(
    client: TestClient, auth_header: dict
) -> None:
    """Trang Mời phải thấy suất của workspace đang giữ email mình mời, dù không được
    gán — nếu không chip suất trống trơn đúng chỗ sắp bị trừ suất."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])

    before = client.get("/api/v1/workspaces/seats", headers=sub["header"]).json()
    assert [w["workspace_id"] for w in before] == [gpt1]

    _seed_member(
        pro,
        sub["id"],
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )
    after = client.get("/api/v1/workspaces/seats", headers=sub["header"]).json()
    assert {w["workspace_id"] for w in after} == {gpt1, pro}


def test_email_cua_nguoi_khac_con_han_khong_lo_workspace(
    client: TestClient, auth_header: dict
) -> None:
    """Cơ chế chủ sở hữu giữ nguyên: email còn hạn của tài khoản khác vẫn không hiện."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    owner = _sub_admin(client, auth_header, "agent1")
    other = _sub_admin(client, auth_header, "agent2")
    _assign(client, auth_header, other["id"], [gpt1])
    _seed_member(
        pro,
        owner["id"],
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )

    assert _history(client, other["header"]) == {}


def test_workspace_nhanh_khac_khong_keo_ve(client: TestClient, auth_header: dict) -> None:
    """Lịch sử vẫn chỉ tính trong CÙNG nhánh — bản ghi Canva không kéo lệnh mời gpt."""
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Canva Team", "platform": "canva"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    canva = resp.json()["id"]
    _seed_member(
        canva,
        sub["id"],
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )

    assert _history(client, sub["header"]) == {}
    with SessionLocal() as db:
        assert db.get(Workspace, _uuid.UUID(canva)).platform == "canva"
