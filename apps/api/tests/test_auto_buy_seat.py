"""TỰ MUA BÙ SUẤT cho lời mời đang treo — đường TỰ TIÊU TIỀN THẬT.

Vì sao có (chốt user 2026-08-24): hộp "Quản lý suất" của ChatGPT chỉ đếm người ĐÃ
THAM GIA vào ô "đã gán" — lời mời đang treo không nằm trong đó nhưng sẽ chiếm suất
ngay khi người ta bấm nhận. Ca thật CHATGPT PRO: "60/60 đã gán" + 1 lời mời chờ ⇒
đang NỢ 1 suất mà không chỗ nào báo. Người đó bấm nhận thì ChatGPT vẫn phải cấp
suất thứ 61 và vẫn tính tiền — mua trước là trả sớm khoản đằng nào cũng tới, đổi
lại tránh được hộp "Mua suất người dùng và gửi lời mời" do ChatGPT tự quyết giá.

Task PURCHASE_SEAT bấm "Xác nhận mua" → TRỪ TIỀN THẬT qua thẻ đã lưu, và từ khi
sync định kỳ quét cả hai tab thì đường này chạy cả lúc KHÔNG AI ngồi trước máy.
Nên mọi rào chắn dưới đây đều là chốt TIỀN, không phải chốt logic. File này khoá
chúng lại.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from tests.wallet_helpers import create_ws


def _ext(ws: dict) -> dict:
    return {"X-API-KEY": ws["extension_api_key"]}


def _sync_item(ws_id: str) -> str:
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        item = QueueItem(
            workspace_id=uuid.UUID(ws_id),
            type="SYNC_DATA",
            status="IN_PROGRESS",
            payload={},
        )
        db.add(item)
        db.commit()
        return str(item.id)


def _purchases(ws_id: str) -> list[dict]:
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        rows = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws_id),
                QueueItem.type == "PURCHASE_SEAT",
            )
            .all()
        )
        return [{"status": r.status, **(r.payload or {})} for r in rows]


def _audit_actions(ws_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        rows = (
            db.query(AuditLog)
            .filter(AuditLog.target_id == ws_id, AuditLog.action.like("AUTO_%"))
            .all()
        )
        return [r.action for r in rows]


def _members(client: TestClient, ws: dict, members: list[dict]) -> None:
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": members, "is_full_sync": False},
        headers=_ext(ws),
    )
    assert r.status_code == 200, r.text


def _finish_sync(client: TestClient, ws: dict, item_id: str, **over) -> None:
    """Extension báo SYNC_DATA xong, kèm số suất đọc ở hộp "Quản lý suất"."""
    result = {
        "total": 0,
        "seat_total": 60,
        "seat_assigned": 60,
        "seat_uncertain": False,
        "invites_scanned": True,
        "reconcile_skipped": False,
    }
    result.update(over)
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={"status": "COMPLETED", "result": result},
        headers=_ext(ws),
    )
    assert r.status_code == 200, r.text


def _age_pending(
    ws_id: str,
    *,
    days: int,
    last_invited_days: int | None = None,
    sub_end_days_ago: int | None = None,
) -> None:
    """Đẩy lùi ngày mời của MỌI member pending trong workspace, để dựng ca lời mời
    đã nguội mà không phải chờ thật."""
    from app.db import SessionLocal
    from app.models import Member

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        rows = (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws_id),
                Member.status == "pending",
            )
            .all()
        )
        for m in rows:
            m.created_at = now - timedelta(days=days)
            m.last_invited_at = (
                now - timedelta(days=last_invited_days)
                if last_invited_days is not None
                else m.created_at
            )
            m.subscription_end_at = (
                now - timedelta(days=sub_end_days_ago)
                if sub_end_days_ago is not None
                else now + timedelta(days=30)
            )
        db.commit()


def _ws_with_pending(client: TestClient, auth_header: dict, name: str, pending: int = 1):
    """Workspace 60 suất, 60 người đang dùng, `pending` lời mời đang treo."""
    ws = create_ws(client, auth_header, name, plan="business", seat_total=60)
    _members(
        client,
        ws,
        [
            {"email": f"chua-nhan{i}@example.com", "status": "pending"}
            for i in range(pending)
        ],
    )
    return ws


def test_thieu_suat_cho_loi_moi_treo_thi_tu_mua_bu(
    client: TestClient, auth_header: dict
):
    """60 đã gán + 1 lời mời chờ trên 60 suất ⇒ nợ 1 suất ⇒ tự tạo task mua 1."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy WS")
    _finish_sync(client, ws, _sync_item(ws["id"]))

    got = _purchases(ws["id"])
    assert len(got) == 1, got
    assert got[0]["quantity"] == 1
    assert got[0]["reason"] == "auto_pending_seat"
    assert got[0]["status"] == "PENDING"
    assert "AUTO_PURCHASE_SEAT_QUEUED" in _audit_actions(ws["id"])


def test_con_du_cho_thi_khong_mua_gi(client: TestClient, auth_header: dict):
    """55 đã gán + 1 chờ trên 60 suất ⇒ còn dư 4 ⇒ TUYỆT ĐỐI không tiêu tiền."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy Room WS")
    _finish_sync(client, ws, _sync_item(ws["id"]), seat_assigned=55)

    assert _purchases(ws["id"]) == []
    assert _audit_actions(ws["id"]) == []


def test_so_suat_mo_ho_thi_khong_dam_mua(client: TestClient, auth_header: dict):
    """Bộ đếm và dòng tỉ lệ nói hai tổng khác nhau → dừng, để admin mua tay.

    Mua theo số sai là mất tiền thật mà không đòi lại được.
    """
    ws = _ws_with_pending(client, auth_header, "Auto Buy Uncertain WS")
    _finish_sync(client, ws, _sync_item(ws["id"]), seat_uncertain=True)

    assert _purchases(ws["id"]) == []
    assert "AUTO_PURCHASE_SEAT_SKIPPED" in _audit_actions(ws["id"])


def test_chua_quet_tab_loi_moi_thi_khong_mua(client: TestClient, auth_header: dict):
    """Mẻ sync không quét tab "Lời mời đang chờ" → số pending trong DB là số CŨ,
    có thể đã chết (hết hạn / bị thu hồi). Mua theo nó là mua thừa."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy NoScan WS")
    _finish_sync(client, ws, _sync_item(ws["id"]), invites_scanned=False)

    assert _purchases(ws["id"]) == []


def test_reconcile_bi_tu_choi_thi_khong_mua(client: TestClient, auth_header: dict):
    """Backend vừa từ chối reconcile (nghi mẻ sync thiếu dữ liệu) ⇒ lời mời chờ
    trong DB CHƯA được dọn theo mẻ này.

    Quét được tab chỉ chứng minh "đã nhìn", không chứng minh "đã đối chiếu xong" —
    mà đúng ca bị từ chối lại là ca DB còn ôm lời mời đã chết.
    """
    ws = _ws_with_pending(client, auth_header, "Auto Buy NoReconcile WS")
    _finish_sync(client, ws, _sync_item(ws["id"]), reconcile_skipped=True)

    assert _purchases(ws["id"]) == []


def test_thieu_qua_nhieu_thi_dung_lai_cho_nguoi_that_nhin(
    client: TestClient, auth_header: dict
):
    """Thiếu 6 suất (> trần 5) ⇒ chỉ ghi nhật ký, không tự tiêu tiền."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy Cap WS", pending=6)
    _finish_sync(client, ws, _sync_item(ws["id"]))

    assert _purchases(ws["id"]) == []
    assert "AUTO_PURCHASE_SEAT_SKIPPED" in _audit_actions(ws["id"])


def test_khong_mua_chong_khi_lan_truoc_con_moi(client: TestClient, auth_header: dict):
    """Vừa mua xong mà mẻ sync kế tiếp vẫn đọc ra số cũ (ChatGPT cộng suất chậm
    một nhịp) ⇒ KHÔNG được mua lần nữa. Đây là chốt chặn vòng lặp mua."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy Cooldown WS")
    _finish_sync(client, ws, _sync_item(ws["id"]))
    assert len(_purchases(ws["id"])) == 1

    # Task mua lần 1 chạy xong (không còn PENDING) nhưng vẫn trong thời gian chờ.
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        row = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws["id"]),
                QueueItem.type == "PURCHASE_SEAT",
            )
            .one()
        )
        row.status = "COMPLETED"
        db.commit()

    _finish_sync(client, ws, _sync_item(ws["id"]))
    assert len(_purchases(ws["id"])) == 1, "mua chồng lần 2 = trừ tiền hai lần"


def test_het_thoi_gian_cho_thi_duoc_mua_tiep(client: TestClient, auth_header: dict):
    """Qua 6 tiếng mà vẫn thiếu ⇒ được mua tiếp (không phải khoá vĩnh viễn)."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy After Cooldown WS")
    _finish_sync(client, ws, _sync_item(ws["id"]))

    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        row = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws["id"]),
                QueueItem.type == "PURCHASE_SEAT",
            )
            .one()
        )
        row.status = "COMPLETED"
        row.created_at = datetime.now(timezone.utc) - timedelta(hours=7)
        db.commit()

    _finish_sync(client, ws, _sync_item(ws["id"]))
    assert len(_purchases(ws["id"])) == 2


def test_loi_moi_treo_qua_lau_khong_keo_di_mua_suat(
    client: TestClient, auth_header: dict
):
    """Ca thật GPT1 `lucrativoa2@gmail.com`: treo 11 ngày chưa ai nhận.

    "Còn trong tab Lời mời" ≠ "sẽ được nhận". Mua suất cho lời mời đã nguội là trả
    phí THÁNG lặp lại cho một chỗ ngồi nhiều khả năng bỏ trống.
    """
    ws = _ws_with_pending(client, auth_header, "Auto Buy Stale WS")
    _age_pending(ws["id"], days=11)
    _finish_sync(client, ws, _sync_item(ws["id"]))

    assert _purchases(ws["id"]) == []


def test_loi_moi_moi_gui_van_duoc_mua_bu(client: TestClient, auth_header: dict):
    """Ca thật CHATGPT PRO `lampesdafret22@gmail.com`: mời 2 ngày trước, hạn thuê
    bao còn xa ⇒ vẫn mua bù như thường. Rào chống lời mời cũ không được chặn oan."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy Fresh WS")
    _age_pending(ws["id"], days=2)
    _finish_sync(client, ws, _sync_item(ws["id"]))

    got = _purchases(ws["id"])
    assert len(got) == 1 and got[0]["quantity"] == 1


def test_moi_lai_lam_loi_moi_tuoi_lai(client: TestClient, auth_header: dict):
    """Member tạo từ 30 ngày trước nhưng admin vừa bấm "Mời lại" hôm qua ⇒ tính
    theo lần mời GẦN NHẤT, vẫn đáng mua suất."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy Reinvite WS")
    _age_pending(ws["id"], days=30, last_invited_days=1)
    _finish_sync(client, ws, _sync_item(ws["id"]))

    assert len(_purchases(ws["id"])) == 1


def test_het_han_thue_bao_thi_khong_mua(client: TestClient, auth_header: dict):
    """Lời mời còn mới nhưng hạn thuê bao đã qua — có nhận cũng không còn gì để
    dùng, mua suất là mua cho một chỗ ngồi trống."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy Expired WS")
    _age_pending(ws["id"], days=1, sub_end_days_ago=1)
    _finish_sync(client, ws, _sync_item(ws["id"]))

    assert _purchases(ws["id"]) == []


def test_task_hong_thi_khong_mua(client: TestClient, auth_header: dict):
    """Sync FAILED thì số nó mang về không đủ tin để tiêu tiền."""
    ws = _ws_with_pending(client, auth_header, "Auto Buy Failed WS")
    item_id = _sync_item(ws["id"])
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "TIMEOUT",
            "result": {
                "seat_total": 60,
                "seat_assigned": 60,
                "seat_uncertain": False,
                "invites_scanned": True,
                "reconcile_skipped": False,
            },
        },
        headers=_ext(ws),
    )
    assert r.status_code == 200, r.text
    assert _purchases(ws["id"]) == []
