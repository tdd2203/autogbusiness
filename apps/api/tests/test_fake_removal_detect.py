"""Dò XOÁ-GIẢ khi đồng bộ (sự cố 03→12/8/2026).

Extension được phép kết luận "member đã rời workspace" chỉ bằng ô lọc, KHÔNG click
xoá (`removal_evidence='absent_confirmed'` — xem `queue/completion.py`). Khi kết luận
đó SAI thì backend mark removed cho email VẪN CÒN trên ChatGPT: email vẫn ăn ghế, còn
dashboard giấu luôn khỏi danh sách gia hạn (chỉ hiện active/pending) → im lặng tới lần
full sync kế tiếp (thực tế: 11 ngày).

Lần sync thấy lại email đó chính là BẰNG CHỨNG lần xoá trước là giả. File này kiểm
`_flag_fake_removals` (members/reconcile.py) biến bằng chứng đó thành 1 dòng nhật ký
`MEMBER_REMOVE_FAKE_DETECTED` đích danh, thay vì trôi qua im lặng như trước.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog, Member


def _make_workspace(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()


def _sync(client: TestClient, ws: dict, email: str, status: str = "active") -> dict:
    """Extension đồng bộ: ChatGPT vẫn trả về `email` với trạng thái `status`."""
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": email, "status": status}],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def _mark_removed(email: str, evidence: str) -> None:
    """Giả lập lần gỡ trước: member 'removed' + audit MEMBER_REMOVED_SYNCED kèm
    bằng chứng gỡ (`absent_confirmed` = không click / `clicked_and_verified` = có)."""
    removed_at = datetime.now(timezone.utc) - timedelta(days=3)
    with SessionLocal() as db:
        member = db.query(Member).filter(Member.email == email).one()
        member.status = "removed"
        member.removed_at = removed_at
        db.add(
            AuditLog(
                actor_type="EXTENSION",
                action="MEMBER_REMOVED_SYNCED",
                result="COMPLETED",
                target_type="MEMBER",
                target_id=str(member.id),
                data={"email": email, "removal_evidence": evidence},
                timestamp=removed_at,
            )
        )
        db.commit()


def _fake_alerts(email: str) -> list[AuditLog]:
    with SessionLocal() as db:
        return (
            db.query(AuditLog)
            .filter(
                AuditLog.action == "MEMBER_REMOVE_FAKE_DETECTED",
                AuditLog.data["email"].astext == email,
            )
            .all()
        )


def test_sync_hoi_sinh_member_absent_confirmed_thi_bao_xoa_gia(
    client: TestClient, auth_header: dict
) -> None:
    """GUARD chính: member bị mark removed bằng `absent_confirmed` (không click)
    nay sync lại thấy CÒN → ghi MEMBER_REMOVE_FAKE_DETECTED + trả email trong
    `fake_removed_emails` để dashboard cảnh báo."""
    ws = _make_workspace(client, auth_header, "WS xoá-giả")
    email = "fake-removed@example.com"
    _sync(client, ws, email)
    _mark_removed(email, "absent_confirmed")

    body = _sync(client, ws, email)

    assert body["fake_removed_emails"] == [email], body
    alerts = _fake_alerts(email)
    assert len(alerts) == 1, [a.data for a in alerts]
    assert alerts[0].result == "ERROR"
    assert alerts[0].actor_type == "SYSTEM"
    assert alerts[0].data["removal_evidence"] == "absent_confirmed"
    # Email phải được đưa lại về active để tick 60s gỡ lại (lần này có click).
    with SessionLocal() as db:
        assert db.query(Member).filter(Member.email == email).one().status == "active"


def test_khong_bao_khi_lan_go_truoc_da_click_va_xac_minh(
    client: TestClient, auth_header: dict
) -> None:
    """Gỡ THẬT (`clicked_and_verified`) rồi email quay lại = được MỜI LẠI, không
    phải xoá-giả → tuyệt đối không ghi cảnh báo (kẻo nhật ký đầy báo động giả)."""
    ws = _make_workspace(client, auth_header, "WS mời lại")
    email = "reinvited@example.com"
    _sync(client, ws, email)
    _mark_removed(email, "clicked_and_verified")

    body = _sync(client, ws, email)

    assert body["fake_removed_emails"] == []
    assert _fake_alerts(email) == []


def test_khong_bao_trung_o_cac_lan_sync_sau(
    client: TestClient, auth_header: dict
) -> None:
    """Sync lần 2, 3… member đã active nên KHÔNG còn là ca hồi sinh → chỉ đúng 1
    cảnh báo cho mỗi lần xoá-giả (idempotent tự nhiên)."""
    ws = _make_workspace(client, auth_header, "WS lặp")
    email = "once@example.com"
    _sync(client, ws, email)
    _mark_removed(email, "absent_confirmed")

    _sync(client, ws, email)
    body2 = _sync(client, ws, email)

    assert body2["fake_removed_emails"] == []
    assert len(_fake_alerts(email)) == 1
