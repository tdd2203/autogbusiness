"""TỔNG SUẤT lấy từ ĐÂU — và chỗ nào KHÔNG được đụng vào nó.

Ca thật GPT1 (24/8/2026): dashboard in "149/148 seat" trong khi hộp "Quản lý
suất" của ChatGPT ghi "151 người dùng · 147/151 đã gán". Truy ra:

  13/8  admin dán lại lịch sử hoá đơn cho báo cáo tài chính. Mỗi lần dán,
        endpoint billing-paste set `seat_total` = số ghế GHI TRÊN HOÁ ĐƠN ĐÓ
        → 151 → 2 → 102 → 148. Con số 148 (hoá đơn kỳ cũ) đứng nguyên 11 ngày.

Chốt lại nguồn của hai con số (user 2026-08-24):
  - `seat_total`  = số ĐỌC TẬN NƠI trên ChatGPT (hộp "Quản lý suất", hoặc dòng
    tỉ lệ trang thanh toán). KHÔNG lấy từ hoá đơn.
  - `seat_used`   = người dùng + lời mời đang chờ trong DB (tính lại mỗi lần
    đọc), vì lời mời chờ cũng đang giữ suất.
"""

import uuid

from fastapi.testclient import TestClient

from tests.wallet_helpers import create_ws


def _ext(ws: dict) -> dict:
    return {"X-API-KEY": ws["extension_api_key"]}


def _get_ws(client: TestClient, auth_header: dict, ws_id: str) -> dict:
    return client.get(f"/api/v1/workspaces/{ws_id}", headers=auth_header).json()


def _queue_item(ws_id: str, type_: str = "SYNC_DATA") -> str:
    """Tạo thẳng 1 task IN_PROGRESS trong DB (khỏi qua trigger + quyền)."""
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        item = QueueItem(
            workspace_id=uuid.UUID(ws_id),
            type=type_,
            status="IN_PROGRESS",
            payload={},
        )
        db.add(item)
        db.commit()
        return str(item.id)


def _complete(client: TestClient, ws: dict, item_id: str, result: dict) -> None:
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={"status": "COMPLETED", "result": result},
        headers=_ext(ws),
    )
    assert r.status_code == 200, r.text


def test_task_doc_tan_noi_cap_nhat_tong_suat(client: TestClient, auth_header: dict):
    """Extension đọc hộp "Quản lý suất" → tổng suất trên dashboard tươi theo.

    Trước đây con số chỉ nằm trong `result` rồi thôi: `seat_total` chỉ đổi khi
    chạy SYNC_BILLING nên dashboard ôm số cũ hàng tuần.
    """
    ws = create_ws(client, auth_header, "Seat Read WS", plan="business", seat_total=148)
    item_id = _queue_item(ws["id"])

    _complete(client, ws, item_id, {"seat_total": 151, "seat_assigned": 147})

    assert _get_ws(client, auth_header, ws["id"])["seat_total"] == 151


def test_duong_tat_khong_duoc_tu_xac_nhan_so_cu(client: TestClient, auth_header: dict):
    """Extension đi ĐƯỜNG TẮT (không mở hộp) thì `seat_total` trong result CHÍNH LÀ
    hint dashboard vừa gửi xuống — ghi lại là vòng tròn, số cũ tự xác nhận chính
    nó và không bao giờ tươi lại."""
    ws = create_ws(client, auth_header, "Seat Hint WS", plan="business", seat_total=148)
    item_id = _queue_item(ws["id"], "INVITE_MEMBER")

    _complete(
        client,
        ws,
        item_id,
        {
            "data": {
                "seat_check": "skipped_headroom",
                "seat_total": 148,
                "seat_assigned": 149,
            }
        },
    )

    got = _get_ws(client, auth_header, ws["id"])
    assert got["seat_total"] == 148, "số cũ vẫn là số cũ — không được coi là 'đã đọc'"


def test_dan_hoa_don_cu_khong_keo_tong_suat_ve_qua_khu(
    client: TestClient, auth_header: dict
):
    """Dán hoá đơn (kể cả hoá đơn CŨ) KHÔNG được đụng vào tổng suất hiện tại.

    Đúng ca GPT1 13/8/2026: dán 3 hoá đơn liên tiếp kéo seat_total 151 → 2 → 102
    → 148 dù workspace vẫn đang có 151 suất.
    """
    ws = create_ws(client, auth_header, "Seat Paste WS", plan="business", seat_total=151)

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/billing-paste",
        json={
            "quantity": 2,
            "unit_price_vnd": 286550,
            "total_vnd": 573100,
            "amount_vnd": 573100,
            "period_start": "2026-06-11T00:00:00Z",
            "period_end": "2026-07-11T00:00:00Z",
            "date": "2026-06-11T00:00:00Z",
            "invoice_number": "M96E9GXY-0001",
        },
        headers=auth_header,
    )
    assert r.status_code == 200, r.text

    got = _get_ws(client, auth_header, ws["id"])
    assert got["seat_total"] == 151, "hoá đơn 2 ghế không được biến workspace thành 2 suất"
    invs = got["billing_invoices"]
    assert invs[0]["quantity"] == 2, "số ghế của hoá đơn vẫn phải lưu để tính tiền"


def test_popup_extension_thay_cung_so_seat_voi_dashboard(
    client: TestClient, auth_header: dict
):
    """`whoami` (popup in "Seat: x/y") phải tính `seat_used` như dashboard —
    người dùng + lời mời chờ trong DB — chứ không trả cột thô của lần scrape cũ."""
    ws = create_ws(client, auth_header, "Seat Whoami WS", plan="business", seat_total=151)
    item_id = _queue_item(ws["id"])
    # Task đọc tận nơi ghi seat_used=147 (số ChatGPT đang gán) vào cột thô.
    _complete(client, ws, item_id, {"seat_total": 151, "seat_assigned": 147})

    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": "a@example.com", "status": "active"},
                {"email": "b@example.com", "status": "active"},
                {"email": "c@example.com", "status": "pending"},
            ],
            "is_full_sync": False,
        },
        headers=_ext(ws),
    )

    who = client.get("/api/v1/workspaces/whoami", headers=_ext(ws)).json()
    assert who["seat_total"] == 151
    assert who["seat_used"] == 3, "2 người dùng + 1 lời mời chờ (lời mời chờ vẫn giữ suất)"
    assert who["seat_used"] == _get_ws(client, auth_header, ws["id"])["seat_used"]
