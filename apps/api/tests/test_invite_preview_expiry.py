"""Ô mời phải hiện ĐÚNG hạn sẽ đặt — kể cả khi không gian chốt theo chu kỳ hoá đơn.

VÌ SAO CÓ FILE NÀY: giao diện từng tự cộng `months × 30` để đoán hạn. Ở chế độ
`cycle_aligned` hạn rơi đúng MỐC CHỐT (EXPIRY_RULES §3.6.2) nên con số đoán đó lệch
hẳn — đại lý báo cho khách một ngày, hệ thống đặt một ngày khác, và không có gì báo
sai. Nay `/invite-preview` trả luôn hạn dự kiến; test này khoá đúng chỗ đó.

Chỉ kiểm HẠN. Phần tiền đã có `test_cycle_aligned_billing.py`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, time as dtime, timedelta, timezone

from fastapi.testclient import TestClient

from tests.wallet_helpers import create_ws

UTC = timezone.utc
ANCHOR_DAY = 1
CUTOFF = dtime(3, 0)


def _switch_to_cycle(client: TestClient, header: dict, ws_id: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/billing-mode",
        json={
            "mode": "cycle_aligned",
            "cycle_anchor_day": ANCHOR_DAY,
            "cycle_cutoff_utc": "03:00:00",
            "cycle_force_extra_from_day": 23,
        },
        headers=header,
    )
    assert resp.status_code == 200, resp.text


def _preview(client: TestClient, header: dict, ws_id: str, email: str, months: int) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite-preview",
        json={
            "role": "member",
            "invites": [{"email": email, "subscription_months": months}],
        },
        headers=header,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _expiry(body: dict, email: str) -> datetime:
    raw = body["expiry"][email]
    return datetime.fromisoformat(raw).astimezone(UTC)


def test_han_du_kien_roi_dung_moc_chot(client: TestClient, auth_header: dict) -> None:
    """Email MỚI ở không gian chốt theo chu kỳ: hạn phải là mốc chốt, không phải
    now + 30 ngày."""
    ws = create_ws(client, auth_header, "PREV-CYCLE")
    _switch_to_cycle(client, auth_header, ws["id"])

    end = _expiry(_preview(client, auth_header, ws["id"], "cyc@example.com", 1), "cyc@example.com")

    assert end.day == ANCHOR_DAY, f"hạn phải rơi ngày chốt, đang ra {end.isoformat()}"
    assert (end.hour, end.minute) == (CUTOFF.hour, CUTOFF.minute)
    assert end > datetime.now(UTC)
    # Mốc chốt gần nhất luôn trong vòng hơn một tháng; now+30 ngày hầu như không bao
    # giờ rơi đúng ngày 1 lúc 03:00 nên hai số này không thể trùng nhau ngẫu nhiên.
    assert end - datetime.now(UTC) <= timedelta(days=62)


def test_mua_them_thang_thi_nhay_them_mot_moc(client: TestClient, auth_header: dict) -> None:
    """Ô số tháng đếm theo MỐC: 2 tháng = mốc kế tiếp của mốc gần nhất."""
    ws = create_ws(client, auth_header, "PREV-CYCLE-2M")
    _switch_to_cycle(client, auth_header, ws["id"])

    one = _expiry(_preview(client, auth_header, ws["id"], "m1@example.com", 1), "m1@example.com")
    two = _expiry(_preview(client, auth_header, ws["id"], "m2@example.com", 2), "m2@example.com")

    assert two.day == ANCHOR_DAY and (two.hour, two.minute) == (CUTOFF.hour, CUTOFF.minute)
    # Đúng MỘT tháng dương lịch giữa hai mốc (28–31 ngày), không phải 30 ngày cứng.
    assert timedelta(days=28) <= two - one <= timedelta(days=31)


def test_gia_han_do_tu_han_cu_khong_tu_luc_bam(
    client: TestClient, auth_header: dict
) -> None:
    """Member đang ACTIVE còn hạn: hạn dự kiến vẫn là một mốc chốt, và phải SAU hạn
    hiện tại — đo từ điểm nối (EXPIRY_RULES §3.6.2)."""
    from app.db import SessionLocal
    from app.models import Member

    ws = create_ws(client, auth_header, "PREV-CYCLE-RENEW")
    _switch_to_cycle(client, auth_header, ws["id"])
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "renew@example.com", "subscription_months": 1, "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    member_id = resp.json()["id"]

    old_end = datetime.now(UTC) + timedelta(days=40)
    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(member_id))
        row.status = "active"
        row.subscription_end_at = old_end
        db.commit()

    end = _expiry(
        _preview(client, auth_header, ws["id"], "renew@example.com", 1), "renew@example.com"
    )
    assert end.day == ANCHOR_DAY and (end.hour, end.minute) == (CUTOFF.hour, CUTOFF.minute)
    assert end > old_end, "gia hạn phải nối TIẾP hạn cũ, không cắt ngắn"


def test_khong_gian_ba_muoi_ngay_van_ra_so_cu(
    client: TestClient, auth_header: dict
) -> None:
    """Chế độ `legacy_30d` không đổi: hạn = now + months × 30 ngày."""
    ws = create_ws(client, auth_header, "PREV-LEGACY")
    body = _preview(client, auth_header, ws["id"], "legacy@example.com", 2)
    end = _expiry(body, "legacy@example.com")
    expected = datetime.now(UTC) + timedelta(days=60)
    assert abs((end - expected).total_seconds()) < 120
