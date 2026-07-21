"""Audit log gắn tên workspace cho lệnh mời/xoá thành viên (feature bổ sung)."""

from fastapi.testclient import TestClient

from tests.wallet_helpers import create_ws


def test_audit_log_includes_workspace_name(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Audit WS Tên")
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "aw@example.com", "role": "member"},
        headers=auth_header,
    )
    assert r.status_code == 201, r.text

    logs = client.get("/api/v1/audit-logs?limit=50", headers=auth_header).json()
    invite_logs = [x for x in logs if "INVITE" in x["action"]]
    assert invite_logs, "không có audit INVITE nào"
    # Log mời phải có workspace_name = tên workspace vừa tạo.
    assert any(x.get("workspace_name") == "Audit WS Tên" for x in invite_logs), [
        (x["action"], x.get("workspace_name")) for x in invite_logs
    ]


def test_audit_log_no_workspace_for_login(client: TestClient, auth_header: dict) -> None:
    """Log không gắn workspace (vd LOGIN) → workspace_name = None."""
    logs = client.get("/api/v1/audit-logs?limit=100", headers=auth_header).json()
    non_ws = [x for x in logs if x["action"].startswith("LOGIN") or x["action"] == "SUPER_ADMIN_SEEDED"]
    for x in non_ws:
        assert x.get("workspace_name") is None
