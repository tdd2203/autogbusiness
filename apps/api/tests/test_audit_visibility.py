"""Sub-admin có AUDIT_LOG_VIEW chỉ thấy nhật ký email/thông tin của chính họ."""

from fastapi.testclient import TestClient

from tests.test_workspace_member import (
    _bearer,
    _create_sub_admin,
    _login_token,
    _setup_ws_and_sub_admin,
)


def _emails_in_logs(logs: list[dict]) -> set[str]:
    out: set[str] = set()
    for lg in logs:
        d = lg.get("data") or {}
        if isinstance(d.get("email"), str):
            out.add(d["email"].lower())
        for e in d.get("emails") or []:
            if isinstance(e, str):
                out.add(e.lower())
        for entry in d.get("entries") or []:
            if isinstance(entry, dict) and isinstance(entry.get("email"), str):
                out.add(entry["email"].lower())
    return out


def test_sub_admin_audit_logs_only_own_emails(
    client: TestClient, auth_header: dict
) -> None:
    ws_id, sub_id, sub_token = _setup_ws_and_sub_admin(client, auth_header)
    sub = _bearer(sub_token)

    sub_admin = _create_sub_admin(
        client,
        auth_header,
        email="auditview@example.com",
        username="auditview",
        permissions=["AUDIT_LOG_VIEW", "MEMBER_INVITE", "MEMBER_VIEW"],
    )
    assign = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": sub_admin["id"]},
        headers=auth_header,
    )
    assert assign.status_code == 201, assign.text
    audit_token = _bearer(_login_token(client, "auditview", "SubPassword123!"))

    client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "super-only@example.com", "role": "member"},
        headers=auth_header,
    )
    client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "sub-only@example.com", "role": "member"},
        headers=audit_token,
    )

    sub_logs = client.get("/api/v1/audit-logs?limit=200", headers=audit_token).json()
    sub_emails = _emails_in_logs(sub_logs)

    assert "super-only@example.com" not in sub_emails
    assert "sub-only@example.com" in sub_emails
    assert any(lg.get("actor_id") == sub_admin["id"] for lg in sub_logs)

    super_logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    super_emails = _emails_in_logs(super_logs)
    assert "super-only@example.com" in super_emails
    assert "sub-only@example.com" in super_emails


def test_sub_admin_sees_owner_transfer_log(
    client: TestClient, auth_header: dict
) -> None:
    """Log gán chủ hàng loạt (target_user_id) phải hiện cho user được gán."""
    ws_id, _, _ = _setup_ws_and_sub_admin(client, auth_header)
    sub = _create_sub_admin(
        client,
        auth_header,
        email="ownee@example.com",
        username="ownee",
        permissions=["AUDIT_LOG_VIEW", "MEMBER_VIEW"],
    )
    assign_ws = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    assert assign_ws.status_code == 201, assign_ws.text

    inv = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": "transfer-me@example.com", "role": "member"},
        headers=auth_header,
    ).json()

    xfer = client.post(
        f"/api/v1/added-members/transfer-owner",
        json={"member_ids": [inv["id"]], "target_user_id": sub["id"]},
        headers=auth_header,
    )
    assert xfer.status_code == 200, xfer.text

    token = _bearer(_login_token(client, "ownee", "SubPassword123!"))
    logs = client.get("/api/v1/audit-logs?limit=200", headers=token).json()
    actions = [lg["action"] for lg in logs]
    assert "MEMBER_OWNER_TRANSFERRED" in actions


def test_sub_admin_without_audit_permission_cannot_list(
    client: TestClient, auth_header: dict
) -> None:
    ws_id, _, _ = _setup_ws_and_sub_admin(client, auth_header)
    no_audit = _create_sub_admin(
        client,
        auth_header,
        email="noaudit@example.com",
        username="noaudit",
        permissions=["MEMBER_VIEW"],
    )
    assign = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": no_audit["id"]},
        headers=auth_header,
    )
    assert assign.status_code == 201, assign.text
    token = _bearer(_login_token(client, "noaudit", "SubPassword123!"))
    resp = client.get("/api/v1/audit-logs", headers=token)
    assert resp.status_code == 403, resp.text


def test_sub_admin_thay_su_kien_hang_doi_cua_lenh_minh_tao(
    client: TestClient, auth_header: dict
) -> None:
    """Sự kiện CẤP HÀNG ĐỢI (`QUEUE_PICKED`, `QUEUE_TIMEOUT`…) của task do chính
    sub-admin tạo phải hiện cho họ.

    Ca thật 26/8/2026 (task 3bc11c7b): các log này có `actor_id` NULL và data không
    mang email nào nên mọi luật sở hữu đều trượt → sub-admin không thấy. Hậu quả:
    cùng một lệnh mời, super-admin đọc ra "Thất bại" (thấy `QUEUE_TIMEOUT`) còn
    sub-admin đọc ra "Thành công" — hai người nhìn hai sự thật khác nhau về việc của
    chính sub-admin.

    Ranh giới: task của NGƯỜI KHÁC thì vẫn không được thấy.
    """
    ws = client.post(
        "/api/v1/workspaces",
        json={"name": "Queue Audit WS"},
        headers=auth_header,
    ).json()
    key = {"X-API-KEY": ws["extension_api_key"]}

    sub = _create_sub_admin(
        client,
        auth_header,
        email="queueaudit@example.com",
        username="queueaudit",
        permissions=["AUDIT_LOG_VIEW", "MEMBER_INVITE", "MEMBER_VIEW"],
    )
    assign = client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    assert assign.status_code == 201, assign.text
    token = _bearer(_login_token(client, "queueaudit", "SubPassword123!"))

    # Lệnh của CHÍNH sub-admin → extension nhận task (sinh QUEUE_PICKED).
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "queue-mine@example.com", "role": "member"},
        headers=token,
    )
    assert r.status_code == 201, r.text
    mine = client.get("/api/v1/queue/next", headers=key).json()
    assert mine is not None

    # Lệnh của super-admin → cũng có QUEUE_PICKED, nhưng không phải việc của họ.
    r2 = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "queue-theirs@example.com", "role": "member"},
        headers=auth_header,
    )
    assert r2.status_code == 201, r2.text
    theirs = client.get("/api/v1/queue/next", headers=key).json()
    assert theirs is not None and theirs["id"] != mine["id"]

    logs = client.get("/api/v1/audit-logs?limit=200", headers=token).json()
    queue_targets = {
        lg["target_id"]
        for lg in logs
        if lg["action"].startswith("QUEUE_") and lg.get("target_id")
    }
    assert mine["id"] in queue_targets, (
        "sự kiện hàng đợi của lệnh do chính sub-admin tạo phải hiện cho họ"
    )
    assert theirs["id"] not in queue_targets, (
        "lệnh của người khác thì vẫn không được thấy"
    )
