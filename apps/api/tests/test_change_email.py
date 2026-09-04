"""Change email — POST /workspaces/{ws}/members/{id}/change-email.

Nghiệp vụ: khách đổi email → xoá email cũ + mời email mới, GIỮ NGUYÊN hạn dùng cũ.

Xác minh:
  - Member ĐANG HOẠT ĐỘNG: enqueue REMOVE_MEMBER(email cũ) + INVITE_MEMBER(email mới).
  - Member CHỜ THAM GIA: cũng REMOVE_MEMBER(email cũ) + INVITE_MEMBER — extension
    tìm ở tab Người dùng rồi tự lùi sang tab Lời mời (4/9/2026, xem change_email.py).
  - Member mới (email mới) status=pending, subscription_end_at == hạn cũ (copy y nguyên);
    last_invited_at kế thừa từ email gốc (thời gian mời/tham gia giữ nguyên).
  - Member cũ → status=removed ngay trong DB, và HẠN ĐÓNG NGAY (hạn đã theo email mới
    đi ⇒ dòng cũ không được giữ bản sao mốc hết hạn — nếu giữ thì mời lại email cũ
    được coi là "còn hạn → miễn phí", xem test_change_email_closes_old_member_window).
  - new_email trùng email cũ → 400.
  - new_email đã là member active khác → 409.
  - Đổi email của member đã removed → 409.
"""

import uuid
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Member


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Change Email WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upsert_active(client: TestClient, ws: dict, emails: list[str]) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": e,
                    "name": e.split("@")[0],
                    "chatgpt_role": "member",
                    "status": "active",
                }
                for e in emails
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _members(client: TestClient, ws_id: str, headers: dict) -> dict:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return {m["email"]: m for m in resp.json()}


def _set_subscription(
    client: TestClient, ws_id: str, member_id: str, months: int, headers: dict
) -> str:
    resp = client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json={"subscription_months": months},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["subscription_end_at"]


def _tasks(client: TestClient, ws_id: str, headers: dict, ttype: str) -> list[dict]:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return [t for t in resp.json() if t["type"] == ttype]


def _change_email(
    client: TestClient, ws_id: str, member_id: str, new_email: str, headers: dict
):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/change-email",
        json={"new_email": new_email},
        headers=headers,
    )


def test_change_email_closes_old_member_window(
    client: TestClient, auth_header: dict
):
    """Email CŨ phải MẤT hạn ngay khi đổi — hạn đã theo email mới đi.

    Không đóng thì `_is_paid_period_active` vẫn thấy "còn hạn" trên dòng cũ ⇒ mời lại
    chính email đó được MIỄN PHÍ và giữ nguyên cửa sổ, trong khi email mới đang tiêu
    đúng kỳ đã trả đó — một suất đã trả thành hai người dùng (sửa 24/8/2026).
    """
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["holder@example.com"])
    old = _members(client, ws["id"], auth_header)["holder@example.com"]
    old_end = _set_subscription(client, ws["id"], old["id"], 3, auth_header)
    assert old_end is not None

    resp = _change_email(client, ws["id"], old["id"], "receiver@example.com", auth_header)
    assert resp.status_code == 201, resp.text

    with SessionLocal() as db:
        source = db.get(Member, uuid.UUID(old["id"]))
        target = db.get(Member, uuid.UUID(resp.json()["id"]))
        # Email mới giữ NGUYÊN hạn cũ (đây là chuyển chỗ, không phải kỳ mới)...
        # So sánh theo THỜI ĐIỂM, không theo chuỗi: API trả "…Z" còn isoformat() của
        # Python cho "…+00:00" — cùng một mốc, khác cách viết.
        assert target.subscription_end_at is not None
        assert target.subscription_end_at == datetime.fromisoformat(
            old_end.replace("Z", "+00:00")
        )
        # ...còn email cũ hết hạn NGAY, và KHÔNG được là None ("vô thời hạn").
        assert source.subscription_end_at is not None
        assert source.subscription_end_at <= datetime.now(timezone.utc)
        assert source.removed_at is not None
        assert source.subscription_end_at == source.removed_at


def test_change_email_carries_expiry_and_enqueues_two_tasks(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["old@example.com"])
    old = _members(client, ws["id"], auth_header)["old@example.com"]
    old_end = _set_subscription(client, ws["id"], old["id"], 3, auth_header)
    assert old_end is not None

    resp = _change_email(client, ws["id"], old["id"], "new@example.com", auth_header)
    assert resp.status_code == 201, resp.text
    new_member = resp.json()
    assert new_member["email"] == "new@example.com"
    assert new_member["status"] == "pending"
    # Hạn dùng GIỮ NGUYÊN — copy y nguyên, KHÔNG tính lại từ now.
    assert new_member["subscription_end_at"] == old_end

    # Member ĐANG HOẠT ĐỘNG → gỡ bằng REMOVE_MEMBER (tab Người dùng), KHÔNG revoke.
    removes = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")
    invites = _tasks(client, ws["id"], auth_header, "INVITE_MEMBER")
    assert [t["payload"]["email"] for t in removes] == ["old@example.com"]
    assert [t["payload"]["email"] for t in invites] == ["new@example.com"]
    assert _tasks(client, ws["id"], auth_header, "REVOKE_INVITES") == []

    # Member cũ → removed ngay; member mới → pending với hạn cũ.
    members = _members(client, ws["id"], auth_header)
    assert members["old@example.com"]["status"] == "removed"
    assert members["new@example.com"]["subscription_end_at"] == old_end


def test_change_email_pending_uses_remove_and_carries_invite_time(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    # Tạo member CHỜ THAM GIA qua invite → có last_invited_at + hạn dùng cụ thể.
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "pending-old@example.com", "subscription_months": 2},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    old = resp.json()
    assert old["status"] == "pending"
    old_invited_at = old["last_invited_at"]
    old_end = old["subscription_end_at"]
    assert old_invited_at is not None

    resp = _change_email(
        client, ws["id"], old["id"], "pending-new@example.com", auth_header
    )
    assert resp.status_code == 201, resp.text
    new_member = resp.json()
    assert new_member["email"] == "pending-new@example.com"
    assert new_member["status"] == "pending"
    # Hạn dùng + thời gian mời (last_invited_at) kế thừa Y NGUYÊN từ email gốc.
    assert new_member["subscription_end_at"] == old_end
    assert new_member["last_invited_at"] == old_invited_at

    # Member CHỜ THAM GIA cũng gỡ bằng REMOVE_MEMBER (4/9/2026): trạng thái trong DB
    # có thể đã cũ (người ta vừa bấm nhận lời mời), mà lệnh thu hồi gặp thành viên đã
    # tham gia là hỏng hẳn — extension đi từ tab "Người dùng" rồi tự lùi sang tab
    # "Lời mời đang chờ xử lý" nên đúng cho cả hai ca.
    removes = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")
    assert [t["payload"]["email"] for t in removes] == ["pending-old@example.com"]
    assert _tasks(client, ws["id"], auth_header, "REVOKE_INVITES") == []
    # Vẫn mời email mới.
    invite_emails = {
        t["payload"].get("email")
        for t in _tasks(client, ws["id"], auth_header, "INVITE_MEMBER")
    }
    assert "pending-new@example.com" in invite_emails

    members = _members(client, ws["id"], auth_header)
    assert members["pending-old@example.com"]["status"] == "removed"
    assert members["pending-new@example.com"]["status"] == "pending"


def _added_row(client: TestClient, headers: dict, email: str) -> dict | None:
    rows = client.get("/api/v1/added-members", headers=headers).json()
    return next((r for r in rows if r["email"] == email), None)


def test_change_email_carries_payment_status_and_cycles(
    client: TestClient, auth_header: dict
):
    """Đổi email = đổi tên: trạng thái ĐÃ THANH TOÁN + lịch sử chu kỳ phải theo
    sang email mới, không reset về unpaid."""
    ws = _create_workspace(client, auth_header)
    # Invite với gói tháng → member đã "paid" + có 1 chu kỳ (mô hình phí trước).
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "paid-old@example.com", "subscription_months": 1},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    old = resp.json()

    old_row = _added_row(client, auth_header, "paid-old@example.com")
    assert old_row is not None
    assert old_row["payment_status"] == "paid"
    old_cycle_count = len(old_row["cycles"])
    assert old_cycle_count >= 1

    resp = _change_email(
        client, ws["id"], old["id"], "paid-new@example.com", auth_header
    )
    assert resp.status_code == 201, resp.text

    # Email mới kế thừa NGUYÊN trạng thái đã thanh toán + toàn bộ chu kỳ (move).
    new_row = _added_row(client, auth_header, "paid-new@example.com")
    assert new_row is not None
    assert new_row["payment_status"] == "paid"
    assert len(new_row["cycles"]) == old_cycle_count
    assert all(c["payment_status"] == "paid" for c in new_row["cycles"])
    # Email cũ đã removed → không còn trong danh sách added-members.
    assert _added_row(client, auth_header, "paid-old@example.com") is None


def test_change_email_same_as_current_rejected(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["same@example.com"])
    m = _members(client, ws["id"], auth_header)["same@example.com"]
    resp = _change_email(client, ws["id"], m["id"], "SAME@example.com", auth_header)
    assert resp.status_code == 400, resp.text


def test_change_email_to_existing_active_rejected(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["a@example.com", "b@example.com"])
    a = _members(client, ws["id"], auth_header)["a@example.com"]
    resp = _change_email(client, ws["id"], a["id"], "b@example.com", auth_header)
    assert resp.status_code == 409, resp.text


def test_change_email_of_removed_member_rejected(
    client: TestClient, auth_header: dict
):
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["gone@example.com"])
    m = _members(client, ws["id"], auth_header)["gone@example.com"]
    # Xoá rồi extension hoàn tất → removed.
    rm = client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{m['id']}", headers=auth_header
    )
    assert rm.status_code == 202, rm.text
    task = _tasks(client, ws["id"], auth_header, "REMOVE_MEMBER")[0]
    client.patch(
        f"/api/v1/queue/{task['id']}",
        # CONTRACT v0.9.22: mark removed cần bằng chứng đã rời (result.data.verified).
        json={"status": "COMPLETED", "result": {"data": {"verified": True}}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    resp = _change_email(client, ws["id"], m["id"], "fresh@example.com", auth_header)
    assert resp.status_code == 409, resp.text
