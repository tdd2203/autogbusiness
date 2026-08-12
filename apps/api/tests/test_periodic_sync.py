"""ĐỒNG BỘ ĐỊNH KỲ tự động (2026-08-12, sau sự cố xoá-giả 03→12/8).

Sync là nguồn đối chiếu DUY NHẤT giữa DB và ChatGPT, nhưng trước đây CHỈ chạy khi có
người bấm nút — production thực tế: 01/8 rồi im tới 12/8 (11 ngày). Mọi lưới an toàn
dựa vào sync (`_flag_fake_removals`, `MEMBER_SYNC_MISMATCH`, rogue pending) vì thế nằm
chờ vô thời hạn. `_enqueue_periodic_sync_once` (main.py) tự enqueue SYNC_DATA mỗi
`AUTO_SYNC_INTERVAL` cho từng workspace.

File này kiểm: (a) workspace lâu chưa sync → có lệnh, (b) KHÔNG chồng lệnh khi đã có
lệnh sync đang chờ, (c) vừa sync tay xong thì job đứng im, (d) `created_by_id` NULL để
không ăn mất cooldown 5 tiếng của admin phụ.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

import app.main as m
from app.db import SessionLocal
from app.models import AuditLog, QueueItem


def _make_workspace(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()


def _sync_tasks(workspace_id: str) -> list[QueueItem]:
    with SessionLocal() as db:
        return (
            db.query(QueueItem)
            .filter(
                QueueItem.type == "SYNC_DATA",
                QueueItem.workspace_id == workspace_id,
            )
            .order_by(QueueItem.created_at)
            .all()
        )


def _age_sync_tasks(workspace_id: str, hours: float) -> None:
    """Đẩy lùi mọi lệnh sync của workspace về quá khứ (giả lập "lâu chưa sync")."""
    with SessionLocal() as db:
        for item in (
            db.query(QueueItem)
            .filter(
                QueueItem.type == "SYNC_DATA",
                QueueItem.workspace_id == workspace_id,
            )
            .all()
        ):
            item.created_at = datetime.now(timezone.utc) - timedelta(hours=hours)
        db.commit()


def test_workspace_lau_chua_sync_thi_tu_enqueue(
    client: TestClient, auth_header: dict
) -> None:
    """GUARD chính: quá `AUTO_SYNC_INTERVAL` không có lệnh sync nào → job nền tự tạo
    SYNC_DATA scope 'members' + audit SYSTEM, KHÔNG cần ai bấm."""
    assert hasattr(m, "_enqueue_periodic_sync_once"), (
        "Đồng bộ định kỳ (sự cố xoá-giả 2026-08-12) — đừng gỡ"
    )
    ws = _make_workspace(client, auth_header, "WS auto-sync")

    m._enqueue_periodic_sync_once()

    tasks = _sync_tasks(ws["id"])
    assert len(tasks) == 1, [t.payload for t in tasks]
    assert tasks[0].status == "PENDING"
    assert tasks[0].payload["sync_scope"] == "members"
    assert tasks[0].payload["source"] == "scheduler"
    # created_by_id NULL: cooldown 5 tiếng của admin phụ lọc theo NGƯỜI TẠO nên
    # lệnh nền không được phép chiếm suất sync tay của họ.
    assert tasks[0].created_by_id is None
    with SessionLocal() as db:
        audits = (
            db.query(AuditLog)
            .filter(
                AuditLog.action == "WORKSPACE_SYNC_QUEUED",
                AuditLog.target_id == ws["id"],
            )
            .all()
        )
        assert len(audits) == 1
        assert audits[0].actor_type == "SYSTEM"
        assert audits[0].data["source"] == "scheduler"


def test_khong_chong_lenh_khi_da_co_sync_dang_cho(
    client: TestClient, auth_header: dict
) -> None:
    """Extension offline dài ngày: lệnh cũ vẫn PENDING → tick sau KHÔNG đẻ thêm.
    Đây là cái chặn đọng hàng đống lệnh chờ."""
    ws = _make_workspace(client, auth_header, "WS offline")
    m._enqueue_periodic_sync_once()
    # Lệnh cũ đã quá hạn cửa sổ nhưng VẪN đang chờ extension pick.
    _age_sync_tasks(ws["id"], hours=48)

    m._enqueue_periodic_sync_once()

    assert len(_sync_tasks(ws["id"])) == 1, "đang có lệnh chờ thì không được tạo thêm"


def test_vua_sync_tay_thi_job_nen_dung_im(
    client: TestClient, auth_header: dict
) -> None:
    """Sync tay vừa chạy xong (COMPLETED trong cửa sổ) → job nền không chen vào."""
    ws = _make_workspace(client, auth_header, "WS vừa sync")
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/sync",
        json={"include_pending": True},
        headers=auth_header,
    )
    assert resp.status_code in (200, 201, 202), resp.text
    with SessionLocal() as db:
        task = db.query(QueueItem).filter(QueueItem.type == "SYNC_DATA").one()
        task.status = "COMPLETED"
        db.commit()

    m._enqueue_periodic_sync_once()

    assert len(_sync_tasks(ws["id"])) == 1, "vừa sync trong cửa sổ thì đừng sync lại"


def test_het_cua_so_thi_sync_lai(client: TestClient, auth_header: dict) -> None:
    """Lệnh sync trước đã xong và quá `AUTO_SYNC_INTERVAL` → tới lượt lệnh mới."""
    ws = _make_workspace(client, auth_header, "WS tới lượt")
    m._enqueue_periodic_sync_once()
    with SessionLocal() as db:
        for t in db.query(QueueItem).filter(QueueItem.type == "SYNC_DATA").all():
            t.status = "COMPLETED"
        db.commit()
    _age_sync_tasks(
        ws["id"], hours=m.AUTO_SYNC_INTERVAL.total_seconds() / 3600 + 1
    )

    m._enqueue_periodic_sync_once()

    assert len(_sync_tasks(ws["id"])) == 2
