"""Phí ngân hàng theo % cho CẢ workspace (chốt user 2026-08-27).

Phí NH là tỉ lệ cố định trên số tiền chuyển (ca thật GPT1: 475.960 / 43.269.050 =
1,1%), nhưng trước đây phải gõ SỐ TIỀN cho từng hoá đơn — sót một dòng là "tổng
thực trả" và báo cáo CHI hụt đúng phần phí đó, im lặng. Giờ nhập % một lần:

  - PATCH /workspaces/{id} nhận `bank_fee_percent`, gửi null/0 để xoá.
  - CHI của báo cáo tài chính cộng phí theo % cho MỌI hoá đơn, kể cả hoá đơn chưa
    từng nhập phí tay; có % thì phí nhập tay cũ bị bỏ qua.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Workspace

_now = datetime.now(timezone.utc)
FIN_START = _now - timedelta(days=45)
INV_DATE = _now - timedelta(days=40)
FROM_Q = (_now - timedelta(days=60)).date().isoformat()
TO_Q = (_now + timedelta(days=90)).date().isoformat()


def _seed_workspace(*, fee_pct: float | None, manual_fee: int | None) -> str:
    """1 workspace, 2 hoá đơn paid có chu kỳ: 1 dòng có phí nhập tay, 1 dòng không."""
    db = SessionLocal()
    try:
        inv_common = {
            "status": "paid",
            "period_start": INV_DATE.date().isoformat(),
            "period_end": (INV_DATE + timedelta(days=30)).date().isoformat(),
        }
        first = {
            "date": INV_DATE.date().isoformat(),
            "total_vnd": 43_269_050,
            "quantity": 151,
            **inv_common,
        }
        if manual_fee is not None:
            first["service_fee_vnd"] = manual_fee
        ws = Workspace(
            name="WS_BANK_FEE",
            extension_api_key="k-bank-fee",
            finance_start_at=FIN_START,
            bank_fee_percent=fee_pct,
            billing_invoices=[
                first,
                # Hoá đơn mua thêm suất — CHƯA từng nhập phí tay.
                {
                    "date": INV_DATE.date().isoformat(),
                    "total_vnd": 152_778,
                    "quantity": 1,
                    **inv_common,
                },
            ],
        )
        db.add(ws)
        db.commit()
        return str(ws.id)
    finally:
        db.close()


def _cost(client: TestClient, auth_header: dict) -> int:
    r = client.get(
        f"/api/v1/wallet/admin/report?from={FROM_Q}&to={TO_Q}", headers=auth_header
    )
    assert r.status_code == 200, r.text
    return r.json()["cost"]


def test_patch_set_and_clear_percent(client: TestClient, auth_header: dict):
    ws_id = _seed_workspace(fee_pct=None, manual_fee=None)

    r = client.patch(
        f"/api/v1/workspaces/{ws_id}",
        json={"bank_fee_percent": 1.1},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert r.json()["bank_fee_percent"] == 1.1

    # Đọc lại bản sống — % là cấu hình của workspace, không phải state của form.
    r = client.get(f"/api/v1/workspaces/{ws_id}", headers=auth_header)
    assert r.json()["bank_fee_percent"] == 1.1

    # null = xoá (quay lại phí nhập tay từng hoá đơn).
    r = client.patch(
        f"/api/v1/workspaces/{ws_id}",
        json={"bank_fee_percent": None},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert r.json()["bank_fee_percent"] is None

    # Không gửi field → giữ nguyên, không bị coi là xoá.
    client.patch(
        f"/api/v1/workspaces/{ws_id}",
        json={"bank_fee_percent": 1.1},
        headers=auth_header,
    )
    r = client.patch(f"/api/v1/workspaces/{ws_id}", json={"name": "WS_BANK_FEE_2"}, headers=auth_header)
    assert r.json()["bank_fee_percent"] == 1.1


def test_report_cost_uses_percent_for_every_invoice(client: TestClient, auth_header: dict):
    """% áp cho MỌI hoá đơn — kể cả dòng mua thêm suất chưa từng nhập phí tay."""
    _seed_workspace(fee_pct=1.1, manual_fee=None)
    expected = (
        43_269_050
        + round(43_269_050 * 1.1 / 100)
        + 152_778
        + round(152_778 * 1.1 / 100)
    )
    assert _cost(client, auth_header) == expected


def test_report_percent_overrides_manual_fee(client: TestClient, auth_header: dict):
    """Có % thì số tiền phí nhập tay cũ không còn được dùng (không cộng hai lần)."""
    _seed_workspace(fee_pct=1.1, manual_fee=9_999_999)
    expected = (
        43_269_050
        + round(43_269_050 * 1.1 / 100)
        + 152_778
        + round(152_778 * 1.1 / 100)
    )
    assert _cost(client, auth_header) == expected


def test_report_without_percent_keeps_manual_fee(client: TestClient, auth_header: dict):
    """Chưa đặt % → hành vi cũ: chỉ hoá đơn có phí nhập tay mới cộng phí."""
    _seed_workspace(fee_pct=None, manual_fee=475_960)
    assert _cost(client, auth_header) == 43_269_050 + 475_960 + 152_778
