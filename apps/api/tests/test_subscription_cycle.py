"""Gia hạn tự phục vụ + chu kỳ + thanh toán theo chu kỳ (yêu cầu user 2026-07-08).

Xác minh:
  - Sub-admin TỰ gia hạn (POST .../renew) → áp NGAY, KHÔNG cần duyệt.
  - Mỗi lần gia hạn = 1 CHU KỲ mới, luôn 'unpaid'; member reset về 'chưa thanh toán'
    kể cả trước đó đã 'paid'.
  - Chu kỳ 1 'unpaid' → gia hạn → chu kỳ 2 vẫn 'unpaid' (member tổng hợp = unpaid).
  - Xác nhận thanh toán theo TỪNG chu kỳ (cycle_ids); member 'paid' chỉ khi MỌI kỳ paid.
  - Gia hạn cộng dồn hạn (còn hạn → hạn cũ + N×30).
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


def _added_row(client, headers, member_id):
    rows = client.get("/api/v1/added-members", headers=headers).json()
    return next(r for r in rows if r["id"] == member_id)


def _cycles(client, headers, member_id):
    row = _added_row(client, headers, member_id)
    return sorted(row["cycles"], key=lambda c: c["cycle_number"])


def test_sub_admin_can_self_renew_without_approval(
    client: TestClient, auth_header: dict
):
    """Gia hạn là quyền tự phục vụ: sub-admin renew → áp NGAY, không tạo yêu cầu duyệt."""
    ws = _create_ws(client, auth_header)
    sub = _create_sub_admin(client, auth_header, username="cyc_sub")
    _assign(client, auth_header, ws["id"], sub["id"])
    sub_h = _login(client, "cyc_sub")
    member = _invite(client, ws["id"], sub_h, "self@example.com", months=1)

    resp = _renew(client, ws["id"], member["id"], sub_h, 3)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    # Áp NGAY (không phải 'requested').
    assert out["subscription_request_status"] == "none"
    assert out["subscription_months"] == 3
    assert out["payment_status"] == "unpaid"

    # KHÔNG tạo yêu cầu đổi hạn chờ duyệt.
    cnt = client.get(
        "/api/v1/subscription-requests/pending-count", headers=auth_header
    ).json()
    assert cnt["count"] == 0


def test_renew_stacks_expiry_and_creates_cycle(
    client: TestClient, auth_header: dict
):
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "stack@example.com", months=1)
    old_end = datetime.fromisoformat(member["subscription_end_at"])

    resp = _renew(client, ws["id"], member["id"], auth_header, 2)
    assert resp.status_code == 200, resp.text
    new_end = datetime.fromisoformat(resp.json()["subscription_end_at"])
    assert new_end == old_end + timedelta(days=2 * 30)

    # 2 chu kỳ: kỳ 1 (vật chất hoá từ trạng thái invite) + kỳ 2 (vừa gia hạn).
    cycles = _cycles(client, auth_header, member["id"])
    assert [c["cycle_number"] for c in cycles] == [1, 2]
    assert cycles[1]["months"] == 2
    assert cycles[1]["payment_status"] == "unpaid"


def test_paid_email_resets_to_unpaid_on_renew(
    client: TestClient, auth_header: dict
):
    """Email đang 'đã thanh toán' mà gia hạn → member về 'chưa thanh toán'; kỳ cũ giữ paid."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "paid@example.com", months=1)

    # Xác nhận đã thanh toán (kỳ đầu).
    client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [member["id"]], "paid": True},
        headers=auth_header,
    )
    assert _added_row(client, auth_header, member["id"])["payment_status"] == "paid"

    # Gia hạn → reset member về unpaid.
    resp = _renew(client, ws["id"], member["id"], auth_header, 1)
    assert resp.status_code == 200, resp.text
    assert resp.json()["payment_status"] == "unpaid"

    cycles = _cycles(client, auth_header, member["id"])
    assert len(cycles) == 2
    assert cycles[0]["payment_status"] == "paid"   # kỳ 1 giữ lịch sử đã trả
    assert cycles[1]["payment_status"] == "unpaid"  # kỳ 2 chưa trả


def test_unpaid_cycle1_stays_unpaid_after_renew(
    client: TestClient, auth_header: dict
):
    """Chu kỳ 1 chưa thanh toán → gia hạn → chu kỳ 2 vẫn chưa thanh toán."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "carry@example.com", months=1)

    _renew(client, ws["id"], member["id"], auth_header, 1)
    cycles = _cycles(client, auth_header, member["id"])
    assert len(cycles) == 2
    assert all(c["payment_status"] == "unpaid" for c in cycles)
    assert _added_row(client, auth_header, member["id"])["payment_status"] == "unpaid"


def test_per_cycle_mark_paid(client: TestClient, auth_header: dict):
    """Xác nhận theo từng chu kỳ: member 'paid' CHỈ khi MỌI kỳ đã trả."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, "percycle@example.com", months=1)
    _renew(client, ws["id"], member["id"], auth_header, 1)
    cycles = _cycles(client, auth_header, member["id"])
    c1, c2 = cycles[0]["id"], cycles[1]["id"]

    # Trả kỳ 1 → member vẫn unpaid (kỳ 2 chưa trả).
    resp = client.post(
        "/api/v1/added-members/mark-paid",
        json={"cycle_ids": [c1], "paid": True},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["count"] == 1
    cycles = _cycles(client, auth_header, member["id"])
    assert cycles[0]["payment_status"] == "paid"
    assert cycles[1]["payment_status"] == "unpaid"
    assert _added_row(client, auth_header, member["id"])["payment_status"] == "unpaid"

    # Trả nốt kỳ 2 → member 'paid'.
    client.post(
        "/api/v1/added-members/mark-paid",
        json={"cycle_ids": [c2], "paid": True},
        headers=auth_header,
    )
    assert _added_row(client, auth_header, member["id"])["payment_status"] == "paid"


def test_per_cycle_request_payment_by_sub_admin(
    client: TestClient, auth_header: dict
):
    """Sub-admin gửi yêu cầu duyệt cho MỘT chu kỳ cụ thể → kỳ đó 'requested'."""
    ws = _create_ws(client, auth_header)
    sub = _create_sub_admin(client, auth_header, username="cyc_req")
    _assign(client, auth_header, ws["id"], sub["id"])
    sub_h = _login(client, "cyc_req")
    member = _invite(client, ws["id"], sub_h, "req@example.com", months=1)
    _renew(client, ws["id"], member["id"], sub_h, 1)
    cycles = _cycles(client, sub_h, member["id"])
    c2 = cycles[1]["id"]

    resp = client.post(
        "/api/v1/added-members/request-payment",
        json={"cycle_ids": [c2], "requested": True},
        headers=sub_h,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["count"] == 1
    cycles = _cycles(client, sub_h, member["id"])
    assert cycles[1]["payment_status"] == "requested"
    assert cycles[1]["payment_requested_at"] is not None


def test_sub_admin_cannot_request_others_cycle(
    client: TestClient, auth_header: dict
):
    """Sub B không gửi yêu cầu được cho chu kỳ email của Sub A (không sở hữu)."""
    ws = _create_ws(client, auth_header)
    suba = _create_sub_admin(client, auth_header, username="cyc_a")
    _assign(client, auth_header, ws["id"], suba["id"])
    suba_h = _login(client, "cyc_a")
    member = _invite(client, ws["id"], suba_h, "owned@example.com", months=1)
    _renew(client, ws["id"], member["id"], suba_h, 1)
    c2 = _cycles(client, suba_h, member["id"])[1]["id"]

    _create_sub_admin(client, auth_header, username="cyc_b")
    subb_h = _login(client, "cyc_b")
    resp = client.post(
        "/api/v1/added-members/request-payment",
        json={"cycle_ids": [c2], "requested": True},
        headers=subb_h,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["count"] == 0
