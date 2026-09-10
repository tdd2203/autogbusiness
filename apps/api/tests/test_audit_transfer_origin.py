"""Nhật ký: lệnh mời / lệnh gỡ sinh ra từ một lần ĐỔI EMAIL phải tự kể được nó từ đâu ra.

Ca thật (user 10/9/2026, ảnh mốc 08:31:43): admin bấm "Chuyển hạn sử dụng đến" cho
hungcuong128 → cuongnh. Trang nhật ký gom nhóm theo `queue_item_id`, mà dòng của
admin (`MEMBER_SUBSCRIPTION_TRANSFERRED`) chỉ mang `invite_queue_item_id` /
`remove_queue_item_id` ⇒ lệnh mời cuongnh hiện "Mời thành viên · Tự động", không một
chữ nào nói nó là kết quả của lần đổi email. Endpoint đọc nay nối hai chiều:

  • dòng của admin nhận `queue_item_id` = lệnh MỜI (không mời thì lệnh GỠ) để về
    chung nhóm với chính lệnh đó;
  • MỌI dòng của cả hai lệnh nhận `data.transfer_origin` (email cũ → mới, ai bấm,
    nhánh mời hay gỡ) — dòng của admin nằm ngoài cửa sổ trang thì lệnh vẫn tự kể.

Phân giải lúc đọc, không sửa dòng đã ghi ⇒ áp được cho cả 61 lần đổi email cũ.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Audit Transfer WS", "plan": "business", "seat_total": 50},
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
) -> None:
    resp = client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json={"subscription_months": months},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text


def _task(client: TestClient, ws_id: str, headers: dict, ttype: str, email: str) -> dict:
    resp = client.get(f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return next(
        t for t in resp.json() if t["type"] == ttype and t["payload"]["email"] == email
    )


def _finish(client: TestClient, ws: dict, task_id: str, body: dict) -> None:
    resp = client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "COMPLETED", **body},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _audit(client: TestClient, headers: dict) -> list[dict]:
    resp = client.get("/api/v1/audit-logs?limit=200", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _row(logs: list[dict], action: str, qid: str | None = None) -> dict:
    """Dòng nhật ký `action` của lệnh `qid`. Dòng cấp hàng đợi (QUEUE_UPDATED…) neo
    lệnh bằng `target_id`, dòng cấp thành viên neo bằng `data.queue_item_id`."""
    for x in logs:
        if x["action"] != action:
            continue
        d = x.get("data") or {}
        if qid is None or d.get("queue_item_id") == qid or x.get("target_id") == qid:
            return x
    raise AssertionError(f"không thấy {action} {qid} trong {[x['action'] for x in logs]}")


def test_transfer_row_joins_invite_task_and_both_tasks_carry_origin(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["give@example.com"])
    src = _members(client, ws["id"], auth_header)["give@example.com"]
    _set_subscription(client, ws["id"], src["id"], 3, auth_header)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{src['id']}/transfer-subscription",
        json={"target_email": "take@example.com"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    invite = _task(client, ws["id"], auth_header, "INVITE_MEMBER", "take@example.com")
    remove = _task(client, ws["id"], auth_header, "REMOVE_MEMBER", "give@example.com")

    # (1) Dòng của admin đứng chung nhóm với LỆNH MỜI và tự mang ngữ cảnh.
    row = _row(_audit(client, auth_header), "MEMBER_SUBSCRIPTION_TRANSFERRED")
    assert row["data"]["queue_item_id"] == invite["id"]
    assert row["data"]["invite_queue_item_id"] == invite["id"]  # trường gốc giữ nguyên
    origin = row["data"]["transfer_origin"]
    assert origin["kind"] == "subscription_transfer"
    assert origin["leg"] == "invite"
    assert origin["source_email"] == "give@example.com"
    assert origin["target_email"] == "take@example.com"
    assert origin["mode"] == "fresh"
    assert origin["actor_type"] == "ADMIN"
    assert origin["actor_label"] == row["actor_label"]

    # (2) Tiện ích chạy xong hai lệnh → mọi dòng của mỗi lệnh mang ngữ cảnh đúng nhánh.
    _finish(client, ws, invite["id"], {"result": {}})
    _finish(client, ws, remove["id"], {"result": {"data": {"verified": True}}})
    logs = _audit(client, auth_header)

    for action in ("MEMBER_INVITE_VERIFIED", "QUEUE_UPDATED:INVITE_MEMBER"):
        o = _row(logs, action, invite["id"])["data"]["transfer_origin"]
        assert o["leg"] == "invite", action
        assert o["source_email"] == "give@example.com", action
        assert o["target_email"] == "take@example.com", action
        assert o["actor_label"] == row["actor_label"], action

    for action in ("MEMBER_REMOVED_SYNCED", "QUEUE_UPDATED:REMOVE_MEMBER"):
        o = _row(logs, action, remove["id"])["data"]["transfer_origin"]
        assert o["leg"] == "remove", action
        assert o["source_email"] == "give@example.com", action
        assert o["target_email"] == "take@example.com", action
        assert o["kind"] == "subscription_transfer", action

    # (3) Dòng của admin nằm NGOÀI trang đang tải (cửa sổ 200 dòng đã trôi): các dòng
    # của lệnh vẫn tự kể được — đây là lý do tra ngược theo id lệnh chứ không tìm
    # trong chính trang.
    page = client.get("/api/v1/audit-logs?limit=2", headers=auth_header).json()
    assert page and all(x["action"] != "MEMBER_SUBSCRIPTION_TRANSFERRED" for x in page)
    of_remove = [
        x
        for x in page
        if x.get("target_id") == remove["id"]
        or (x.get("data") or {}).get("queue_item_id") == remove["id"]
    ]
    assert of_remove, [x["action"] for x in page]
    for x in of_remove:
        o = x["data"]["transfer_origin"]
        assert o["leg"] == "remove" and o["actor_label"] == row["actor_label"], x["action"]


def test_failed_removal_rows_carry_origin(client: TestClient, auth_header: dict) -> None:
    """Lệnh gỡ email cũ HỎNG: dòng cảnh báo lẫn dòng hàng đợi đều mang ngữ cảnh nhánh
    gỡ, để nhật ký nói "chưa gỡ được, hạn đã chuyển sang…" thay vì "Gỡ thành viên"."""
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["stuck@example.com"])
    src = _members(client, ws["id"], auth_header)["stuck@example.com"]
    _set_subscription(client, ws["id"], src["id"], 2, auth_header)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{src['id']}/transfer-subscription",
        json={"target_email": "moved@example.com"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    remove = _task(client, ws["id"], auth_header, "REMOVE_MEMBER", "stuck@example.com")

    resp = client.patch(
        f"/api/v1/queue/{remove['id']}",
        json={
            "status": "FAILED",
            "error_code": "MEMBER_NOT_FOUND",
            "error_message": "không thấy ở cả hai tab",
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text

    logs = _audit(client, auth_header)
    for action in ("MEMBER_EMAIL_CHANGE_REMOVE_FAILED", "QUEUE_UPDATED:REMOVE_MEMBER"):
        o = _row(logs, action, remove["id"])["data"]["transfer_origin"]
        assert o["leg"] == "remove", action
        assert o["source_email"] == "stuck@example.com", action
        assert o["target_email"] == "moved@example.com", action


def test_accumulate_transfer_row_joins_remove_task(
    client: TestClient, auth_header: dict
) -> None:
    """Cộng dồn vào email đang dùng: không có lệnh mời ⇒ dòng của admin về chung
    nhóm với lệnh GỠ email cho, ngữ cảnh ghi rõ mode accumulate."""
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["src@example.com", "dst@example.com"])
    members = _members(client, ws["id"], auth_header)
    _set_subscription(client, ws["id"], members["src@example.com"]["id"], 1, auth_header)
    _set_subscription(client, ws["id"], members["dst@example.com"]["id"], 2, auth_header)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{members['src@example.com']['id']}/transfer-subscription",
        json={"target_email": "dst@example.com"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    remove = _task(client, ws["id"], auth_header, "REMOVE_MEMBER", "src@example.com")

    row = _row(_audit(client, auth_header), "MEMBER_SUBSCRIPTION_TRANSFERRED")
    assert row["data"]["invite_queue_item_id"] is None
    assert row["data"]["queue_item_id"] == remove["id"]
    assert row["data"]["transfer_origin"]["leg"] == "remove"
    assert row["data"]["transfer_origin"]["mode"] == "accumulate"

    _finish(client, ws, remove["id"], {"result": {"data": {"verified": True}}})
    o = _row(
        _audit(client, auth_header), "MEMBER_REMOVED_SYNCED", remove["id"]
    )["data"]["transfer_origin"]
    assert o == {
        **o,
        "leg": "remove",
        "mode": "accumulate",
        "source_email": "src@example.com",
        "target_email": "dst@example.com",
    }


def test_legacy_change_email_row_joins_invite_task(
    client: TestClient, auth_header: dict
) -> None:
    """Endpoint đổi email cũ (client cũ + 52 dòng lịch sử) đi cùng đường, kind riêng."""
    ws = _create_workspace(client, auth_header)
    _upsert_active(client, ws, ["old@example.com"])
    old = _members(client, ws["id"], auth_header)["old@example.com"]
    _set_subscription(client, ws["id"], old["id"], 1, auth_header)

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{old['id']}/change-email",
        json={"new_email": "new@example.com"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    invite = _task(client, ws["id"], auth_header, "INVITE_MEMBER", "new@example.com")
    remove = _task(client, ws["id"], auth_header, "REMOVE_MEMBER", "old@example.com")

    row = _row(_audit(client, auth_header), "MEMBER_EMAIL_CHANGED")
    assert row["data"]["queue_item_id"] == invite["id"]
    o = row["data"]["transfer_origin"]
    assert o["kind"] == "email_change"
    assert o["leg"] == "invite"
    assert o["source_email"] == "old@example.com"
    assert o["target_email"] == "new@example.com"
    assert o["mode"] is None

    _finish(client, ws, invite["id"], {"result": {}})
    _finish(client, ws, remove["id"], {"result": {"data": {"verified": True}}})
    logs = _audit(client, auth_header)
    assert (
        _row(logs, "MEMBER_INVITE_VERIFIED", invite["id"])["data"][
            "transfer_origin"
        ]["kind"]
        == "email_change"
    )
    assert (
        _row(logs, "MEMBER_REMOVED_SYNCED", remove["id"])["data"][
            "transfer_origin"
        ]["leg"]
        == "remove"
    )


def test_plain_invite_carries_no_origin(client: TestClient, auth_header: dict) -> None:
    """Lệnh mời thường không được gán bừa ngữ cảnh đổi email."""
    ws = _create_workspace(client, auth_header)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "plain@example.com", "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    invite = _task(client, ws["id"], auth_header, "INVITE_MEMBER", "plain@example.com")
    _finish(client, ws, invite["id"], {"result": {}})

    logs = _audit(client, auth_header)
    for action in ("MEMBER_INVITE_QUEUED", "MEMBER_INVITE_VERIFIED", "QUEUE_UPDATED:INVITE_MEMBER"):
        d = _row(logs, action, invite["id"])["data"]
        assert "transfer_origin" not in d, action
