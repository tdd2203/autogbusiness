"""BILLING SYNC PUSH — extension đẩy billing scrape (kèm chi tiết hoá đơn).

Phủ:
  - Lưu đầy đủ trường chi tiết đọc từ trang hoá đơn Stripe (quantity, unit_price,
    subtotal, vat, total, period, invoice_number) vào JSONB billing_invoices.
  - KHÔNG có ngưỡng chặn seat/giá (regression bug đoán seat: workspace 35 seat,
    giá 260.500đ, tổng 10.029.250đ vẫn lưu đúng).
  - renewal_date cập nhật từ payload (extension suy từ period_end).
  - An toàn dữ liệu (Hiến pháp II): invoices=None / [] KHÔNG xoá dữ liệu cũ.
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str = "WS Billing") -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 35},
        headers=auth_header,
    ).json()


def _ext(ws: dict) -> dict:
    return {"X-API-KEY": ws["extension_api_key"]}


def _get_ws(client: TestClient, auth_header: dict, ws_id: str) -> dict:
    return client.get(f"/api/v1/workspaces/{ws_id}", headers=auth_header).json()


def _invoice_35_seats() -> dict:
    """Hoá đơn gia hạn 25/6 của workspace 35 seat (theo ảnh người dùng)."""
    return {
        "date": "2026-06-25T00:00:00Z",
        "amount_vnd": 10029250,
        "status": "paid",
        "detail_scraped": True,
        "detail_url": "https://invoice.stripe.com/i/acct_x/live_y",
        "quantity": 35,
        "unit_price_vnd": 260500,
        "subtotal_vnd": 9117500,
        "vat_vnd": 911750,
        "total_vnd": 10029250,
        "period_start": "2026-06-25T00:00:00Z",
        "period_end": "2026-07-25T00:00:00Z",
        "invoice_number": "MSNS6RGC-0024",
    }


def test_billing_sync_persists_invoice_detail(client: TestClient, auth_header: dict):
    ws = _ws(client, auth_header)
    resp = client.post(
        "/api/v1/workspaces/billing-sync",
        json={
            "plan": "business",
            "seat_total": 35,
            "seat_used": 30,
            "billing_status": "PAID",
            "renewal_date": "2026-07-25T00:00:00Z",
            "invoices": [_invoice_35_seats()],
        },
        headers=_ext(ws),
    )
    assert resp.status_code == 200, resp.text

    got = _get_ws(client, auth_header, ws["id"])
    invs = got["billing_invoices"]
    assert len(invs) == 1
    inv = invs[0]
    # Số liệu CHÍNH XÁC — không đoán, không ngưỡng chặn (>10 seat, >400k/seat).
    assert inv["quantity"] == 35
    assert inv["unit_price_vnd"] == 260500
    assert inv["subtotal_vnd"] == 9117500
    assert inv["vat_vnd"] == 911750
    assert inv["total_vnd"] == 10029250
    assert inv["detail_scraped"] is True
    assert inv["invoice_number"] == "MSNS6RGC-0024"
    assert inv["period_start"].startswith("2026-06-25")
    assert inv["period_end"].startswith("2026-07-25")
    # renewal_date suy từ period_end được lưu.
    assert got["renewal_date"].startswith("2026-07-25")


def test_billing_sync_renewal_date_change_no_500(client: TestClient, auth_header: dict):
    """Đổi renewal_date (chu kỳ mới) KHÔNG được 500.

    Regression: audit diff ghi `before` = renewal_date CŨ dạng datetime thô → khi
    renewal_date đổi, log_event serialize JSONB fail json.dumps → 500 → extension
    báo BILLING_SYNC_FAILED 'Unexpected token I…'. Phải serialize before→ISO.
    """
    ws = _ws(client, auth_header)
    r1 = client.post(
        "/api/v1/workspaces/billing-sync",
        json={"renewal_date": "2026-07-11T00:00:00Z"},
        headers=_ext(ws),
    )
    assert r1.status_code == 200, r1.text
    # ĐỔI renewal_date → trước đây 500.
    r2 = client.post(
        "/api/v1/workspaces/billing-sync",
        json={"renewal_date": "2026-08-11T00:00:00Z"},
        headers=_ext(ws),
    )
    assert r2.status_code == 200, r2.text
    assert _get_ws(client, auth_header, ws["id"])["renewal_date"].startswith(
        "2026-08-11"
    )


def test_billing_sync_backward_compatible_minimal(client: TestClient, auth_header: dict):
    """Hoá đơn cũ chỉ có date/amount/status vẫn nhận được (detail_scraped mặc định False)."""
    ws = _ws(client, auth_header)
    resp = client.post(
        "/api/v1/workspaces/billing-sync",
        json={
            "invoices": [
                {"date": "2026-05-17T00:00:00Z", "amount_vnd": 230535, "status": "paid"}
            ]
        },
        headers=_ext(ws),
    )
    assert resp.status_code == 200, resp.text
    invs = _get_ws(client, auth_header, ws["id"])["billing_invoices"]
    assert len(invs) == 1
    assert invs[0]["detail_scraped"] is False
    assert "quantity" not in invs[0]


def test_billing_sync_empty_does_not_wipe(client: TestClient, auth_header: dict):
    """invoices=None / [] KHÔNG được xoá dữ liệu hoá đơn đã lưu (Hiến pháp II)."""
    ws = _ws(client, auth_header)
    # Lần 1: lưu hoá đơn chi tiết.
    client.post(
        "/api/v1/workspaces/billing-sync",
        json={"invoices": [_invoice_35_seats()]},
        headers=_ext(ws),
    )
    # Lần 2: chỉ sync seat, KHÔNG gửi invoices.
    r2 = client.post(
        "/api/v1/workspaces/billing-sync",
        json={"seat_used": 31},
        headers=_ext(ws),
    )
    assert r2.status_code == 200, r2.text
    invs = _get_ws(client, auth_header, ws["id"])["billing_invoices"]
    assert len(invs) == 1 and invs[0]["quantity"] == 35  # còn nguyên
    # Lần 3: gửi list rỗng → vẫn không xoá.
    r3 = client.post(
        "/api/v1/workspaces/billing-sync",
        json={"invoices": []},
        headers=_ext(ws),
    )
    assert r3.status_code == 200, r3.text
    invs = _get_ws(client, auth_header, ws["id"])["billing_invoices"]
    assert len(invs) == 1 and invs[0]["quantity"] == 35


# --- Phí dịch vụ ngân hàng (nhập tay) ---------------------------------------


def _set_fee(client, auth_header, ws_id, *, fee, invoice_number=None,
             date="2026-06-25T00:00:00Z", amount_vnd=10029250):
    return client.patch(
        f"/api/v1/workspaces/{ws_id}/billing-invoices/fee",
        json={
            "invoice_number": invoice_number,
            "date": date,
            "amount_vnd": amount_vnd,
            "service_fee_vnd": fee,
        },
        headers=auth_header,
    )


def test_set_invoice_fee_by_number(client: TestClient, auth_header: dict):
    """Super-admin gán phí theo invoice_number → lưu; gửi 0 → xoá."""
    ws = _ws(client, auth_header)
    client.post(
        "/api/v1/workspaces/billing-sync",
        json={"invoices": [_invoice_35_seats()]},
        headers=_ext(ws),
    )
    r = _set_fee(client, auth_header, ws["id"], fee=578045,
                 invoice_number="MSNS6RGC-0024")
    assert r.status_code == 200, r.text
    invs = _get_ws(client, auth_header, ws["id"])["billing_invoices"]
    assert invs[0]["service_fee_vnd"] == 578045

    # Xoá phí (gửi 0 → field bị bỏ).
    r2 = _set_fee(client, auth_header, ws["id"], fee=0,
                  invoice_number="MSNS6RGC-0024")
    assert r2.status_code == 200, r2.text
    invs = _get_ws(client, auth_header, ws["id"])["billing_invoices"]
    assert "service_fee_vnd" not in invs[0]


def test_invoice_fee_survives_resync(client: TestClient, auth_header: dict):
    """Phí nhập tay KHÔNG bị extension sync ghi đè (merge theo invoice_number)."""
    ws = _ws(client, auth_header)
    client.post(
        "/api/v1/workspaces/billing-sync",
        json={"invoices": [_invoice_35_seats()]},
        headers=_ext(ws),
    )
    _set_fee(client, auth_header, ws["id"], fee=578045,
             invoice_number="MSNS6RGC-0024")

    # Extension sync lại (ghi đè toàn bộ) cùng hoá đơn → phí phải còn.
    r = client.post(
        "/api/v1/workspaces/billing-sync",
        json={"invoices": [_invoice_35_seats()]},
        headers=_ext(ws),
    )
    assert r.status_code == 200, r.text
    invs = _get_ws(client, auth_header, ws["id"])["billing_invoices"]
    assert invs[0]["service_fee_vnd"] == 578045


def test_set_invoice_fee_not_found(client: TestClient, auth_header: dict):
    ws = _ws(client, auth_header)
    client.post(
        "/api/v1/workspaces/billing-sync",
        json={"invoices": [_invoice_35_seats()]},
        headers=_ext(ws),
    )
    r = _set_fee(client, auth_header, ws["id"], fee=1000,
                 invoice_number="DOES-NOT-EXIST", amount_vnd=999)
    assert r.status_code == 404, r.text


def test_set_invoice_fee_requires_super_admin(client: TestClient):
    """Endpoint gán phí là JWT super-admin — không có JWT → 401/403."""
    r = client.patch(
        "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/billing-invoices/fee",
        json={"date": "2026-06-25T00:00:00Z", "amount_vnd": 1, "service_fee_vnd": 1},
    )
    assert r.status_code in (401, 403), r.text
