"""Email từng dùng không gian nào thì mời lại vào đúng không gian đó.

Ca thật 13/9/2026 (`cmsgpshp`): đại lý chỉ được gán GPT1, dán lại email khách cũ của
CHATGPT PRO (bản ghi ở PRO đã `removed`, hạn đã hết vì vừa chuyển hạn sang email
khác). Trang Mời dồn cả mẻ vào GPT1 và backend nhận luôn — khách nằm nhầm chỗ, trả
giá theo mốc chốt của GPT1 thay vì của CHATGPT PRO.

Phủ:
  * lịch sử trả `home_workspace_id` đúng chỗ cũ, kể cả chỗ ngoài phần được gán;
  * mời vào chỗ khác bị chặn 409 ở mời hàng loạt, mời lẻ và "Mời lại" một dòng —
    không tạo bản ghi, không xếp lệnh;
  * mời về đúng chỗ cũ vẫn chạy dù không được gán chỗ đó;
  * email mới toanh, chỗ cũ ngoài tầm với, super-admin: không bị chặn.
"""

import uuid as _uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Member, QueueItem, User

EMAIL = "khachcu.pro@example.org"


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
    owner_id: str,
    *,
    status: str,
    joined_days_ago: int,
    used_days: int,
    end_at: datetime,
) -> str:
    now = datetime.now(timezone.utc)
    joined = now - timedelta(days=joined_days_ago)
    removed = joined + timedelta(days=used_days) if status == "removed" else None
    with SessionLocal() as db:
        m = Member(
            workspace_id=_uuid.UUID(ws_id),
            email=EMAIL,
            status=status,
            joined_at=joined,
            removed_at=removed,
            subscription_months=1,
            subscription_end_at=end_at,
            invited_by_user_id=_uuid.UUID(owner_id),
        )
        db.add(m)
        db.commit()
        return str(m.id)


def _rows(ws_id: str, email: str = EMAIL) -> list[Member]:
    with SessionLocal() as db:
        return (
            db.query(Member)
            .filter(Member.workspace_id == _uuid.UUID(ws_id), Member.email == email)
            .all()
        )


def _bulk(client: TestClient, ws_id: str, header: dict, email: str = EMAIL):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"invites": [{"email": email, "subscription_months": 1}], "role": "member"},
        headers=header,
    )


def _history(client: TestClient, header: dict) -> dict:
    resp = client.post(
        "/api/v1/auto-invite/email-history",
        json={"emails": [EMAIL], "platform": "gpt"},
        headers=header,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["emails"][EMAIL]


def _khach_cu_pro(client: TestClient, auth_header: dict) -> tuple[str, str, dict]:
    """Đại lý chỉ được gán GPT1; khách cũ đã dùng CHATGPT PRO 28 ngày, hạn vừa hết."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    sub = _sub_admin(client, auth_header)
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed(
        pro,
        sub["id"],
        status="removed",
        joined_days_ago=29,
        used_days=28,
        end_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )
    return pro, gpt1, sub


def test_lich_su_tra_ve_khong_gian_cu(client: TestClient, auth_header: dict) -> None:
    pro, _gpt1, sub = _khach_cu_pro(client, auth_header)

    assert _history(client, sub["header"])["home_workspace_id"] == pro


def test_moi_vao_dich_chung_khac_cho_cu_bi_chan(
    client: TestClient, auth_header: dict
) -> None:
    pro, gpt1, sub = _khach_cu_pro(client, auth_header)

    resp = _bulk(client, gpt1, sub["header"])

    assert resp.status_code == 409, resp.text
    assert "CHATGPT PRO" in resp.text
    assert _rows(gpt1) == []
    with SessionLocal() as db:
        assert (
            db.query(QueueItem)
            .filter(QueueItem.workspace_id == _uuid.UUID(gpt1))
            .count()
            == 0
        )


def test_moi_le_vao_cho_khac_cung_bi_chan(client: TestClient, auth_header: dict) -> None:
    _pro, gpt1, sub = _khach_cu_pro(client, auth_header)

    resp = client.post(
        f"/api/v1/workspaces/{gpt1}/members/invite",
        json={"email": EMAIL, "role": "member", "subscription_months": 1},
        headers=sub["header"],
    )

    assert resp.status_code == 409, resp.text
    assert _rows(gpt1) == []


def test_moi_lai_dong_moi_nham_cho_cung_bi_chan(
    client: TestClient, auth_header: dict
) -> None:
    """Bấm "Mời lại" trên bản ghi của lần mời nhầm chỗ không được là cửa sau."""
    _pro, gpt1, sub = _khach_cu_pro(client, auth_header)
    wrong = _seed(
        gpt1,
        sub["id"],
        status="removed",
        joined_days_ago=0,
        used_days=0,
        end_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )

    resp = client.post(
        f"/api/v1/workspaces/{gpt1}/members/{wrong}/re-invite", headers=sub["header"]
    )

    assert resp.status_code == 409, resp.text
    [row] = _rows(gpt1)
    assert row.status == "removed"


def test_moi_ve_dung_cho_cu_thi_chay_du_khong_duoc_gan(
    client: TestClient, auth_header: dict
) -> None:
    pro, gpt1, sub = _khach_cu_pro(client, auth_header)

    resp = _bulk(client, pro, sub["header"])

    assert resp.status_code == 202, resp.text
    [row] = _rows(pro)
    assert row.status == "pending"
    assert _rows(gpt1) == []


def test_email_moi_toanh_di_theo_dich_chung(client: TestClient, auth_header: dict) -> None:
    _pro, gpt1, sub = _khach_cu_pro(client, auth_header)

    resp = _bulk(client, gpt1, sub["header"], email="moitoanh@example.org")

    assert resp.status_code == 202, resp.text


def test_cho_cu_ngoai_tam_voi_thi_khong_ghim(client: TestClient, auth_header: dict) -> None:
    """Email vô chủ (hết hạn quá 30 ngày) của đại lý khác, nằm ở chỗ đại lý này không
    được gán: không mời vào đó được thì đi theo đích người mời chọn."""
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    other = _sub_admin(client, auth_header, "agent2")
    sub = _sub_admin(client, auth_header, "agent1")
    _assign(client, auth_header, sub["id"], [gpt1])
    _seed(
        pro,
        other["id"],
        status="removed",
        joined_days_ago=100,
        used_days=60,
        end_at=datetime.now(timezone.utc) - timedelta(days=40),
    )

    assert _history(client, sub["header"])["home_workspace_id"] is None
    resp = _bulk(client, gpt1, sub["header"])
    assert resp.status_code == 202, resp.text


def test_super_admin_duoc_moi_sang_cho_khac(client: TestClient, auth_header: dict) -> None:
    pro = _ws(client, auth_header, "CHATGPT PRO")
    gpt1 = _ws(client, auth_header, "GPT1")
    with SessionLocal() as db:
        admin_id = str(db.query(User).filter(User.is_super_admin.is_(True)).first().id)
    _seed(
        pro,
        admin_id,
        status="removed",
        joined_days_ago=29,
        used_days=28,
        end_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )

    resp = _bulk(client, gpt1, auth_header)

    assert resp.status_code == 202, resp.text
