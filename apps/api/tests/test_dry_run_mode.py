"""Dry-run (WorkspaceSettings.dry_run_mode) — task PHÁ HUỶ không được thực thi thật.

Regression cho fix CRITICAL (converge T032 — Hiến pháp III "hỗ trợ dry_run_mode"):
  - GET /queue/next đính `payload.dry_run=true` khi workspace bật dry-run.
  - PATCH /queue/{id} COMPLETED + result.dry_run=true KHÔNG áp side-effect DB
    (member KHÔNG bị mark removed) — completion.py phải bỏ qua nhánh reconcile.
  - Workspace KHÔNG bật dry-run → payload KHÔNG có cờ dry_run (control) và luồng
    COMPLETED thật vẫn mark removed như cũ (chứng minh guard không rò rỉ).
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _set_dry_run(client: TestClient, ws_id: str, auth_header: dict, enabled: bool) -> None:
    resp = client.patch(
        f"/api/v1/workspaces/{ws_id}/settings",
        json={"dry_run_mode": enabled},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["dry_run_mode"] is enabled


def _upsert_active(client: TestClient, ws: dict, email: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": email,
                    "name": email.split("@")[0],
                    "chatgpt_role": "member",
                    "status": "active",
                }
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _members_by_email(client: TestClient, ws_id: str, auth_header: dict) -> dict:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=auth_header
    )
    assert resp.status_code == 200, resp.text
    return {m["email"]: m for m in resp.json()}


def _enqueue_remove(client: TestClient, ws: dict, member_id: str, auth_header: dict) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        json={"member_ids": [member_id]},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text


def _pick_next(client: TestClient, ws: dict) -> dict | None:
    resp = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": ws["extension_api_key"]}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_dry_run_flags_task_and_skips_side_effects(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_workspace(client, auth_header, "Dry Run ON")
    _set_dry_run(client, ws["id"], auth_header, True)
    _upsert_active(client, ws, "victim@example.com")
    member = _members_by_email(client, ws["id"], auth_header)["victim@example.com"]
    assert member["status"] == "active"

    _enqueue_remove(client, ws, member["id"], auth_header)

    # Extension pick task → backend đính cờ dry_run vào payload của response.
    task = _pick_next(client, ws)
    assert task is not None
    assert task["type"] == "REMOVE_MEMBER"
    assert task["payload"].get("dry_run") is True

    # Extension báo COMPLETED kèm result.dry_run → completion.py BỎ QUA mark removed.
    done = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": {"dry_run": True, "skipped": True}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert done.status_code == 200, done.text

    after = _members_by_email(client, ws["id"], auth_header)["victim@example.com"]
    assert after["status"] == "active", "dry-run KHÔNG được mark member removed"


def test_no_dry_run_flag_when_disabled_and_real_remove_applies(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_workspace(client, auth_header, "Dry Run OFF")  # mặc định False
    _upsert_active(client, ws, "normal@example.com")
    member = _members_by_email(client, ws["id"], auth_header)["normal@example.com"]

    _enqueue_remove(client, ws, member["id"], auth_header)

    task = _pick_next(client, ws)
    assert task is not None
    assert task["type"] == "REMOVE_MEMBER"
    # Control: không bật dry-run → KHÔNG có cờ trong payload.
    assert "dry_run" not in task["payload"]

    # COMPLETED thật (không có result.dry_run) → member bị mark removed như cũ.
    done = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": {"ok": True}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert done.status_code == 200, done.text

    after = _members_by_email(client, ws["id"], auth_header)["normal@example.com"]
    assert after["status"] == "removed"
