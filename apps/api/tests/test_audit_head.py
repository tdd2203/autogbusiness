"""`/audit-logs/head` — mốc nhật ký mới nhất để trang tự làm mới.

Trang Nhật ký mở lâu thì sự kiện chạy nền không tự hiện. Web hỏi endpoint này mỗi
15s (chỉ id + thời điểm, rất nhẹ) và chỉ tải lại danh sách khi id khác dòng đang
hiện — nên điều kiện đúng/sai của nó là: LUÔN trỏ vào dòng mới nhất, và ai xem
được nhật ký thì gọi được.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog


def _seed(rows: list[tuple[str, datetime]]) -> None:
    with SessionLocal() as db:
        for action, ts in rows:
            db.add(
                AuditLog(
                    timestamp=ts,
                    actor_type="SYSTEM",
                    action=action,
                    result="SUCCESS",
                )
            )
        db.commit()


def test_head_tro_dung_dong_moi_nhat(client: TestClient, auth_header: dict) -> None:
    base = datetime(2026, 8, 20, 3, 0, tzinfo=timezone.utc)
    _seed([(f"TEST_HEAD_{i:02d}", base + timedelta(minutes=i)) for i in range(3)])

    newest = client.get("/api/v1/audit-logs?limit=1", headers=auth_header).json()[0]
    head = client.get("/api/v1/audit-logs/head", headers=auth_header)
    assert head.status_code == 200, head.text
    assert head.json()["id"] == newest["id"]

    # Có sự kiện mới ⇒ mốc đổi (web thấy khác dòng đang hiện thì mới tải lại).
    # Mốc phải MỚI HƠN log đăng nhập của fixture (ghi bằng giờ thật) mới là mới nhất.
    _seed([("TEST_HEAD_NEW", datetime.now(timezone.utc) + timedelta(minutes=5))])
    after = client.get("/api/v1/audit-logs/head", headers=auth_header).json()
    assert after["id"] != head.json()["id"]
    assert after["timestamp"] is not None
    top = client.get("/api/v1/audit-logs?limit=1", headers=auth_header).json()[0]
    assert after["id"] == top["id"] and top["action"] == "TEST_HEAD_NEW"


def test_head_khong_can_dang_nhap_thi_tu_choi(client: TestClient) -> None:
    assert client.get("/api/v1/audit-logs/head").status_code in (401, 403)
