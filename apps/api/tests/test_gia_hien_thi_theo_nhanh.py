"""GIÁ HIỆN RA PHẢI THEO ĐÚNG NHÁNH CỦA EMAIL.

Hai nhánh bán hàng có hai cách định giá khác hẳn nhau: GPT nhân đơn giá/tháng, còn
Canva tra BẢNG BẬC (mua dài rẻ hơn, nên không có "đơn giá tháng" nào nhân ra tổng —
xem services/canva_price.py). Chỗ nào quên phân nhánh là hiện số của bên kia:

  - Bảng điều khiển ("sắp tới hạn", "tới hạn trong tuần") từng gán đơn giá tháng của
    GPT cho email Canva: hàng triệu đồng cho một ghế giá vài chục nghìn.
  - Dữ liệu xem trước từng gửi kèm `unit_price_vnd` cho cả Canva, khiến popup cách
    tính bày một phép nhân không khớp chính dòng tổng bên cạnh.

Số tiền ở đây là ƯỚC LƯỢNG MỘT KỲ, không phải số chốt — số chốt luôn do lệnh gia hạn
hỏi lại máy chủ. Nhưng ước lượng sai NHÁNH thì không còn là ước lượng nữa.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    make_beta_sub,
    set_settings,
)

FEE = 330_000  # đơn giá tháng của nhánh GPT, ghim để so được với bảng bậc Canva


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _ws(client: TestClient, auth_header: dict, *, name: str, platform: str) -> dict:
    r = client.post(
        "/api/v1/workspaces",
        json={"name": name, "platform": platform},
        headers=auth_header,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _seed_member(ws_id: str, owner_id: str, email: str, *, days: int) -> str:
    """Ghế còn hạn `days` ngày nữa — đủ để rơi vào khối "sắp tới hạn"."""
    from app.db import SessionLocal
    from app.models import Member

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        m = Member(
            workspace_id=uuid.UUID(ws_id),
            email=email,
            chatgpt_role="member",
            status="active",
            invited_by_user_id=uuid.UUID(owner_id),
            joined_at=now,
            subscription_months=1,
            subscription_purchased_at=now,
            subscription_end_at=now + timedelta(days=days),
        )
        db.add(m)
        db.commit()
        return str(m.id)


def _overview(client: TestClient, token: str, platform: str) -> dict:
    r = client.get(
        f"/api/v1/dashboard/overview?platform={platform}", headers=bearer(token)
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_bang_dieu_khien_khong_gan_gia_gpt_cho_email_canva(
    client: TestClient, auth_header: dict
) -> None:
    """Ghế Canva sắp hết hạn phải hiện tiền theo BẢNG BẬC, không phải đơn giá GPT."""
    from app.services import canva_price

    sub = make_beta_sub(client, auth_header, username="nhanhcanva", balance=0)
    ws = _ws(client, auth_header, name="Canva Nhanh WS", platform="canva")
    assign(client, auth_header, ws["id"], sub["id"])
    _seed_member(ws["id"], sub["id"], "cv1@example.com", days=3)

    data = _overview(client, sub["token"], "canva")
    gia_bac = canva_price.fee_for_months(
        [dict(t) for t in canva_price.DEFAULT_TIERS], 1
    )
    assert data["todos"]["due_soon_money"] == gia_bac, (
        f"bảng điều khiển đang khoe {data['todos']['due_soon_money']}đ cho ghế Canva, "
        f"giá thật theo bảng bậc là {gia_bac}đ"
    )
    assert data["todos"]["due_soon_money"] != FEE


def test_bang_dieu_khien_giu_nguyen_so_cua_nhanh_gpt(
    client: TestClient, auth_header: dict
) -> None:
    """Đối chứng: nhánh GPT không được đổi một đồng nào."""
    sub = make_beta_sub(client, auth_header, username="nhanhgpt", balance=0)
    ws = _ws(client, auth_header, name="GPT Nhanh WS", platform="gpt")
    assign(client, auth_header, ws["id"], sub["id"])
    _seed_member(ws["id"], sub["id"], "gp1@example.com", days=3)

    data = _overview(client, sub["token"], "gpt")
    assert data["todos"]["due_soon_money"] == FEE


def test_toi_han_trong_tuan_cung_theo_nhanh(
    client: TestClient, auth_header: dict
) -> None:
    """Danh sách "tới hạn trong tuần" đọc chung một hàm giá với thẻ tổng."""
    from app.services import canva_price

    sub = make_beta_sub(client, auth_header, username="tuancanva", balance=0)
    ws = _ws(client, auth_header, name="Canva Tuan WS", platform="canva")
    assign(client, auth_header, ws["id"], sub["id"])
    _seed_member(ws["id"], sub["id"], "cv2@example.com", days=2)

    today = datetime.now(timezone.utc).date()
    r = client.get(
        f"/api/v1/dashboard/due-members?from={today}&to={today + timedelta(days=7)}",
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    gia_bac = canva_price.fee_for_months(
        [dict(t) for t in canva_price.DEFAULT_TIERS], 1
    )
    assert rows[0]["fee"] == gia_bac


def test_xem_truoc_khong_gui_don_gia_thang_cho_canva(
    client: TestClient, auth_header: dict
) -> None:
    """Bảng bậc không có đơn giá tháng nào nhân ra tổng — đừng gửi số của GPT sang.

    Thiếu trường này thì popup cách tính tự bỏ dòng đơn giá; có nó thì nó bày một
    phép nhân không khớp chính dòng tổng ngay bên cạnh."""
    sub = make_beta_sub(client, auth_header, username="xtcanva", balance=0)
    ws = _ws(client, auth_header, name="Canva Xem Truoc WS", platform="canva")
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite-preview",
        json={
            "role": "member",
            "invites": [{"email": "cv3@example.com", "subscription_months": 3}],
        },
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text
    detail = r.json()["detail"]
    assert len(detail) == 1
    assert detail[0]["unit_price_vnd"] is None


def test_xem_truoc_van_gui_don_gia_thang_cho_gpt(
    client: TestClient, auth_header: dict
) -> None:
    """Đối chứng: nhánh GPT vẫn phải có đơn giá để bày phép tính."""
    sub = make_beta_sub(client, auth_header, username="xtgpt", balance=0)
    ws = _ws(client, auth_header, name="GPT Xem Truoc WS", platform="gpt")
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite-preview",
        json={
            "role": "member",
            "invites": [{"email": "gp3@example.com", "subscription_months": 3}],
        },
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["detail"][0]["unit_price_vnd"] == FEE


def test_xem_truoc_gia_han_canva_cung_khong_gui_don_gia(
    client: TestClient, auth_header: dict
) -> None:
    """Màn hình gia hạn dùng chung bộ trường với ô mời — phải nhất quán."""
    sub = make_beta_sub(client, auth_header, username="ghcanva", balance=0)
    ws = _ws(client, auth_header, name="Canva Gia Han WS", platform="canva")
    assign(client, auth_header, ws["id"], sub["id"])
    member_id = _seed_member(ws["id"], sub["id"], "cv4@example.com", days=10)

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/renew-preview",
        json={"member_ids": [member_id], "months": 3},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["unit_price_vnd"] is None
    # Tiền vẫn phải ra theo bảng bậc, không phải 3 × đơn giá GPT.
    assert items[0]["fee"] != 3 * FEE
