"""ĐỒNG BỘ ĐỊNH KỲ tự động (2026-08-12, sau sự cố xoá-giả 03→12/8).

Sync là nguồn đối chiếu DUY NHẤT giữa DB và ChatGPT, nhưng trước đây CHỈ chạy khi có
người bấm nút — production thực tế: 01/8 rồi im tới 12/8 (11 ngày). Mọi lưới an toàn
dựa vào sync (`_flag_fake_removals`, `MEMBER_SYNC_MISMATCH`, rogue pending) vì thế nằm
chờ vô thời hạn. `_enqueue_periodic_sync_once` (main.py) tự enqueue SYNC_DATA cho từng
workspace **1 lần/ngày, vào mốc ngẫu nhiên trong ngày** (chốt user 2026-08-13 — bản
đầu chạy mỗi 2 tiếng là do phiên trước tự chọn, user không duyệt).

File này kiểm: (a) tới mốc mà hôm nay chưa sync → có lệnh, (b) chưa tới mốc thì im,
(c) KHÔNG chồng lệnh khi đã có lệnh sync đang chờ, (d) trong ngày đã sync (tay hoặc
tự động) thì thôi, (e) sang ngày mới thì tới lượt, (f) mốc ngẫu nhiên phải TẤT ĐỊNH
theo (workspace, ngày) và nằm trong khung giờ.
"""

from datetime import datetime, timedelta, timezone

import pytest
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


@pytest.fixture
def slot_passed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Giả lập "đã tới mốc ngẫu nhiên của hôm nay".

    Mốc thật rơi ngẫu nhiên trong khung 8h–22h giờ VN nên test không được phụ thuộc
    vào lúc chạy CI (2h sáng thì mọi test enqueue sẽ trượt). Ghim mốc về quá khứ để
    kiểm phần còn lại; bản thân hàm mốc có test riêng ở dưới.
    """
    monkeypatch.setattr(
        m,
        "_auto_sync_slot_at",
        lambda _ws, _day: datetime.now(timezone.utc) - timedelta(minutes=1),
    )


def test_toi_moc_ma_hom_nay_chua_sync_thi_tu_enqueue(
    client: TestClient, auth_header: dict, slot_passed: None
) -> None:
    """GUARD chính: tới mốc trong ngày mà chưa có lệnh sync nào → job nền tự tạo
    SYNC_DATA scope 'members' + audit SYSTEM, KHÔNG cần ai bấm."""
    assert hasattr(m, "_enqueue_periodic_sync_once"), (
        "Đồng bộ định kỳ (sự cố xoá-giả 2026-08-12) — đừng gỡ"
    )
    ws = _make_workspace(client, auth_header, "WS auto-sync")

    m._enqueue_periodic_sync_once()

    tasks = _sync_tasks(ws["id"])
    assert len(tasks) == 1, [t.payload for t in tasks]
    assert tasks[0].status == "PENDING"
    # scope 'both' (user 2026-08-24): scope 'members' KHÔNG được phép dọn lời mời
    # chết — reconcile chỉ dám xoá pending khi lượt sync có quét CẢ tab "Người
    # dùng". Xem khối hằng số ĐỒNG BỘ ĐỊNH KỲ trong app/main.py.
    assert tasks[0].payload["sync_scope"] == "both"
    assert tasks[0].payload["include_pending"] is True
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
        assert audits[0].data["cadence"] == "daily-random"
        assert audits[0].data["slot_at"], "phải ghi mốc đã chọn để còn truy nguyên"


def test_chua_toi_moc_thi_khong_sync(
    client: TestClient, auth_header: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mốc hôm nay còn ở tương lai → tick vẫn chạy nhưng KHÔNG tạo lệnh. Đây là cái
    giữ cho nhịp đúng 1 lần/ngày thay vì mỗi tick 10′ một lệnh."""
    ws = _make_workspace(client, auth_header, "WS chưa tới mốc")
    monkeypatch.setattr(
        m,
        "_auto_sync_slot_at",
        lambda _ws, _day: datetime.now(timezone.utc) + timedelta(hours=1),
    )

    m._enqueue_periodic_sync_once()

    assert _sync_tasks(ws["id"]) == []


def test_khong_chong_lenh_khi_da_co_sync_dang_cho(
    client: TestClient, auth_header: dict, slot_passed: None
) -> None:
    """Extension offline dài ngày: lệnh cũ vẫn PENDING → tick sau KHÔNG đẻ thêm.
    Đây là cái chặn đọng hàng đống lệnh chờ."""
    ws = _make_workspace(client, auth_header, "WS offline")
    m._enqueue_periodic_sync_once()
    # Lệnh cũ đã sang ngày khác nhưng VẪN đang chờ extension pick.
    _age_sync_tasks(ws["id"], hours=48)

    m._enqueue_periodic_sync_once()

    assert len(_sync_tasks(ws["id"])) == 1, "đang có lệnh chờ thì không được tạo thêm"


def test_trong_ngay_da_sync_tay_thi_job_nen_dung_im(
    client: TestClient, auth_header: dict, slot_passed: None
) -> None:
    """Sync tay đã chạy hôm nay (COMPLETED) → job nền không chen vào nữa."""
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

    assert len(_sync_tasks(ws["id"])) == 1, "hôm nay sync rồi thì đừng sync lại"


def test_sang_ngay_moi_thi_sync_lai(
    client: TestClient, auth_header: dict, slot_passed: None
) -> None:
    """Lệnh sync trước đã xong và sang ngày khác → tới lượt lệnh mới."""
    ws = _make_workspace(client, auth_header, "WS tới lượt")
    m._enqueue_periodic_sync_once()
    with SessionLocal() as db:
        for t in db.query(QueueItem).filter(QueueItem.type == "SYNC_DATA").all():
            t.status = "COMPLETED"
        db.commit()
    # 25 tiếng: chắc chắn rơi sang NGÀY khác theo giờ VN dù test chạy giờ nào.
    _age_sync_tasks(ws["id"], hours=25)

    m._enqueue_periodic_sync_once()

    assert len(_sync_tasks(ws["id"])) == 2


def test_moc_ngau_nhien_tat_dinh_va_nam_trong_khung() -> None:
    """Mốc phải: (1) nằm trong khung giờ VN cho phép, (2) LẶP LẠI y hệt cho cùng
    (workspace, ngày) — nếu không, API restart giữa ngày là mốc nhảy đi chỗ khác và
    workspace có thể bị sync 2 lần/ngày, (3) khác nhau giữa các workspace/ngày để
    lượt quét rải ra."""
    day = datetime(2026, 8, 13, tzinfo=m.AUTO_SYNC_TZ).date()
    ws_a, ws_b = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"

    slot = m._auto_sync_slot_at(ws_a, day)
    local = slot.astimezone(m.AUTO_SYNC_TZ)
    assert local.date() == day
    assert m.AUTO_SYNC_WINDOW_START_HOUR <= local.hour < m.AUTO_SYNC_WINDOW_END_HOUR

    assert m._auto_sync_slot_at(ws_a, day) == slot, "cùng ws + ngày ⇒ cùng mốc"
    assert m._auto_sync_slot_at(ws_b, day) != slot, "khác ws ⇒ nên khác mốc"
    assert m._auto_sync_slot_at(ws_a, day + timedelta(days=1)) != slot, (
        "sang ngày mới ⇒ bốc lại mốc khác"
    )
