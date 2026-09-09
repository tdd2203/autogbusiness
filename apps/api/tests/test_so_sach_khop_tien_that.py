"""KHỐI GIẢI THÍCH GIÁ PHẢI ĐO ĐÚNG QUÃNG ĐÃ TÍNH TIỀN.

Chỗ này không trừ nhầm ví. Nó chỉ làm con số NGƯỜI BÁN đọc để báo giá cho khách lệch
khỏi sự thật, mà lệch kiểu đó thì không ai phát hiện ra cho tới lúc khách thắc mắc.

Khối đó từng lấy hạn cũ làm ĐIỂM NỐI cho cả email mà hạn ấy CHƯA CÓ TIỀN phía sau
(hạn do đồng bộ dựng lại, hoặc vừa bị hoàn phí). Tiền và hạn của lượt đó đã được tính
như một chu kỳ MỚI đo từ bây giờ, nên khối giải thích bày ra một quãng dài hơn hẳn
quãng thật sự được tính tiền.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_ws,
    make_beta_sub,
    set_settings,
)

FEE = 330_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _invite(client: TestClient, token: str, ws_id: str, email: str):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", "subscription_months": 1},
        headers=bearer(token),
    )


def _seed_han_khong_co_tien(ws_id: str, owner_id: str, email: str, *, days: int) -> None:
    """Email có HẠN ở tương lai nhưng KHÔNG kỳ nào đứng sau — ca `uochenchieudong`:
    đồng bộ dựng lại bản ghi kèm gói 30 ngày mà chưa ai trả đồng nào."""
    from app.db import SessionLocal
    from app.models import Member

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.add(
            Member(
                workspace_id=uuid.UUID(ws_id),
                email=email,
                chatgpt_role="member",
                status="removed",
                invited_by_user_id=uuid.UUID(owner_id),
                joined_at=now - timedelta(days=5),
                subscription_months=1,
                subscription_purchased_at=now - timedelta(days=5),
                subscription_end_at=now + timedelta(days=days),
            )
        )
        db.commit()


def test_giai_thich_gia_do_dung_quang_da_tinh_tien(
    client: TestClient, auth_header: dict
) -> None:
    """Hạn cũ CHƯA CÓ TIỀN thì không được dùng làm điểm nối của khối giải thích.

    Tiền và hạn của lượt này đã được tính như một chu kỳ MỚI đo từ bây giờ; lấy hạn cũ
    làm mốc bắt đầu là bày ra một quãng dài hơn hẳn quãng đã thu tiền."""
    ws = create_ws(client, auth_header, "Giai Thich WS")
    sub = make_beta_sub(client, auth_header, username="giaithich", balance=10 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    _seed_han_khong_co_tien(ws["id"], sub["id"], "gt1@example.com", days=20)

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite-preview",
        json={
            "role": "member",
            "invites": [{"email": "gt1@example.com", "subscription_months": 1}],
        },
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Kỳ chưa có tiền ⇒ lượt này CÓ tính phí (không nằm trong danh sách miễn phí).
    assert "gt1@example.com" not in body["free_emails"]
    detail = body["detail"]
    assert len(detail) == 1

    tu = datetime.fromisoformat(detail[0]["from"])
    now = datetime.now(timezone.utc)
    assert abs((tu - now).total_seconds()) < 120, (
        f"khối giải thích đang đo từ {tu.isoformat()} — đó là hạn cũ chưa ai trả tiền, "
        "không phải điểm nối của quãng vừa báo giá"
    )
    # Một tháng ở chế độ 30 ngày = 60 nửa ngày. Lấy hạn cũ làm mốc thì ra ~40.
    assert detail[0]["half_days"] == 60


def test_giai_thich_gia_van_noi_tiep_han_cua_email_dang_chay(
    client: TestClient, auth_header: dict
) -> None:
    """Đối chứng: email đang ACTIVE thì quãng mới VẪN nối tiếp hạn cũ."""
    ws = create_ws(client, auth_header, "Noi Tiep WS")
    sub = make_beta_sub(client, auth_header, username="noitiep", balance=10 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    member_id = _invite(client, sub["token"], ws["id"], "nt1@example.com").json()["id"]
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        m.status = "active"
        db.commit()
        han_cu = m.subscription_end_at.replace(tzinfo=timezone.utc)

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite-preview",
        json={
            "role": "member",
            "invites": [{"email": "nt1@example.com", "subscription_months": 1}],
        },
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text
    detail = r.json()["detail"]
    assert len(detail) == 1
    tu = datetime.fromisoformat(detail[0]["from"])
    assert abs((tu - han_cu).total_seconds()) < 5
