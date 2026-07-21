"""Tab 'Email đã add' — listing xuyên workspace + duyệt thanh toán 2 bước.

Bước 1: sub-admin gửi/rút yêu cầu (request-payment, unpaid <-> requested).
Bước 2: super-admin xác nhận/huỷ (mark-paid, -> paid / -> unpaid). Sub-admin
KHÔNG được mark-paid (403).
"""

from fastapi.testclient import TestClient


def _create_sub_admin(
    client: TestClient, auth_header: dict, *, username: str
) -> dict:
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


def _login(client: TestClient, identifier: str) -> dict:
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": identifier, "password": "SubPassword123!"},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _setup_workspace_with_sub(client: TestClient, auth_header: dict, *, username: str):
    ws = client.post(
        "/api/v1/workspaces",
        json={"name": f"WS {username}", "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()
    sub = _create_sub_admin(client, auth_header, username=username)
    assign = client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    assert assign.status_code in (200, 201), assign.text
    return ws, sub


def _invite(client: TestClient, headers: dict, ws_id: str, email: str) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _reset_unpaid(client: TestClient, auth_header: dict, member_id: str) -> None:
    """Mời giờ auto 'paid' (phí thu trước). Super-admin đặt lại 'unpaid' để các test
    dưới còn kiểm được luồng duyệt tay 2 bước (legacy, dùng cho dữ liệu cũ)."""
    resp = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [member_id], "paid": False},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text


def test_added_members_listing_and_default_paid(
    client: TestClient, auth_header: dict
) -> None:
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay1")
    sub_h = _login(client, "subpay1")
    _invite(client, sub_h, ws["id"], "buyer1@example.com")

    resp = client.get("/api/v1/added-members", headers=sub_h)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["email"] == "buyer1@example.com"
    # Mời = phí thu trước → ĐÃ THANH TOÁN ngay, không cần duyệt thủ công.
    assert rows[0]["payment_status"] == "paid"
    assert rows[0]["paid_at"] is not None
    assert rows[0]["workspace_name"] == ws["name"]


def test_sub_admin_request_and_withdraw(
    client: TestClient, auth_header: dict
) -> None:
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay2")
    sub_h = _login(client, "subpay2")
    m = _invite(client, sub_h, ws["id"], "buyer2@example.com")
    _reset_unpaid(client, auth_header, m["id"])

    # Bước 1: gửi yêu cầu duyệt → 'requested'
    req = client.post(
        "/api/v1/added-members/request-payment",
        json={"member_ids": [m["id"]], "requested": True},
        headers=sub_h,
    )
    assert req.status_code == 200, req.text
    assert req.json()["count"] == 1

    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert rows[0]["payment_status"] == "requested"
    assert rows[0]["payment_requested_at"] is not None
    assert rows[0]["paid_at"] is None

    # Gửi lại lần nữa: đã 'requested' → bỏ qua, count 0
    again = client.post(
        "/api/v1/added-members/request-payment",
        json={"member_ids": [m["id"]], "requested": True},
        headers=sub_h,
    )
    assert again.json()["count"] == 0

    # Rút yêu cầu → về 'unpaid'
    withdraw = client.post(
        "/api/v1/added-members/request-payment",
        json={"member_ids": [m["id"]], "requested": False},
        headers=sub_h,
    )
    assert withdraw.json()["count"] == 1
    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert rows[0]["payment_status"] == "unpaid"
    assert rows[0]["payment_requested_at"] is None


def test_sub_admin_cannot_mark_paid(client: TestClient, auth_header: dict) -> None:
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay5")
    sub_h = _login(client, "subpay5")
    m = _invite(client, sub_h, ws["id"], "buyer5@example.com")

    # Sub-admin KHÔNG được tự xác nhận thanh toán → 403, dù là email mình add.
    resp = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": True},
        headers=sub_h,
    )
    assert resp.status_code == 403, resp.text


def test_super_admin_confirms_payment(
    client: TestClient, auth_header: dict
) -> None:
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay6")
    sub_h = _login(client, "subpay6")
    m = _invite(client, sub_h, ws["id"], "buyer6@example.com")
    _reset_unpaid(client, auth_header, m["id"])

    # Sub gửi yêu cầu
    client.post(
        "/api/v1/added-members/request-payment",
        json={"member_ids": [m["id"]], "requested": True},
        headers=sub_h,
    )

    # Bước 2: super-admin xác nhận → 'paid'
    paid = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": True},
        headers=auth_header,
    )
    assert paid.status_code == 200, paid.text
    assert paid.json()["count"] == 1
    rows = client.get(
        f"/api/v1/added-members?user_id={_sub['id']}", headers=auth_header
    ).json()
    assert rows[0]["payment_status"] == "paid"
    assert rows[0]["paid_at"] is not None

    # Huỷ xác nhận → về 'unpaid' và xoá luôn dấu vết yêu cầu
    unpaid = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": False},
        headers=auth_header,
    )
    assert unpaid.json()["count"] == 1
    rows = client.get(
        f"/api/v1/added-members?user_id={_sub['id']}", headers=auth_header
    ).json()
    assert rows[0]["payment_status"] == "unpaid"
    assert rows[0]["paid_at"] is None
    assert rows[0]["payment_requested_at"] is None


def test_sub_admin_cannot_request_others_email(
    client: TestClient, auth_header: dict
) -> None:
    ws, _suba = _setup_workspace_with_sub(client, auth_header, username="subpayA")
    suba_h = _login(client, "subpayA")
    m = _invite(client, suba_h, ws["id"], "buyerA@example.com")
    _reset_unpaid(client, auth_header, m["id"])  # cô lập kiểm tra quyền sở hữu

    # Sub B (khác workspace) không được gửi yêu cầu cho email của Sub A → count 0.
    _wsb, _subb = _setup_workspace_with_sub(client, auth_header, username="subpayB")
    subb_h = _login(client, "subpayB")
    resp = client.post(
        "/api/v1/added-members/request-payment",
        json={"member_ids": [m["id"]], "requested": True},
        headers=subb_h,
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 0
    # Email vẫn unpaid khi Sub A xem
    rows = client.get("/api/v1/added-members", headers=suba_h).json()
    assert rows[0]["payment_status"] == "unpaid"


def test_pending_count_badge(client: TestClient, auth_header: dict) -> None:
    """Badge thông báo: super-admin đếm email 'requested'; sub-admin luôn 0."""
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpayC")
    sub_h = _login(client, "subpayC")
    m = _invite(client, sub_h, ws["id"], "buyerC@example.com")
    _reset_unpaid(client, auth_header, m["id"])

    # Chưa có yêu cầu nào → super-admin thấy 0.
    resp = client.get("/api/v1/added-members/pending-count", headers=auth_header)
    assert resp.status_code == 200, resp.text
    assert resp.json()["count"] == 0

    # Sub gửi yêu cầu → super-admin thấy 1; sub-admin luôn 0 (không duyệt).
    client.post(
        "/api/v1/added-members/request-payment",
        json={"member_ids": [m["id"]], "requested": True},
        headers=sub_h,
    )
    assert (
        client.get(
            "/api/v1/added-members/pending-count", headers=auth_header
        ).json()["count"]
        == 1
    )
    assert (
        client.get(
            "/api/v1/added-members/pending-count", headers=sub_h
        ).json()["count"]
        == 0
    )

    # Super xác nhận 'paid' → không còn chờ → 0.
    client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": True},
        headers=auth_header,
    )
    assert (
        client.get(
            "/api/v1/added-members/pending-count", headers=auth_header
        ).json()["count"]
        == 0
    )


def test_pending_requests_notice(client: TestClient, auth_header: dict) -> None:
    """Thông báo: super-admin thấy ai gửi + email gì; sub-admin thấy [] (không duyệt)."""
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpayD")
    sub_h = _login(client, "subpayD")
    m = _invite(client, sub_h, ws["id"], "buyerD@example.com")
    _reset_unpaid(client, auth_header, m["id"])

    # Chưa gửi → rỗng.
    assert (
        client.get(
            "/api/v1/added-members/pending-requests", headers=auth_header
        ).json()
        == []
    )

    client.post(
        "/api/v1/added-members/request-payment",
        json={"member_ids": [m["id"]], "requested": True},
        headers=sub_h,
    )
    notices = client.get(
        "/api/v1/added-members/pending-requests", headers=auth_header
    ).json()
    assert len(notices) == 1
    assert notices[0]["member_id"] == m["id"]
    assert notices[0]["email"] == "buyerd@example.com"
    assert notices[0]["requested_by_username"] == "subpayD"
    assert notices[0]["requested_at"] is not None

    # Sub-admin không phải super → không thấy thông báo nào.
    assert (
        client.get("/api/v1/added-members/pending-requests", headers=sub_h).json()
        == []
    )

    # Xác nhận nhanh từ thông báo (mark-paid 1 email) → biến mất khỏi danh sách.
    client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [m["id"]], "paid": True},
        headers=auth_header,
    )
    assert (
        client.get(
            "/api/v1/added-members/pending-requests", headers=auth_header
        ).json()
        == []
    )


def test_super_admin_can_view_per_sub_account(
    client: TestClient, auth_header: dict
) -> None:
    ws, sub = _setup_workspace_with_sub(client, auth_header, username="subpay3")
    sub_h = _login(client, "subpay3")
    _invite(client, sub_h, ws["id"], "buyer3@example.com")

    # Super-admin lọc theo user_id của sub
    resp = client.get(
        f"/api/v1/added-members?user_id={sub['id']}", headers=auth_header
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["email"] == "buyer3@example.com"


def test_removed_email_not_listed(client: TestClient, auth_header: dict) -> None:
    from uuid import UUID

    from app.db import SessionLocal
    from app.models import Member

    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subpay4")
    sub_h = _login(client, "subpay4")
    m = _invite(client, sub_h, ws["id"], "buyer4@example.com")

    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert any(r["id"] == m["id"] for r in rows)

    # Email bị xoá khỏi team (status=removed) → không còn hiển thị trong tab.
    db = SessionLocal()
    try:
        member = db.get(Member, UUID(m["id"]))
        member.status = "removed"
        db.commit()
    finally:
        db.close()

    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    assert all(r["id"] != m["id"] for r in rows)


def test_bulk_set_expiry_super_admin(client: TestClient, auth_header: dict) -> None:
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subexp1")
    sub_h = _login(client, "subexp1")
    m = _invite(client, sub_h, ws["id"], "buyerexp1@example.com")

    end_at = "2026-08-15T23:59:59+00:00"
    resp = client.post(
        "/api/v1/added-members/bulk-set-expiry",
        json={"items": [{"member_id": m["id"], "end_at": end_at}]},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["count"] == 1

    rows = client.get("/api/v1/added-members", headers=auth_header).json()
    row = next(r for r in rows if r["id"] == m["id"])
    assert row["subscription_end_at"].startswith("2026-08-15")
    # Chốt hạn = chuyển sang mốc ngày cụ thể → subscription_months về None.
    assert row["subscription_months"] is None


def test_bulk_set_expiry_sub_admin_creates_request(
    client: TestClient, auth_header: dict
) -> None:
    """Sub-admin KHÔNG áp ngay → tạo yêu cầu đổi hạn chờ super-admin duyệt."""
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subexp2")
    sub_h = _login(client, "subexp2")
    m = _invite(client, sub_h, ws["id"], "buyerexp2@example.com")
    original_end = next(
        r
        for r in client.get("/api/v1/added-members", headers=sub_h).json()
        if r["id"] == m["id"]
    )["subscription_end_at"]

    end_at = "2026-08-15T23:59:59+00:00"
    resp = client.post(
        "/api/v1/added-members/bulk-set-expiry",
        json={"items": [{"member_id": m["id"], "end_at": end_at}]},
        headers=sub_h,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["count"] == 1
    assert body["requested"] is True

    # Chưa áp: hạn hiện tại GIỮ NGUYÊN, status='requested', giá trị mới nằm ở pending.
    rows = client.get("/api/v1/added-members", headers=sub_h).json()
    row = next(r for r in rows if r["id"] == m["id"])
    assert row["subscription_request_status"] == "requested"
    assert row["subscription_end_at"] == original_end
    assert row["pending_subscription_end_at"].startswith("2026-08-15")

    # Super-admin thấy yêu cầu trong danh sách chờ duyệt.
    pending = client.get(
        "/api/v1/subscription-requests/pending", headers=auth_header
    ).json()
    assert any(p["member_id"] == m["id"] for p in pending)

    # Duyệt → áp pending vào subscription_end_at, clear request.
    approve = client.post(
        "/api/v1/subscription-requests/approve",
        json={"member_ids": [m["id"]], "approve": True},
        headers=auth_header,
    )
    assert approve.status_code == 200, approve.text
    row2 = next(
        r
        for r in client.get("/api/v1/added-members", headers=auth_header).json()
        if r["id"] == m["id"]
    )
    assert row2["subscription_end_at"].startswith("2026-08-15")
    assert row2["subscription_request_status"] == "none"


def test_bulk_set_expiry_sub_admin_skips_unowned(
    client: TestClient, auth_header: dict
) -> None:
    """Sub-admin chỉ đổi hạn email mình sở hữu — email của người khác bị bỏ qua."""
    ws, _sub = _setup_workspace_with_sub(client, auth_header, username="subexp3")
    # Email do super-admin add (không thuộc sub) → sub không được tạo yêu cầu.
    m = _invite(client, auth_header, ws["id"], "ownerless_exp@example.com")
    sub_h = _login(client, "subexp3")

    resp = client.post(
        "/api/v1/added-members/bulk-set-expiry",
        json={"items": [{"member_id": m["id"], "end_at": "2026-08-15T23:59:59+00:00"}]},
        headers=sub_h,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["count"] == 0  # bỏ qua vì không sở hữu
