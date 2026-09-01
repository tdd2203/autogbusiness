"""Đổi email mà lệnh GỠ email cũ báo HỎNG — phải gắn cờ NGAY, không chờ đồng bộ.

Ca thật 1/9/2026 (`lethithuphuong14042002` → `lttp1404`): `REVOKE_INVITES` chết với
`FAILED_UI_CHANGED` lúc 14:05, nhưng bản ghi email cũ vẫn nằm im ở `removed` nên modal
chi tiết khoe "Đã xoá · hạn theo lttp1404" trong khi email cũ còn nguyên trên ChatGPT.
Cửa duy nhất phát hiện là một lần `SYNC_DATA` scope 'both' THÀNH CÔNG thấy lại email
(`members/reconcile.py::_mark_email_change_stuck`) — mà hai lần đồng bộ theo lịch ngay
sau đó đều `CONTENT_TIMEOUT`, nên không ai biết cho tới khi user tự mở ChatGPT ra soi.

Bản vá KHÔNG đoán hộ trạng thái (task hỏng ≠ bằng chứng email còn trên ChatGPT — lỗi
thật của ca trên là "không thấy ở CẢ HAI tab"): không hồi sinh `removed` → `active`,
không tự xếp lại lệnh gỡ. Nó chỉ để lại dấu vết đọc được (`email_change_stuck_at` +
nhật ký `MEMBER_EMAIL_CHANGE_REMOVE_FAILED`) để UI nói "đã ra lệnh xoá, CHƯA xác nhận"
thay vì "đã xoá". Quyền phán "email còn hay hết" vẫn thuộc về đồng bộ.

File này chốt: gắn cờ khi hỏng · gỡ cờ khi gỡ được thật · KHÔNG gắn bừa cho lệnh xoá
thường.
"""

import uuid

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AuditLog, Member, QueueItem


def _ws(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Remove-failed WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _sync(client: TestClient, ws: dict, rows: list[tuple[str, str]]) -> None:
    """Đồng bộ báo về: (email, status) đang có trên ChatGPT."""
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": e,
                    "name": e.split("@")[0],
                    "chatgpt_role": "member",
                    "status": st,
                }
                for e, st in rows
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _member(client: TestClient, ws_id: str, email: str, headers: dict) -> dict:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=headers
    )
    assert resp.status_code == 200, resp.text
    by_email = {m["email"]: m for m in resp.json()}
    assert email in by_email, f"{email} không có trong danh sách"
    return by_email[email]


def _change_email(
    client: TestClient, ws_id: str, member_id: str, new_email: str, headers: dict
):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/change-email",
        json={"new_email": new_email},
        headers=headers,
    )


def _task_of_type(client: TestClient, ws_id: str, kind: str, headers: dict) -> dict:
    tasks = client.get(
        f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers
    ).json()
    match = [t for t in tasks if t["type"] == kind]
    assert match, f"không thấy task {kind}"
    return match[0]


def _patch_task(client: TestClient, ws: dict, task_id: str, body: dict):
    return client.patch(
        f"/api/v1/queue/{task_id}",
        json=body,
        headers={"X-API-KEY": ws["extension_api_key"]},
    )


def _new_task(ws_id: str, kind: str, payload: dict) -> str:
    """Xếp thẳng một task vào hàng đợi (đóng vai lượt gỡ LẦN SAU)."""
    with SessionLocal() as db:
        qi = QueueItem(
            type=kind, status="PENDING", workspace_id=uuid.UUID(ws_id), payload=payload
        )
        db.add(qi)
        db.commit()
        return str(qi.id)


def _stuck_of(member_id: str) -> tuple[object, object]:
    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        return m.email_change_stuck_at, m.email_change_stuck_to


def test_remove_member_failed_flags_old_email_immediately(
    client: TestClient, auth_header: dict
) -> None:
    """Email cũ ĐANG hoạt động: REMOVE_MEMBER hỏng ⇒ cờ + nhật ký, ngay lập tức."""
    ws = _ws(client, auth_header)
    _sync(client, ws, [("old1@example.com", "active")])
    old = _member(client, ws["id"], "old1@example.com", auth_header)

    assert (
        _change_email(client, ws["id"], old["id"], "new1@example.com", auth_header).status_code
        == 201
    )
    remove_task = _task_of_type(client, ws["id"], "REMOVE_MEMBER", auth_header)

    # Trước khi extension báo về: chưa có gì để nói là hỏng.
    assert _stuck_of(old["id"]) == (None, None)

    resp = _patch_task(
        client,
        ws,
        remove_task["id"],
        {
            "status": "FAILED",
            "error_code": "FAILED_UI_CHANGED",
            "error_message": "Không tìm thấy old1@example.com trong tab Người dùng",
        },
    )
    assert resp.status_code == 200, resp.text

    stuck_at, stuck_to = _stuck_of(old["id"])
    assert stuck_at is not None, "lệnh gỡ hỏng mà bản ghi không mang dấu vết nào"
    assert stuck_to == "new1@example.com"

    # KHÔNG đoán hộ: bản ghi vẫn `removed` (task hỏng không phải bằng chứng email còn
    # trên ChatGPT) — đồng bộ mới là nơi chốt.
    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(old["id"]))
        assert m.status == "removed"
        assert m.removed_reason == "email_changed"

    with SessionLocal() as db:
        log = (
            db.query(AuditLog)
            .filter(
                AuditLog.action == "MEMBER_EMAIL_CHANGE_REMOVE_FAILED",
                AuditLog.target_id == old["id"],
            )
            .one_or_none()
        )
    assert log is not None, "không có nhật ký nào để timeline hiện dòng đỏ"
    assert log.data["new_email"] == "new1@example.com"
    assert log.data["error_code"] == "FAILED_UI_CHANGED"

    # Web phải ĐỌC được cờ, kẻo modal vẫn khoe "Đã xoá" như cũ.
    row = client.get(f"/api/v1/added-members/{old['id']}", headers=auth_header)
    assert row.status_code == 200, row.text
    assert row.json()["email_change_stuck_at"] is not None
    assert row.json()["email_change_stuck_to"] == "new1@example.com"


def test_revoke_invites_failed_then_success_clears_flag(
    client: TestClient, auth_header: dict
) -> None:
    """Email cũ đang CHỜ THAM GIA: REVOKE hỏng ⇒ cờ; thu hồi được thật ⇒ gỡ cờ.

    Lượt thu hồi sau chốt trên một bản ghi ĐÃ ở `removed` (đổi email đánh dấu ngay lúc
    bấm) nên nó KHÔNG lọt vào nhánh mark-removed thông thường — không gỡ cờ ở đúng chỗ
    đó thì cảnh báo "chưa xác nhận" treo vĩnh viễn trên một email đã đi thật.
    """
    ws = _ws(client, auth_header)
    _sync(client, ws, [("old2@example.com", "pending")])
    old = _member(client, ws["id"], "old2@example.com", auth_header)
    assert old["status"] == "pending"

    assert (
        _change_email(client, ws["id"], old["id"], "new2@example.com", auth_header).status_code
        == 201
    )
    revoke_task = _task_of_type(client, ws["id"], "REVOKE_INVITES", auth_header)
    assert _patch_task(
        client,
        ws,
        revoke_task["id"],
        {
            "status": "FAILED",
            "error_code": "FAILED_UI_CHANGED",
            "error_message": "Không có trên tab Lời mời; xoá khỏi tab Người dùng cũng thất bại",
        },
    ).status_code == 200

    stuck_at, stuck_to = _stuck_of(old["id"])
    assert stuck_at is not None and stuck_to == "new2@example.com"

    # Lượt thu hồi sau ăn: cờ phải sạch.
    retry_id = _new_task(ws["id"], "REVOKE_INVITES", {"emails": ["old2@example.com"]})
    assert _patch_task(
        client,
        ws,
        retry_id,
        {
            "status": "COMPLETED",
            "result": {"data": {"results": [{"email": "old2@example.com", "ok": True}]}},
        },
    ).status_code == 200

    assert _stuck_of(old["id"]) == (None, None), (
        "gỡ được thật rồi mà cờ 'chưa xác nhận' vẫn treo"
    )


def test_remove_member_success_clears_flag_on_already_removed_row(
    client: TestClient, auth_header: dict
) -> None:
    """Lượt gỡ SAU thành công (có bằng chứng) trên dòng đã `removed` ⇒ gỡ cờ."""
    ws = _ws(client, auth_header)
    _sync(client, ws, [("old3@example.com", "active")])
    old = _member(client, ws["id"], "old3@example.com", auth_header)
    assert (
        _change_email(client, ws["id"], old["id"], "new3@example.com", auth_header).status_code
        == 201
    )
    remove_task = _task_of_type(client, ws["id"], "REMOVE_MEMBER", auth_header)
    assert _patch_task(
        client, ws, remove_task["id"], {"status": "FAILED", "error_code": "TIMEOUT"}
    ).status_code == 200
    assert _stuck_of(old["id"])[0] is not None

    retry_id = _new_task(
        ws["id"],
        "REMOVE_MEMBER",
        {"member_id": old["id"], "email": "old3@example.com"},
    )
    assert _patch_task(
        client,
        ws,
        retry_id,
        {"status": "COMPLETED", "result": {"data": {"verified": True}}},
    ).status_code == 200

    assert _stuck_of(old["id"]) == (None, None)
    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(old["id"]))
        # Lý do rời team là của lần ĐỔI EMAIL, không phải "admin xoá" của lượt dọn muộn.
        assert m.removed_reason == "email_changed"


def test_plain_remove_failure_does_not_flag_anything(
    client: TestClient, auth_header: dict
) -> None:
    """Xoá thường hỏng thì KHÔNG dính cờ đổi-email — cờ chỉ nói về ca đổi email."""
    ws = _ws(client, auth_header)
    _sync(client, ws, [("plain@example.com", "active")])
    plain = _member(client, ws["id"], "plain@example.com", auth_header)

    task_id = _new_task(
        ws["id"], "REMOVE_MEMBER", {"member_id": plain["id"], "email": "plain@example.com"}
    )
    assert _patch_task(
        client, ws, task_id, {"status": "FAILED", "error_code": "FAILED_UI_CHANGED"}
    ).status_code == 200

    assert _stuck_of(plain["id"]) == (None, None)
    with SessionLocal() as db:
        assert (
            db.query(AuditLog)
            .filter(AuditLog.action == "MEMBER_EMAIL_CHANGE_REMOVE_FAILED")
            .filter(AuditLog.target_id == plain["id"])
            .count()
            == 0
        )
