"""Email ĐANG NGỒI ở không gian nào thì `/auto-invite/email-history` phải nói ra.

Từ 2026-09-12 trang Mời cho cả mẻ email vào CHUNG một không gian chọn ở thanh trên.
Nó cần biết email nào KHÔNG đi theo được: email đang là thành viên (hay đang chờ nhận
lời mời) ở không gian khác mà bị kéo sang đích chung thì backend từ chối cả lô
(`_assert_single_workspace`) và không ai trong lô được mời.

Danh sách member không trả lời được câu này: đại lý chỉ đọc được member của không gian
mình được gán (`assert_workspace_access`), trong khi khách cũ hay nằm ở chỗ đã bị rút
quyền. Endpoint này vốn đã cố tình nhìn rộng hơn, nên cờ `holds_seat` gắn ở đây.

Phủ: email active ngoài phần được gán vẫn lộ ra và xếp trên hết; email mới mời hôm qua
(chưa có hạn, chưa đủ 30 ngày) vẫn lộ; email đã rời đội thì KHÔNG mang cờ.
"""

import uuid as _uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Member

EMAIL = "khachcu@example.org"


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


def _seed(
    ws_id: str,
    user_id: str,
    *,
    status: str,
    joined_days_ago: int | None = None,
    used_days: int = 0,
    end_at: datetime | None = None,
) -> None:
    now = datetime.now(timezone.utc)
    joined = None if joined_days_ago is None else now - timedelta(days=joined_days_ago)
    removed = None
    if status == "removed":
        removed = now if joined is None else joined + timedelta(days=used_days)
    with SessionLocal() as db:
        db.add(
            Member(
                workspace_id=_uuid.UUID(ws_id),
                email=EMAIL,
                status=status,
                joined_at=joined,
                removed_at=removed,
                subscription_end_at=end_at,
                invited_by_user_id=_uuid.UUID(user_id),
            )
        )
        db.commit()


def _history(client: TestClient, header: dict) -> dict:
    resp = client.post(
        "/api/v1/auto-invite/email-history",
        json={"emails": [EMAIL], "platform": "gpt"},
        headers=header,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["emails"]


def test_email_dang_ngoi_ngoai_phan_duoc_cap_van_lo_ra(
    client: TestClient, auth_header: dict
) -> None:
    """Khách cũ đang active ở CHATGPT PRO, đại lý chỉ còn được gán GPT1."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed(
        pro,
        sub["id"],
        status="active",
        joined_days_ago=90,
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )

    entry = _history(client, sub["header"])[EMAIL]
    assert entry["default_workspace_id"] == pro
    assert entry["workspaces"][0]["holds_seat"] is True


def test_dang_cho_nhan_loi_moi_cung_tinh_la_dang_ngoi(
    client: TestClient, auth_header: dict
) -> None:
    """Lời mời đang chờ đã chiếm chỗ — kéo email sang chỗ khác là ăn 409."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed(pro, sub["id"], status="pending")

    entry = _history(client, sub["header"])[EMAIL]
    assert entry["workspaces"][0]["holds_seat"] is True


def test_moi_hom_qua_chua_co_han_van_lo_ra(client: TestClient, auth_header: dict) -> None:
    """Ngưỡng 30 ngày không được che email đang ngồi: nó vừa được mời tuần trước."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed(pro, sub["id"], status="active", joined_days_ago=3)

    entry = _history(client, sub["header"])[EMAIL]
    assert [w["workspace_id"] for w in entry["workspaces"]] == [pro]
    assert entry["workspaces"][0]["holds_seat"] is True


def test_da_roi_doi_thi_khong_mang_co(client: TestClient, auth_header: dict) -> None:
    """Email đã rời đội đi theo đích chung được — hạn cũ dời sang cùng, không tính phí."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed(
        pro,
        sub["id"],
        status="removed",
        joined_days_ago=90,
        used_days=60,
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )

    entry = _history(client, sub["header"])[EMAIL]
    assert entry["workspaces"][0]["holds_seat"] is False
    assert entry["workspaces"][0]["holds_subscription"] is True


def test_dang_ngoi_xep_tren_ca_cho_dang_giu_han(
    client: TestClient, auth_header: dict
) -> None:
    """Hạn nằm ở PRO nhưng email đang ngồi GPT2 → mặc định phải là GPT2."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    gpt2 = _ws(client, auth_header, "GPT2")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed(
        pro,
        sub["id"],
        status="removed",
        joined_days_ago=200,
        used_days=120,
        end_at=datetime.now(timezone.utc) + timedelta(days=19),
    )
    _seed(gpt2, sub["id"], status="active", joined_days_ago=5)

    entry = _history(client, sub["header"])[EMAIL]
    assert entry["default_workspace_id"] == gpt2
