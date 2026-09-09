"""THÊM THỦ CÔNG phải theo luật tính hạn của chính không gian đó.

Thêm tay không trừ ví, nên nhìn qua tưởng không dính tiền. Nhưng kỳ nó sinh ra là kỳ
CÒN NỢ, và tab "Email đã add" thu tiền đúng theo kỳ đó (`added_members._cycle_fee`).
Ở không gian `cycle_aligned` mà vẫn cộng 30 ngày thì hạn lệch khỏi ngày thanh toán,
còn kỳ thì thiếu phần nửa ngày lẻ ⇒ đại lý bị thu TRỌN một tháng cho quãng chỉ chạy
tới mốc chốt. Luật ở `app/routers/members/EXPIRY_RULES.md` §3.6.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import set_settings

FEE = 100_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    """Ghim đơn giá tháng: mặc định hệ thống là 0 nên mọi phép so tiền sẽ vô nghĩa."""
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _ws(client: TestClient, auth_header: dict, *, name: str, domain: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "verified_domain": domain},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _switch_to_cycle_aligned(ws_id: str, anchor_day: int = 25) -> None:
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        ws = db.get(Workspace, uuid.UUID(ws_id))
        ws.billing_mode = "cycle_aligned"
        ws.cycle_anchor_day = anchor_day
        db.commit()


def _manual_add(client: TestClient, auth_header: dict, ws_id: str, email: str, months: int):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/manual-add",
        json={"invites": [{"email": email, "subscription_months": months}]},
        headers=auth_header,
    )


def _member_and_cycles(ws_id: str, email: str):
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws_id), Member.email == email)
            .one()
        )
        cycles = [
            {
                "start_at": c.start_at,
                "end_at": c.end_at,
                "months": c.months,
                "prorated_half_days": c.prorated_half_days,
                "payment_status": c.payment_status,
            }
            for c in sorted(m.subscription_cycles, key=lambda c: c.cycle_number)
        ]
        return {
            "end_at": m.subscription_end_at,
            "purchased_at": m.subscription_purchased_at,
            "months": m.subscription_months,
        }, cycles


def test_them_tay_ra_dung_moc_chot_cua_khong_gian(
    client: TestClient, auth_header: dict
) -> None:
    """Hạn rơi vào NGÀY THANH TOÁN của không gian, không phải "hôm nay + 30 ngày"."""
    ws = _ws(client, auth_header, name="Them Tay Chu Ky WS", domain="ndaigroup.org")
    _switch_to_cycle_aligned(ws["id"], anchor_day=25)

    r = _manual_add(client, auth_header, ws["id"], "ct1@ndaigroup.org", 1)
    assert r.status_code == 201, r.text

    member, cycles = _member_and_cycles(ws["id"], "ct1@ndaigroup.org")
    assert member["end_at"] is not None
    assert member["end_at"].day == 25, "thêm tay vẫn cộng 30 ngày ở không gian chốt theo chu kỳ"
    assert len(cycles) == 1
    assert cycles[0]["payment_status"] == "unpaid"
    assert cycles[0]["end_at"] == member["end_at"]


def _anchor_giua_chu_ky() -> int:
    """Ngày neo cách hôm nay ~15 ngày: điểm nối rơi vào GIỮA chu kỳ ở mọi ngày chạy.

    Cố định một con số (vd 25) là bài test đổi ý nghĩa theo ngày chạy: đúng ngày 25 thì
    phần lẻ bằng 0, còn từ ngày 23 trở đi lại chạm ngưỡng ép thêm tháng."""
    return ((datetime.now(timezone.utc).day + 15 - 1) % 28) + 1


def test_them_tay_ghi_nua_ngay_le_de_thu_dung_tien(
    client: TestClient, auth_header: dict
) -> None:
    """Kỳ phải mang phần nửa ngày lẻ; thiếu nó là tab "Email đã add" thu trọn một tháng."""
    ws = _ws(client, auth_header, name="Them Tay Le WS", domain="ndaigroup.org")
    _switch_to_cycle_aligned(ws["id"], anchor_day=_anchor_giua_chu_ky())

    _manual_add(client, auth_header, ws["id"], "ct2@ndaigroup.org", 1)
    _member, cycles = _member_and_cycles(ws["id"], "ct2@ndaigroup.org")

    # Mua 1 mốc từ GIỮA chu kỳ ⇒ chỉ có phần lẻ tới mốc chốt, không tháng tròn nào.
    assert cycles[0]["prorated_half_days"] is not None
    assert cycles[0]["prorated_half_days"] > 0
    assert (cycles[0]["months"] or 0) == 0


def test_tien_cua_ky_no_do_theo_quang_that(
    client: TestClient, auth_header: dict
) -> None:
    """Số tiền tab "Email đã add" đòi phải đo theo QUÃNG THẬT, không phải trọn tháng.

    Đây là hậu quả tiền của lỗi: kỳ ghi `months=1` không phần lẻ thì `_cycle_fee` thu
    nguyên một tháng cho quãng chỉ chạy tới mốc chốt."""
    import uuid as _uuid

    from app.db import SessionLocal
    from app.models import Member, User
    from app.routers.added_members import _cycle_fee
    from app.routers.wallet._shared import get_payment_settings

    ws = _ws(client, auth_header, name="Them Tay Tien WS", domain="ndaigroup.org")
    _switch_to_cycle_aligned(ws["id"], anchor_day=_anchor_giua_chu_ky())
    _manual_add(client, auth_header, ws["id"], "ct5@ndaigroup.org", 1)

    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(
                Member.workspace_id == _uuid.UUID(ws["id"]),
                Member.email == "ct5@ndaigroup.org",
            )
            .one()
        )
        settings_row = get_payment_settings(db)
        default_fee = int(settings_row.invite_fee_vnd or 0)
        owner = db.get(User, m.invited_by_user_id)
        cycle = sorted(m.subscription_cycles, key=lambda c: c.cycle_number)[0]
        fee = _cycle_fee(db, owner, m, cycle, default_fee, settings_row)

    assert default_fee == FEE
    assert 0 < fee < default_fee, (
        f"kỳ nợ đang bị định giá {fee}đ, đơn giá tháng là {default_fee}đ — "
        "quãng chỉ tới mốc chốt mà thu trọn tháng"
    )


def test_them_tay_lai_noi_tiep_tu_han_cu(
    client: TestClient, auth_header: dict
) -> None:
    """Thêm tay lần hai cho email đang còn hạn = cộng dồn từ ĐIỂM NỐI (hạn cũ)."""
    ws = _ws(client, auth_header, name="Them Tay Noi WS", domain="ndaigroup.org")
    _switch_to_cycle_aligned(ws["id"], anchor_day=25)

    _manual_add(client, auth_header, ws["id"], "ct3@ndaigroup.org", 1)
    first, _ = _member_and_cycles(ws["id"], "ct3@ndaigroup.org")

    r = _manual_add(client, auth_header, ws["id"], "ct3@ndaigroup.org", 1)
    assert r.status_code == 201 and r.json()["renewed_count"] == 1

    second, cycles = _member_and_cycles(ws["id"], "ct3@ndaigroup.org")
    assert second["end_at"] > first["end_at"]
    assert second["end_at"].day == 25
    # Mốc neo = điểm nối = hạn cũ (§3.6.7), không phải lúc bấm nút.
    assert second["purchased_at"].replace(tzinfo=timezone.utc) == first["end_at"].replace(
        tzinfo=timezone.utc
    )
    assert len(cycles) == 2
    assert cycles[1]["start_at"].replace(tzinfo=timezone.utc) == first["end_at"].replace(
        tzinfo=timezone.utc
    )


def test_them_tay_khong_ghi_so_thang_thi_giu_nguyen_han(
    client: TestClient, auth_header: dict
) -> None:
    """`subscription_months` rỗng = VÔ THỜI HẠN, tuyệt đối không được cắt hạn đang có.

    Ca này đi thẳng qua API (modal luôn kẹp số nên không thấy được), và cắt nhầm là
    email rơi khỏi danh sách còn hạn rồi bị dọn."""
    for name, aligned in (("Vo Han Chu Ky WS", True), ("Vo Han Cu WS", False)):
        ws = _ws(client, auth_header, name=name, domain="ndaigroup.org")
        if aligned:
            _switch_to_cycle_aligned(ws["id"], anchor_day=_anchor_giua_chu_ky())

        _manual_add(client, auth_header, ws["id"], "ct6@ndaigroup.org", 1)
        truoc, _ = _member_and_cycles(ws["id"], "ct6@ndaigroup.org")
        assert truoc["end_at"] is not None

        r = client.post(
            f"/api/v1/workspaces/{ws['id']}/members/manual-add",
            json={"invites": [{"email": "ct6@ndaigroup.org", "subscription_months": None}]},
            headers=auth_header,
        )
        assert r.status_code == 201, r.text

        sau, _ = _member_and_cycles(ws["id"], "ct6@ndaigroup.org")
        assert sau["end_at"] == truoc["end_at"], f"{name}: hạn bị ghi đè"


def test_khong_gian_ba_muoi_ngay_giu_nguyen_cach_cu(
    client: TestClient, auth_header: dict
) -> None:
    """Đối chứng: không gian `legacy_30d` không được đổi một con số nào."""
    ws = _ws(client, auth_header, name="Them Tay Cu WS", domain="ndaigroup.org")

    before = datetime.now(timezone.utc)
    r = _manual_add(client, auth_header, ws["id"], "ct4@ndaigroup.org", 2)
    assert r.status_code == 201, r.text

    member, cycles = _member_and_cycles(ws["id"], "ct4@ndaigroup.org")
    expected = before + timedelta(days=60)
    assert abs(
        (member["end_at"].replace(tzinfo=timezone.utc) - expected).total_seconds()
    ) < 60
    assert cycles[0]["months"] == 2
    assert cycles[0]["prorated_half_days"] is None
