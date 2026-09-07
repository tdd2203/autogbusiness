"""CHỦ SỞ HỮU EMAIL = NGƯỜI MỜI ĐẦU TIÊN (ca hieuthanh7478, chốt user 2026-09-07).

Chuỗi hôm đó: đại lý mời email + trả 330.000đ (4/9) → chuyển hạn sang email viết
đúng chính tả (5/9) → lệnh mời của đại lý hỏng `CONTENT_TIMEOUT` (6/9 10:29) →
super-admin bấm mời hộ một lượt (10:54) và email SANG TÊN admin. Đại lý mất khách
khỏi sổ dù tiền vẫn là tiền họ trả, chỉ vì người bấm nút gần nhất được ghi làm chủ.

Hai luật ở đây:
  1. Mời (kể cả mời lại) KHÔNG sang tên: chủ chỉ được gán khi email đang vô chủ.
  2. Email hết hạn vẫn thuộc chủ cũ thêm 30 ngày — trả muộn vài hôm không phải mất
     khách. Quá 30 ngày không thanh toán mới thành vô chủ.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from tests.wallet_helpers import assign, bearer, create_user, create_ws, login

PERMS = ["MEMBER_VIEW", "MEMBER_INVITE"]


def _sub(client: TestClient, auth_header: dict, username: str, ws_id: str) -> dict:
    user = create_user(client, auth_header, username, PERMS)
    assign(client, auth_header, ws_id, user["id"])
    return {"id": user["id"], "token": login(client, username)}


def _bulk_invite(client: TestClient, token: str, ws_id: str, email: str, expect: int = 202):
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": [email], "role": "member", "subscription_months": 1},
        headers=bearer(token),
    )
    assert r.status_code == expect, r.text
    return r


def _member(email: str) -> dict:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.query(Member).filter(Member.email == email).one()
        return {
            "id": str(m.id),
            "status": m.status,
            "owner_id": str(m.invited_by_user_id) if m.invited_by_user_id else None,
        }


def _expire(email: str, *, days_ago: int) -> None:
    """Đẩy hạn về quá khứ đúng `days_ago` ngày (mô phỏng khách chưa trả tiếp)."""
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.query(Member).filter(Member.email == email).one()
        m.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=days_ago)
        m.status = "removed"
        db.commit()


def test_super_admin_moi_lai_ho_khong_sang_ten(
    client: TestClient, auth_header: dict
) -> None:
    """Ca thật: lệnh mời của đại lý hỏng, admin bấm mời lại hộ → email VẪN của đại lý."""
    ws = create_ws(client, auth_header, "Owner Keep WS")
    agent = _sub(client, auth_header, "ownerkeep", ws["id"])
    _bulk_invite(client, agent["token"], ws["id"], "keep@example.com")
    member_id = _member("keep@example.com")["id"]

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/re-invite",
        headers=auth_header,
    )
    assert r.status_code == 201, r.text
    assert _member("keep@example.com")["owner_id"] == agent["id"], (
        "mời hộ là giúp một lượt gọi, không phải sang tên"
    )


def test_super_admin_khong_mua_ho_email_da_het_han(
    client: TestClient, auth_header: dict
) -> None:
    """Email hết hạn: mời lại = chu kỳ MỚI có phí → không cho người khác bấm hộ
    (tiền của người này, email trong sổ người kia)."""
    ws = create_ws(client, auth_header, "Owner Expired WS")
    agent = _sub(client, auth_header, "ownerexp", ws["id"])
    _bulk_invite(client, agent["token"], ws["id"], "expired@example.com")
    member_id = _member("expired@example.com")["id"]
    _expire("expired@example.com", days_ago=5)

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/re-invite",
        headers=auth_header,
    )
    assert r.status_code == 409, r.text
    assert "chủ sở hữu" in r.json()["detail"]
    assert _member("expired@example.com")["owner_id"] == agent["id"]


def test_chu_cu_van_giu_email_trong_30_ngay_dau_sau_han(
    client: TestClient, auth_header: dict
) -> None:
    """Hết hạn 5 ngày → đại lý khác chưa được nhận email này."""
    ws = create_ws(client, auth_header, "Owner Grace WS")
    first = _sub(client, auth_header, "gracefirst", ws["id"])
    other = _sub(client, auth_header, "graceother", ws["id"])
    _bulk_invite(client, first["token"], ws["id"], "grace@example.com")
    _expire("grace@example.com", days_ago=5)

    r = _bulk_invite(client, other["token"], ws["id"], "grace@example.com", expect=409)
    assert "chủ sở hữu" in r.json()["detail"]
    assert _member("grace@example.com")["owner_id"] == first["id"]


def test_qua_30_ngay_khong_thanh_toan_thi_email_vo_chu(
    client: TestClient, auth_header: dict
) -> None:
    """Hết hạn 31 ngày mà vẫn không thanh toán → ai mời cũng được, người mời thành chủ."""
    ws = create_ws(client, auth_header, "Owner Released WS")
    first = _sub(client, auth_header, "relfirst", ws["id"])
    other = _sub(client, auth_header, "relother", ws["id"])
    _bulk_invite(client, first["token"], ws["id"], "released@example.com")
    _expire("released@example.com", days_ago=31)

    _bulk_invite(client, other["token"], ws["id"], "released@example.com")
    assert _member("released@example.com")["owner_id"] == other["id"]
