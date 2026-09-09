"""Màn hình gia hạn phải hiện ĐÚNG hạn mới và ĐÚNG số tiền sẽ trừ.

VÌ SAO CÓ FILE NÀY: web từng tự tính `hạn cũ + tháng×30` và `đơn giá × số tháng` cho
cả ô gia hạn lẻ lẫn popup gia hạn hàng loạt. Ở không gian chốt theo chu kỳ hoá đơn thì
hạn rơi đúng MỐC CHỐT và tiền tính theo số ngày thật từ điểm nối tới mốc đó
(EXPIRY_RULES §3.6) — hai con số trên màn hình đều sai, mà sai im lặng: người bán báo
giá với khách xong bấm nút mới ra số khác.

`/members/renew-preview` là chỗ DUY NHẤT web hỏi hai con số đó. Test khoá hai việc:
  1. Số của bản xem trước TRÙNG KHÍT số của lệnh gia hạn thật.
  2. Chọn nhiều dòng thì từng dòng ra số của chính nó, và id lạ không làm hỏng cả bảng.
"""

from __future__ import annotations

import uuid
from datetime import datetime, time as dtime, timedelta, timezone

from fastapi.testclient import TestClient

from tests.wallet_helpers import create_ws, set_settings

UTC = timezone.utc
ANCHOR_DAY = 1
CUTOFF = dtime(3, 0)
UNIT_VND = 330_000


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


def _member(
    client: TestClient,
    header: dict,
    ws_id: str,
    email: str,
    *,
    end_at: datetime | None,
) -> str:
    """Mời 1 email rồi ép về ACTIVE kèm hạn mong muốn (ca gia hạn thật hay gặp)."""
    from app.db import SessionLocal
    from app.models import Member

    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "subscription_months": 1, "role": "member"},
        headers=header,
    )
    assert resp.status_code == 201, resp.text
    member_id = resp.json()["id"]
    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(member_id))
        row.status = "active"
        row.subscription_end_at = end_at
        db.commit()
    return member_id


def _preview(
    client: TestClient,
    header: dict,
    ws_id: str,
    member_ids: list[str],
    months: int = 1,
    **extra,
) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/renew-preview",
        json={"member_ids": member_ids, "months": months, **extra},
        headers=header,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _to(item: dict) -> datetime:
    return datetime.fromisoformat(item["to"]).astimezone(UTC)


def _next_anchor(after: datetime) -> datetime:
    """Mốc thanh toán gần nhất SAU `after` — tính tay để test không mượn lại chính
    hàm đang được kiểm."""
    at = datetime(after.year, after.month, ANCHOR_DAY, CUTOFF.hour, 0, tzinfo=UTC)
    if at <= after:
        y, m = (at.year + 1, 1) if at.month == 12 else (at.year, at.month + 1)
        at = datetime(y, m, ANCHOR_DAY, CUTOFF.hour, 0, tzinfo=UTC)
    return at


def test_han_gia_han_roi_dung_moc_chot(client: TestClient, auth_header: dict) -> None:
    """Không gian chốt theo chu kỳ: gia hạn 1 tháng = đi tới MỐC CHỐT kế tiếp, không
    phải cộng 30 ngày vào hạn cũ."""
    ws = create_ws(client, auth_header, "RENEW-PREV-CYCLE")
    _switch_to_cycle(client, auth_header, ws["id"])
    old_end = datetime.now(UTC) + timedelta(days=5)
    mid = _member(client, auth_header, ws["id"], "cyc@example.com", end_at=old_end)

    item = _preview(client, auth_header, ws["id"], [mid])["items"][0]
    end = _to(item)

    assert end.day == ANCHOR_DAY, f"hạn phải rơi ngày chốt, đang ra {end.isoformat()}"
    assert (end.hour, end.minute) == (CUTOFF.hour, CUTOFF.minute)
    assert end > old_end, "gia hạn phải nối TIẾP hạn cũ"
    assert abs((end - (old_end + timedelta(days=30))).total_seconds()) > 3600, (
        "hạn mới không được là phép cộng 30 ngày — đó chính là con số sai cũ"
    )
    # ĐIỂM NỐI = hạn cũ (còn hạn) → không thu trùng phần khách đã trả.
    assert datetime.fromisoformat(item["from"]).astimezone(UTC) == old_end


def test_xem_truoc_trung_khit_voi_lenh_that(
    client: TestClient, auth_header: dict
) -> None:
    """Con số bày ra trước khi bấm phải là con số sau khi bấm — cả hạn lẫn phân rã
    chu kỳ. Đây là lý do endpoint xem trước đi qua chính hàm của lệnh thật."""
    ws = create_ws(client, auth_header, "RENEW-PREV-MATCH")
    _switch_to_cycle(client, auth_header, ws["id"])
    mid = _member(
        client,
        auth_header,
        ws["id"],
        "match@example.com",
        end_at=datetime.now(UTC) + timedelta(days=3),
    )

    item = _preview(client, auth_header, ws["id"], [mid])["items"][0]
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{mid}/renew",
        json={"months": 1},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    applied = datetime.fromisoformat(resp.json()["subscription_end_at"]).astimezone(UTC)

    assert _to(item) == applied


def test_tien_tinh_theo_so_ngay_that(client: TestClient, auth_header: dict) -> None:
    """Gia hạn giữa chu kỳ thì chỉ trả phần lẻ tới mốc chốt, KHÔNG trọn một đơn giá."""
    set_settings(client, auth_header, invite_fee_vnd=UNIT_VND)
    ws = create_ws(client, auth_header, "RENEW-PREV-FEE")
    _switch_to_cycle(client, auth_header, ws["id"])
    mid = _member(
        client,
        auth_header,
        ws["id"],
        "fee@example.com",
        end_at=datetime.now(UTC) + timedelta(days=2),
    )

    body = _preview(client, auth_header, ws["id"], [mid])
    item = body["items"][0]

    assert item["unit_price_vnd"] == UNIT_VND
    assert body["total_fee"] == item["fee"]
    # Phân rã để giải thích với khách: mấy nửa ngày trên chu kỳ mấy ngày.
    assert item["prorated_half_days"] > 0
    assert 28 <= item["cycle_days"] <= 31
    assert item["whole_months"] == 0
    # Phần lẻ luôn RẺ HƠN một chu kỳ trọn (và lớn hơn 0) — con số web từng hiện là
    # nguyên một đơn giá.
    assert 0 < item["fee"] < UNIT_VND


def test_khong_gian_ba_muoi_ngay_van_ra_so_cu(
    client: TestClient, auth_header: dict
) -> None:
    """Chế độ `legacy_30d` không đổi: hạn cũ + tháng×30, phí = đơn giá × số tháng."""
    set_settings(client, auth_header, invite_fee_vnd=UNIT_VND)
    ws = create_ws(client, auth_header, "RENEW-PREV-LEGACY")
    old_end = datetime.now(UTC) + timedelta(days=4)
    mid = _member(client, auth_header, ws["id"], "legacy@example.com", end_at=old_end)

    item = _preview(client, auth_header, ws["id"], [mid], months=2)["items"][0]

    assert abs((_to(item) - (old_end + timedelta(days=60))).total_seconds()) < 2
    assert item["fee"] == UNIT_VND * 2
    assert "cycle_days" not in item, "chế độ 30 ngày không có chu kỳ để nói tới"


def test_hang_loat_moi_dong_mot_so_va_id_la_khong_pha_bang(
    client: TestClient, auth_header: dict
) -> None:
    """Gia hạn hàng loạt: từng dòng ra hạn của chính nó; id không thuộc không gian
    này rơi vào `missing` chứ không làm hỏng số tiền của các dòng còn lại."""
    set_settings(client, auth_header, invite_fee_vnd=UNIT_VND)
    ws = create_ws(client, auth_header, "RENEW-PREV-BULK")
    _switch_to_cycle(client, auth_header, ws["id"])
    som = _member(
        client,
        auth_header,
        ws["id"],
        "som@example.com",
        end_at=datetime.now(UTC) + timedelta(days=2),
    )
    # Hạn còn xa hơn một mốc → điểm nối muộn hơn, hạn mới nhảy sang mốc sau.
    xa = _member(
        client,
        auth_header,
        ws["id"],
        "xa@example.com",
        end_at=datetime.now(UTC) + timedelta(days=45),
    )
    la = str(uuid.uuid4())

    body = _preview(client, auth_header, ws["id"], [som, xa, la])

    assert body["missing"] == [la]
    assert [i["member_id"] for i in body["items"]] == [som, xa]
    assert body["total_fee"] == sum(i["fee"] for i in body["items"])
    assert _to(body["items"][1]) > _to(body["items"][0]), (
        "hai dòng hạn khác nhau phải ra hai mốc khác nhau"
    )


def test_moc_neo_chi_danh_cho_mot_email(client: TestClient, auth_header: dict) -> None:
    """`purchased_at` là mốc của MỘT email (màn hình sửa "Ngày gia hạn") — gửi kèm cả
    mẻ là hỏi một câu không màn hình nào cần, chặn thẳng cho khỏi tin nhầm."""
    ws = create_ws(client, auth_header, "RENEW-PREV-ANCHOR")
    a = _member(
        client,
        auth_header,
        ws["id"],
        "a@example.com",
        end_at=datetime.now(UTC) + timedelta(days=3),
    )
    b = _member(
        client,
        auth_header,
        ws["id"],
        "b@example.com",
        end_at=datetime.now(UTC) + timedelta(days=3),
    )
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/renew-preview",
        json={
            "member_ids": [a, b],
            "months": 1,
            "purchased_at": datetime.now(UTC).isoformat(),
        },
        headers=auth_header,
    )
    assert resp.status_code == 422, resp.text


def test_khach_da_hoi_tu_gia_han_lan_toi_tra_tron_mot_thang(
    client: TestClient, auth_header: dict
) -> None:
    """Email cũ sau MỘT vòng gia hạn thì hạn đã rơi đúng ngày thanh toán của không
    gian. Lần gia hạn KẾ TIẾP phải là một chu kỳ TRỌN: đi tới mốc sau, thu đúng một
    đơn giá, không còn phần lẻ nào (EXPIRY_RULES §3.6.2 — dòng "gia hạn đúng mốc").

    Đây là ca người dùng hỏi thẳng: khách cũ lần tới phải trả theo đúng cách tính
    đang chạy, không phải giá của mô hình 30 ngày."""
    set_settings(client, auth_header, invite_fee_vnd=UNIT_VND)
    ws = create_ws(client, auth_header, "RENEW-PREV-CONVERGED")
    _switch_to_cycle(client, auth_header, ws["id"])
    moc = _next_anchor(datetime.now(UTC))
    mid = _member(client, auth_header, ws["id"], "hoitu@example.com", end_at=moc)

    item = _preview(client, auth_header, ws["id"], [mid])["items"][0]

    assert item["prorated_half_days"] == 0, "đã hội tụ thì không còn ngày lẻ nào"
    assert item["whole_months"] == 1
    assert item["fee"] == UNIT_VND, "một chu kỳ trọn = đúng một đơn giá"
    end = _to(item)
    assert end.day == ANCHOR_DAY and (end.hour, end.minute) == (CUTOFF.hour, CUTOFF.minute)
    assert timedelta(days=28) <= end - moc <= timedelta(days=31), (
        "phải nhảy đúng MỘT tháng dương lịch, không phải 30 ngày cứng"
    )
