"""Chu kỳ subscription — mô hình chốt user 2026-07-13.

**1 tháng = 1 chu kỳ**; phí (ví/QR) LUÔN thu TRƯỚC khi mời/gia hạn/đổi hạn nên chu
kỳ sinh ra là ĐÃ THANH TOÁN ngay — KHÔNG còn 'chưa thanh toán' / bước duyệt thủ công,
KHÔNG reset member khi gia hạn.

Xác minh:
  - Sub-admin TỰ gia hạn (POST .../renew) → áp NGAY, không tạo yêu cầu duyệt.
  - Gia hạn N tháng → nối N chu kỳ 1-tháng, tất cả 'paid'; member giữ 'paid'.
  - Đổi hạn (PATCH .../subscription) ĐỒNG BỘ chu kỳ theo hạn mới (bug user báo: trước
    đây đổi hạn không đụng chu kỳ → "Kỳ thanh toán" kẹt ở cửa sổ cũ):
      * kéo dài → nối kỳ mới; rút ngắn → cắt kỳ; vô thời hạn → xoá hết kỳ.
"""

from datetime import datetime, timedelta

from fastapi.testclient import TestClient


def _create_sub_admin(client, auth_header, *, username):
    resp = client.post(
        "/api/v1/users",
        json={
            "username": username,
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE"],
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login(client, identifier):
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": identifier, "password": "SubPassword123!"},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _create_ws(client, auth_header, name="Cycle WS"):
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _assign(client, auth_header, ws_id, user_id):
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id},
        headers=auth_header,
    )
    assert resp.status_code in (200, 201), resp.text


def _invite(client, ws_id, headers, email, months=1):
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", "subscription_months": months},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _renew(client, ws_id, member_id, headers, months):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/renew",
        json={"months": months},
        headers=headers,
    )


def _patch_sub(client, ws_id, member_id, headers, body):
    return client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json=body,
        headers=headers,
    )


def _added_row(client, headers, member_id):
    rows = client.get("/api/v1/added-members", headers=headers).json()
    return next(r for r in rows if r["id"] == member_id)


def _cycles(client, headers, member_id):
    row = _added_row(client, headers, member_id)
    return sorted(row["cycles"], key=lambda c: c["cycle_number"])


def test_sub_admin_can_self_renew_without_approval(
    client: TestClient, auth_header: dict
):
    """Gia hạn tự phục vụ: sub-admin renew → áp NGAY, giữ 'đã thanh toán', không duyệt."""
    ws = _create_ws(client, auth_header)
    sub = _create_sub_admin(client, auth_header, username="cyc_sub")
    _assign(client, auth_header, ws["id"], sub["id"])
    sub_h = _login(client, "cyc_sub")
    member = _invite(client, ws["id"], sub_h, "self@example.com", months=1)

    resp = _renew(client, ws["id"], member["id"], sub_h, 3)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["subscription_request_status"] == "none"
    assert out["subscription_months"] == 3
    # Mô hình mới: KHÔNG reset về unpaid — phí thu trước = đã thanh toán.
    assert out["payment_status"] == "paid"

    cnt = client.get(
        "/api/v1/subscription-requests/pending-count", headers=auth_header
    ).json()
    assert cnt["count"] == 0


def test_renew_stacks_expiry_and_appends_one_grouped_cycle(
    client: TestClient, auth_header: dict
):
    """Gia hạn 2 tháng → hạn +60 ngày; nối ĐÚNG 1 kỳ gộp (months=2), KHÔNG tách lẻ
    (kèm kỳ vật chất hoá của lần mời months=1) — tất cả 'đã thanh toán'."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "stack@example.com", months=1)
    old_end = datetime.fromisoformat(member["subscription_end_at"])

    resp = _renew(client, ws["id"], member["id"], auth_header, 2)
    assert resp.status_code == 200, resp.text
    new_end = datetime.fromisoformat(resp.json()["subscription_end_at"])
    assert new_end == old_end + timedelta(days=2 * 30)

    # 2 kỳ: kỳ 1 (vật chất hoá lần mời, months=1) + kỳ 2 (gia hạn gộp, months=2).
    cycles = _cycles(client, auth_header, member["id"])
    assert [c["cycle_number"] for c in cycles] == [1, 2]
    assert [c["months"] for c in cycles] == [1, 2]
    assert all(c["payment_status"] == "paid" for c in cycles)
    # Kỳ cuối kết thúc ĐÚNG bằng hạn dùng của member (không lệch).
    assert datetime.fromisoformat(cycles[-1]["end_at"]) == new_end


def test_renew_keeps_member_and_cycles_paid(client: TestClient, auth_header: dict):
    """Email đang 'đã thanh toán' mà gia hạn → VẪN 'đã thanh toán' (không reset)."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "paid@example.com", months=1)

    resp = _renew(client, ws["id"], member["id"], auth_header, 1)
    assert resp.status_code == 200, resp.text
    assert resp.json()["payment_status"] == "paid"

    cycles = _cycles(client, auth_header, member["id"])
    assert len(cycles) == 2
    assert all(c["payment_status"] == "paid" for c in cycles)
    assert _added_row(client, auth_header, member["id"])["payment_status"] == "paid"


def test_change_subscription_extend_appends_cycles(
    client: TestClient, auth_header: dict
):
    """Đổi hạn KÉO DÀI (cộng dồn theo tháng) → nối kỳ mới đã thanh toán; kỳ cuối khớp
    hạn mới (bug user báo: trước đây đổi hạn không đụng chu kỳ)."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "ext@example.com", months=1)
    old_end = datetime.fromisoformat(member["subscription_end_at"])

    resp = _patch_sub(
        client, ws["id"], member["id"], auth_header, {"subscription_months": 2}
    )
    assert resp.status_code == 200, resp.text
    new_end = datetime.fromisoformat(resp.json()["subscription_end_at"])
    assert new_end == old_end + timedelta(days=2 * 30)

    cycles = _cycles(client, auth_header, member["id"])
    # Kỳ 1 (vật chất hoá months=1) + 1 kỳ kéo dài GỘP (months=2) = 2 kỳ, đều đã TT.
    assert [c["cycle_number"] for c in cycles] == [1, 2]
    assert [c["months"] for c in cycles] == [1, 2]
    assert all(c["payment_status"] == "paid" for c in cycles)
    # Kỳ cuối kết thúc ĐÚNG bằng hạn dùng mới — không còn kẹt ở cửa sổ cũ.
    assert datetime.fromisoformat(cycles[-1]["end_at"]) == new_end


def test_change_subscription_shorten_trims_cycle(
    client: TestClient, auth_header: dict
):
    """Đổi hạn RÚT NGẮN (đặt ngày sớm hơn): kỳ mua gộp bị CẮT về hạn mới (vẫn 1 kỳ,
    months cập nhật theo cửa sổ mới), không sinh thêm kỳ."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "short@example.com", months=3)
    old_end = datetime.fromisoformat(member["subscription_end_at"])
    new_end = old_end - timedelta(days=45)  # 3 tháng → còn ~1.5 tháng

    resp = _patch_sub(
        client,
        ws["id"],
        member["id"],
        auth_header,
        {"subscription_end_at": new_end.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    assert datetime.fromisoformat(resp.json()["subscription_end_at"]) == new_end

    cycles = _cycles(client, auth_header, member["id"])
    # Mua gộp 3 tháng = 1 kỳ; rút ngắn chỉ CẮT cửa sổ, vẫn 1 kỳ.
    assert len(cycles) == 1
    assert cycles[0]["payment_status"] == "paid"
    assert datetime.fromisoformat(cycles[0]["end_at"]) == new_end


def test_change_subscription_unlimited_clears_cycles(
    client: TestClient, auth_header: dict
):
    """Đổi hạn VÔ THỜI HẠN → xoá hết chu kỳ (vô hạn không có kỳ tính tiền)."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "unl@example.com", months=2)

    resp = _patch_sub(client, ws["id"], member["id"], auth_header, {})
    assert resp.status_code == 200, resp.text
    assert resp.json()["subscription_end_at"] is None

    cycles = _cycles(client, auth_header, member["id"])
    assert cycles == []


def test_cycles_cover_full_remaining_term_when_anchor_in_future(
    client: TestClient, auth_header: dict
):
    """Mốc gia hạn rơi vào TƯƠNG LAI (dữ liệu chỉnh tay) mà member còn hạn → kỳ phải
    phủ TỪ HÔM NAY tới hạn, không để khoảng còn-hạn nào trống (chốt user 2026-07-13)."""
    import uuid as _uuid
    from datetime import timezone

    from app.db import SessionLocal
    from app.models import Member as _Member

    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "future@example.com", months=1)

    now = datetime.now(timezone.utc)
    future_anchor = now + timedelta(days=59)  # mốc gia hạn (bị tính lại) ở tương lai
    end = now + timedelta(days=89)  # còn hạn 89 ngày
    with SessionLocal() as db:
        m = db.get(_Member, _uuid.UUID(member["id"]))
        m.subscription_cycles = []  # legacy: có ngày nhưng CHƯA có kỳ (mời giờ tạo sẵn 1 kỳ)
        m.joined_at = now  # ngày tham gia = hôm nay (mốc neo kỳ 1)
        m.subscription_purchased_at = future_anchor
        m.subscription_end_at = end
        m.subscription_months = 1
        db.commit()

    # Đổi hạn "theo ngày" giữ nguyên hạn → kích hoạt vật chất hoá kỳ (member chưa có kỳ).
    resp = _patch_sub(
        client,
        ws["id"],
        member["id"],
        auth_header,
        {"subscription_end_at": end.isoformat()},
    )
    assert resp.status_code == 200, resp.text

    cycles = _cycles(client, auth_header, member["id"])
    # 1 kỳ GỘP phủ [hôm nay → hạn]; KỲ bắt đầu ~ HÔM NAY (không phải mốc tương lai),
    # months suy từ cửa sổ ~ 89/30 ≈ 3.
    assert len(cycles) == 1
    first_start = datetime.fromisoformat(cycles[0]["start_at"])
    assert abs((first_start - now).total_seconds()) < 300
    assert cycles[0]["months"] == 3
    assert cycles[0]["payment_status"] == "paid"
    assert datetime.fromisoformat(cycles[0]["end_at"]) == end
