"""Lỗi task: sub-admin thấy MỘT CÂU dễ hiểu, super-admin giữ nhật ký kỹ thuật.

Ca thật 28/8/2026: 16 lệnh mời hỏng liên tiếp, đại lý đọc được nguyên đoạn chẩn
đoán ("không thấy bộ đếm số suất của hàng Tiêu chuẩn sau 15s... suất Cao cấp đắt
hơn 12 lần...") — không rút ra được việc phải làm nên bấm mời lại liên tục.
"""

from fastapi.testclient import TestClient

from app.services.task_errors import FALLBACK, friendly_error_message
from tests.test_workspace_member import (
    _bearer,
    _create_sub_admin,
    _login_token,
)


TECHNICAL = (
    "Cần mua thêm 7 suất trước khi mời nhưng không mua được: Đã bấm 'Quản lý số "
    'suất\' nhưng không thấy bộ đếm số suất của hàng "Tiêu chuẩn" sau 15s. Hộp nay '
    "có MỘT bộ đếm cho MỖI loại suất (Tiêu chuẩn / Cao cấp) — không ghim chắc được "
    "hàng Tiêu chuẩn thì KHÔNG bấm, vì suất Cao cấp đắt hơn 12 lần."
)


def test_friendly_message_khong_lo_chi_tiet_ky_thuat() -> None:
    msg = friendly_error_message("NOT_ENOUGH_SEATS", TECHNICAL)
    assert msg is not None
    assert "suất" in msg
    # Không được rò thuật ngữ/chẩn đoán của extension.
    for leak in ("bộ đếm", "Quản lý số suất", "15s", "Cao cấp"):
        assert leak not in msg, leak
    assert len(msg) < 200


def test_ma_la_van_khong_ro_nhat_ky() -> None:
    assert friendly_error_message("MA_MOI_CHUA_KHAI", TECHNICAL) == FALLBACK


def test_khong_co_loi_thi_giu_none() -> None:
    assert friendly_error_message(None, None) is None


def _make_failed_task(
    client: TestClient, auth_header: dict, ws_id: str, sub_token: dict
) -> str:
    """Sub-admin tạo task mời rồi super-admin ghi lỗi kỹ thuật vào (như extension)."""
    from app.db import SessionLocal
    from app.models import QueueItem

    resp = client.post(
        "/api/v1/queue",
        json={
            "type": "INVITE_MEMBER",
            "workspace_id": ws_id,
            "payload": {"emails": ["ai@example.com"], "role": "member"},
        },
        headers=sub_token,
    )
    assert resp.status_code == 201, resp.text
    task_id = resp.json()["id"]

    db = SessionLocal()
    try:
        item = db.get(QueueItem, task_id)
        item.status = "FAILED"
        item.error_code = "NOT_ENOUGH_SEATS"
        item.error_message = TECHNICAL
        db.commit()
    finally:
        db.close()
    return task_id


def test_sub_admin_chi_thay_cau_ngan_super_admin_thay_du(
    client: TestClient, auth_header: dict
) -> None:
    ws_id = client.post(
        "/api/v1/workspaces", json={"name": "Err WS"}, headers=auth_header
    ).json()["id"]
    sub = _create_sub_admin(
        client,
        auth_header,
        email="queueview@example.com",
        username="queueview",
        permissions=["MEMBER_VIEW", "MEMBER_INVITE", "QUEUE_VIEW"],
    )
    assert (
        client.post(
            f"/api/v1/workspaces/{ws_id}/assignments",
            json={"user_id": sub["id"]},
            headers=auth_header,
        ).status_code
        == 201
    )
    sub_token = _bearer(_login_token(client, "queueview", "SubPassword123!"))
    task_id = _make_failed_task(client, auth_header, ws_id, sub_token)

    sub_view = client.get(f"/api/v1/queue?workspace_id={ws_id}", headers=sub_token)
    assert sub_view.status_code == 200, sub_view.text
    row = next(t for t in sub_view.json() if t["id"] == task_id)
    assert row["error_message"] != TECHNICAL
    assert "bộ đếm" not in row["error_message"]
    assert len(row["error_message"]) < 200

    admin_view = client.get(f"/api/v1/queue?workspace_id={ws_id}", headers=auth_header)
    admin_row = next(t for t in admin_view.json() if t["id"] == task_id)
    assert admin_row["error_message"] == TECHNICAL


def test_rut_gon_khong_ghi_de_nhat_ky_trong_db(
    client: TestClient, auth_header: dict
) -> None:
    """Cắt lỗi cho sub-admin là việc CỦA RIÊNG response — DB phải nguyên vẹn.

    `error_message` là cột thật; sửa trên ORM object còn gắn session thì một cú
    autoflush là mất nhật ký chẩn đoán vĩnh viễn.
    """
    from app.db import SessionLocal
    from app.models import QueueItem

    ws_id = client.post(
        "/api/v1/workspaces", json={"name": "Err WS 2"}, headers=auth_header
    ).json()["id"]
    sub = _create_sub_admin(
        client,
        auth_header,
        email="queueview2@example.com",
        username="queueview2",
        permissions=["MEMBER_VIEW", "MEMBER_INVITE", "QUEUE_VIEW"],
    )
    client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    sub_token = _bearer(_login_token(client, "queueview2", "SubPassword123!"))
    task_id = _make_failed_task(client, auth_header, ws_id, sub_token)

    client.get(f"/api/v1/queue?workspace_id={ws_id}", headers=sub_token)

    db = SessionLocal()
    try:
        assert db.get(QueueItem, task_id).error_message == TECHNICAL
    finally:
        db.close()
