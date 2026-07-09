"""Subscription change approval — PATCH .../members/{id}/subscription + duyệt.

Xác minh quy tắc duyệt (theo yêu cầu user):
  - Sub-admin PATCH → KHÔNG áp ngay, tạo yêu cầu 'requested' + pending_* (real giữ nguyên).
  - Super-admin PATCH → áp dụng NGAY (tự duyệt), không tạo request.
  - Gia hạn CHỈ theo SỐ THÁNG (cộng dồn từ hạn hiện tại, giữ giờ) — không ngày lẻ.
  - Super-admin GET pending-count / pending; POST approve áp pending, reject clear.
  - approve chỉ super-admin (sub → 403).
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient


def _create_sub_admin(client, auth_header, *, email, username, permissions):
    resp = client.post(
        "/api/v1/users",
        json={
            "email": email,
            "username": username,
            "password": "SubPassword123!",
            "permissions": permissions,
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login(client, identifier, password="SubPassword123!"):
    resp = client.post(
        "/api/v1/auth/login", json={"identifier": identifier, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def _create_ws(client, auth_header):
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Sub WS", "plan": "business", "seat_total": 50},
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


def _invite(client, ws_id, headers, email="cust@example.com", months=1):
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", "subscription_months": months},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _patch_sub(client, ws_id, member_id, headers, body):
    return client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json=body,
        headers=headers,
    )


def _sub_with_ws(client, auth_header):
    """Tạo sub-admin có MEMBER_VIEW+INVITE, gán 1 workspace, trả (sub, ws)."""
    ws = _create_ws(client, auth_header)
    user = _create_sub_admin(
        client,
        auth_header,
        email="sub@example.com",
        username="sub",
        permissions=["MEMBER_VIEW", "MEMBER_INVITE"],
    )
    token = _login(client, "sub")
    _assign(client, auth_header, ws["id"], user["id"])
    return {"id": user["id"], "token": token}, ws


def test_sub_admin_change_creates_pending_request(client: TestClient, auth_header: dict):
    sub, ws = _sub_with_ws(client, auth_header)
    sub_h = _bearer(sub["token"])
    member = _invite(client, ws["id"], sub_h, months=1)
    old_end = member["subscription_end_at"]

    resp = _patch_sub(client, ws["id"], member["id"], sub_h, {"subscription_months": 6})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    # KHÔNG áp dụng ngay: real giữ nguyên, request 'requested', pending = đề xuất.
    assert out["subscription_request_status"] == "requested"
    assert out["subscription_months"] == 1
    assert out["subscription_end_at"] == old_end
    assert out["pending_subscription_months"] == 6
    assert out["pending_subscription_end_at"] is not None

    # Super-admin thấy badge + danh sách.
    cnt = client.get(
        "/api/v1/subscription-requests/pending-count", headers=auth_header
    ).json()
    assert cnt["count"] == 1
    pending = client.get(
        "/api/v1/subscription-requests/pending", headers=auth_header
    ).json()
    assert len(pending) == 1
    assert pending[0]["member_id"] == member["id"]
    assert pending[0]["requested_months"] == 6
    assert pending[0]["requested_by_username"] == "sub"

    # Sub-admin KHÔNG thấy badge.
    sub_cnt = client.get(
        "/api/v1/subscription-requests/pending-count", headers=sub_h
    ).json()
    assert sub_cnt["count"] == 0


def test_super_admin_approve_applies_pending(client: TestClient, auth_header: dict):
    sub, ws = _sub_with_ws(client, auth_header)
    sub_h = _bearer(sub["token"])
    member = _invite(client, ws["id"], sub_h, months=1)
    _patch_sub(client, ws["id"], member["id"], sub_h, {"subscription_months": 9})

    resp = client.post(
        "/api/v1/subscription-requests/approve",
        json={"member_ids": [member["id"]], "approve": True},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"count": 1, "approve": True}

    # Real đã áp pending; request đã clear.
    m = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    row = next(x for x in m if x["id"] == member["id"])
    assert row["subscription_months"] == 9
    assert row["subscription_request_status"] == "none"
    assert row["pending_subscription_months"] is None


def test_reject_keeps_old_subscription(client: TestClient, auth_header: dict):
    sub, ws = _sub_with_ws(client, auth_header)
    sub_h = _bearer(sub["token"])
    member = _invite(client, ws["id"], sub_h, months=2)
    old_end = member["subscription_end_at"]
    _patch_sub(client, ws["id"], member["id"], sub_h, {"subscription_months": 24})

    resp = client.post(
        "/api/v1/subscription-requests/approve",
        json={"member_ids": [member["id"]], "approve": False},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["approve"] is False

    m = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    row = next(x for x in m if x["id"] == member["id"])
    assert row["subscription_months"] == 2
    assert row["subscription_end_at"] == old_end
    assert row["subscription_request_status"] == "none"


def test_super_admin_change_applies_immediately(client: TestClient, auth_header: dict):
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="direct@example.com", months=1)

    resp = _patch_sub(
        client, ws["id"], member["id"], auth_header, {"subscription_months": 12}
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["subscription_months"] == 12
    assert out["subscription_request_status"] == "none"

    # Không tạo yêu cầu chờ duyệt.
    cnt = client.get(
        "/api/v1/subscription-requests/pending-count", headers=auth_header
    ).json()
    assert cnt["count"] == 0


def test_renew_months_stacks_on_current_expiry(client: TestClient, auth_header: dict):
    """Gia hạn theo tháng CỘNG DỒN từ hạn hiện tại (còn hạn) + giữ giờ."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="stack@example.com", months=1)
    old_end = datetime.fromisoformat(member["subscription_end_at"])  # ≈ now + 30 (tương lai)

    resp = _patch_sub(
        client, ws["id"], member["id"], auth_header, {"subscription_months": 2}
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["subscription_months"] == 2
    # Hạn mới = hạn cũ + 2×30 ngày (giữ nguyên giờ:phút:giây của hạn cũ).
    new_end = datetime.fromisoformat(out["subscription_end_at"])
    assert new_end == old_end + timedelta(days=2 * 30)


def test_renew_months_from_now_when_expired(client: TestClient, auth_header: dict):
    """Email ĐÃ QUÁ HẠN → gia hạn tính từ BÂY GIỜ + N×30 (không cộng dồn quá khứ)."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="expired@example.com", months=1)
    # Ép hạn về quá khứ.
    import uuid as _uuid

    from app.db import SessionLocal
    from app.models import Member as _Member

    past = datetime.now(timezone.utc) - timedelta(days=10)
    with SessionLocal() as db:
        db.get(_Member, _uuid.UUID(member["id"])).subscription_end_at = past
        db.commit()

    before = datetime.now(timezone.utc)
    resp = _patch_sub(
        client, ws["id"], member["id"], auth_header, {"subscription_months": 1}
    )
    assert resp.status_code == 200, resp.text
    new_end = datetime.fromisoformat(resp.json()["subscription_end_at"])
    # Hết hạn + chỉ gửi số tháng → BÂY GIỜ + 1×30 ngày CHÍNH XÁC tới giây (không chốt
    # cuối ngày). Server tính now() ngay sau `before` → chênh vài ms, dùng tolerance.
    expected = before + timedelta(days=30)
    assert abs((new_end - expected).total_seconds()) < 5


def test_purchased_at_anchors_end(client: TestClient, auth_header: dict):
    """Modal Đổi hạn dùng gửi subscription_purchased_at + months → hạn = ngày mua +
    months×30 ngày CHÍNH XÁC (giữ giờ), và BE lưu lại ngày mua làm mốc neo."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="anchor@example.com", months=1)
    purchased = "2026-06-12T10:00:00+00:00"
    resp = _patch_sub(
        client,
        ws["id"],
        member["id"],
        auth_header,
        {"subscription_months": 2, "subscription_purchased_at": purchased},
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["subscription_months"] == 2
    # 12/06 10:00 + 60 ngày = 11/08 10:00 (chính xác, giữ giờ).
    end = datetime.fromisoformat(out["subscription_end_at"])
    assert end == datetime(2026, 8, 11, 10, 0, 0, tzinfo=timezone.utc)
    # Ngày mua được lưu lại (mốc neo, để mở lại modal hiển thị đúng).
    assert datetime.fromisoformat(out["subscription_purchased_at"]) == datetime(
        2026, 6, 12, 10, 0, 0, tzinfo=timezone.utc
    )


def test_explicit_end_at_applied(client: TestClient, auth_header: dict):
    """Modal "Đổi hạn dùng" gửi subscription_end_at (tính từ ngày mua + tháng×30) →
    BE ÁP TRỰC TIẾP (không cộng dồn), đồng thời lưu subscription_months kèm theo."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="explicit@example.com", months=1)
    resp = _patch_sub(
        client,
        ws["id"],
        member["id"],
        auth_header,
        {"subscription_months": 3, "subscription_end_at": "2027-03-15T23:59:59Z"},
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["subscription_months"] == 3
    # Dùng đúng ngày client gửi — KHÔNG cộng dồn từ hạn hiện tại.
    end = datetime.fromisoformat(out["subscription_end_at"])
    assert end == datetime(2027, 3, 15, 23, 59, 59, tzinfo=timezone.utc)


def test_date_only_preserves_months_and_anchor(
    client: TestClient, auth_header: dict
):
    """"Theo ngày cụ thể" (chỉ gửi subscription_end_at, KHÔNG gửi months) → đặt lại
    hạn nhưng GIỮ NGUYÊN subscription_months + subscription_purchased_at (mốc neo)."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="dateonly@example.com", months=2)
    anchor = member["subscription_purchased_at"]
    assert anchor is not None

    resp = _patch_sub(
        client,
        ws["id"],
        member["id"],
        auth_header,
        {"subscription_end_at": "2027-01-20T10:00:00Z"},
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    # Hạn đặt đúng ngày gửi.
    assert datetime.fromisoformat(out["subscription_end_at"]) == datetime(
        2027, 1, 20, 10, 0, 0, tzinfo=timezone.utc
    )
    # Số tháng & mốc neo KHÔNG bị xoá.
    assert out["subscription_months"] == 2
    assert out["subscription_purchased_at"] == anchor


def test_sub_admin_cannot_approve(client: TestClient, auth_header: dict):
    sub, ws = _sub_with_ws(client, auth_header)
    sub_h = _bearer(sub["token"])
    member = _invite(client, ws["id"], sub_h, months=1)
    _patch_sub(client, ws["id"], member["id"], sub_h, {"subscription_months": 6})

    resp = client.post(
        "/api/v1/subscription-requests/approve",
        json={"member_ids": [member["id"]], "approve": True},
        headers=sub_h,
    )
    assert resp.status_code == 403, resp.text


def test_invite_anchors_renewal_and_expiry_plus_30(
    client: TestClient, auth_header: dict
):
    """Mời lần đầu: mốc neo "Ngày gia hạn" (subscription_purchased_at) = giờ mời,
    hạn = mốc + 30 ngày CHÍNH XÁC (yêu cầu user: hết hạn = gia hạn + 30)."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="fresh@example.com", months=1)
    assert member["subscription_purchased_at"] is not None, member
    purchased = datetime.fromisoformat(member["subscription_purchased_at"])
    end = datetime.fromisoformat(member["subscription_end_at"])
    assert end == purchased + timedelta(days=30), (purchased, end)
    # Mốc neo ≈ bây giờ (giờ gửi lệnh mời, chính xác tới giây).
    assert abs((datetime.now(timezone.utc) - purchased).total_seconds()) < 120


def test_correct_add_date_once_recomputes_and_locks(
    client: TestClient, auth_header: dict
):
    """Super-admin sửa "Ngày gia hạn" 1 lần → mốc neo đổi, hạn = mốc mới + tháng×30,
    khoá add_date_corrected_at; lần 2 → 409."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="fix@example.com", months=2)
    assert member["add_date_corrected_at"] is None

    new_date = "2026-05-01T08:30:00+00:00"
    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/add-date",
        json={"add_date": new_date},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert datetime.fromisoformat(out["subscription_purchased_at"]) == datetime(
        2026, 5, 1, 8, 30, 0, tzinfo=timezone.utc
    )
    # months=2 → hạn = 1/5 08:30 + 60 ngày = 30/6 08:30 (chính xác).
    assert datetime.fromisoformat(out["subscription_end_at"]) == datetime(
        2026, 6, 30, 8, 30, 0, tzinfo=timezone.utc
    )
    assert out["add_date_corrected_at"] is not None

    # Lần 2 → khoá.
    resp2 = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/add-date",
        json={"add_date": "2026-04-01T00:00:00+00:00"},
        headers=auth_header,
    )
    assert resp2.status_code == 409, resp2.text


def test_correct_add_date_with_months_reanchors(
    client: TestClient, auth_header: dict
):
    """Modal Đổi hạn dùng gửi add_date + months → NEO lại: subscription_months = months,
    hạn = add_date + months×30 (KHÔNG cộng dồn), vẫn khoá 1 lần."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="reanchor@example.com", months=1)

    new_date = "2026-06-08T10:39:00+00:00"
    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/add-date",
        json={"add_date": new_date, "months": 3},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    # months bị NEO lại thành 3.
    assert out["subscription_months"] == 3
    assert datetime.fromisoformat(out["subscription_purchased_at"]) == datetime(
        2026, 6, 8, 10, 39, 0, tzinfo=timezone.utc
    )
    # hạn = 8/6 10:39 + 90 ngày = 6/9 10:39 (chính xác, không cộng dồn từ hạn cũ).
    assert datetime.fromisoformat(out["subscription_end_at"]) == datetime(
        2026, 9, 6, 10, 39, 0, tzinfo=timezone.utc
    )
    assert out["add_date_corrected_at"] is not None


def test_correct_add_date_sub_admin_forbidden(
    client: TestClient, auth_header: dict
):
    """Sub-admin KHÔNG được sửa ngày gia hạn (chỉ super-admin) → 403."""
    sub, ws = _sub_with_ws(client, auth_header)
    sub_h = _bearer(sub["token"])
    member = _invite(client, ws["id"], sub_h, email="subfix@example.com", months=1)
    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/add-date",
        json={"add_date": "2026-05-01T00:00:00+00:00"},
        headers=sub_h,
    )
    assert resp.status_code == 403, resp.text


def test_correct_add_date_with_end_at_sets_manual_date(
    client: TestClient, auth_header: dict
):
    """"Sự kết hợp" (tab Theo ngày cụ thể): add_date + end_at → mốc neo = add_date,
    hạn = end_at ĐÚNG (đã tinh chỉnh ±ngày), subscription_months = None (hạn thủ công)."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="combo@example.com", months=2)

    new_date = "2026-05-20T21:00:00+00:00"
    tuned_end = "2026-07-25T21:00:00+00:00"
    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/add-date",
        json={"add_date": new_date, "end_at": tuned_end},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert datetime.fromisoformat(out["subscription_purchased_at"]) == datetime(
        2026, 5, 20, 21, 0, 0, tzinfo=timezone.utc
    )
    # Hạn = ĐÚNG ngày đã tinh chỉnh (không phải add_date + months×30).
    assert datetime.fromisoformat(out["subscription_end_at"]) == datetime(
        2026, 7, 25, 21, 0, 0, tzinfo=timezone.utc
    )
    # Hạn thủ công → xoá số tháng.
    assert out["subscription_months"] is None
    assert out["add_date_corrected_at"] is not None


def test_correct_add_date_with_clear_end_sets_unlimited(
    client: TestClient, auth_header: dict
):
    """Tab Vô thời hạn + sửa ngày thêm: clear_end → xoá hạn + số tháng, giữ mốc neo mới."""
    ws = _create_ws(client, auth_header)
    member = _invite(client, ws["id"], auth_header, email="unl@example.com", months=2)

    new_date = "2026-05-20T21:00:00+00:00"
    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member['id']}/add-date",
        json={"add_date": new_date, "clear_end": True},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert datetime.fromisoformat(out["subscription_purchased_at"]) == datetime(
        2026, 5, 20, 21, 0, 0, tzinfo=timezone.utc
    )
    assert out["subscription_end_at"] is None
    assert out["subscription_months"] is None
    assert out["add_date_corrected_at"] is not None
