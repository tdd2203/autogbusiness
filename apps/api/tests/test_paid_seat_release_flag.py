"""`/queue/next` đính `release_paid_seat_until` vào lệnh gỡ trong NGÀY CHỐT chu kỳ.

Hai đầu của một đường ống (EXPIRY_RULES §6.1, chốt user 11/9/2026):

  - Lúc CHỌN lệnh: `pick_next` hỏi `paid_seat_release_deadline` (logic cửa sổ có test
    riêng ở `test_paid_seat_release_window.py`) và đính giờ hoá đơn vào payload của
    RESPONSE — cùng thủ thuật `db.expunge` như cờ `dry_run`, payload trong DB không đổi.
  - Lúc HOÀN TẤT: extension trả `data.paid_seat` (kept/released/...) và completion ghi
    vào audit `MEMBER_REMOVED_SYNCED` để tra "kỳ này trả được bao nhiêu suất".

Cửa sổ được giả lập bằng monkeypatch vì nó phụ thuộc giờ thật; ca đối chứng (không
gian 30-ngày, không monkeypatch) chứng minh cờ không rò rỉ sang workspace thường.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.routers.members import _shared as members_shared

DEADLINE = datetime(2026, 9, 11, 9, 0, tzinfo=timezone.utc)


def _create_workspace(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upsert(client: TestClient, ws: dict, email: str, status: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": email,
                    "name": email.split("@")[0],
                    "chatgpt_role": "member",
                    "status": status,
                }
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text


def _member(client: TestClient, ws_id: str, auth_header: dict, email: str) -> dict:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=auth_header
    )
    assert resp.status_code == 200, resp.text
    return {m["email"]: m for m in resp.json()}[email]


def _enqueue_remove(client: TestClient, ws: dict, member_id: str, auth_header: dict) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-remove",
        json={"member_ids": [member_id]},
        headers=auth_header,
    )
    assert resp.status_code == 202, resp.text


def _pick_next(client: TestClient, ws: dict) -> dict | None:
    resp = client.get("/api/v1/queue/next", headers={"X-API-KEY": ws["extension_api_key"]})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _in_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """Giả lập "đang là ngày chốt" — pick_next import lười từ `members._shared` nên vá ở đó."""
    monkeypatch.setattr(
        members_shared, "paid_seat_release_deadline", lambda *a, **k: DEADLINE
    )


def test_ngay_chot_thi_lenh_go_mang_gio_hoa_don(
    client: TestClient, auth_header: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _create_workspace(client, auth_header, "Ngày chốt")
    _upsert(client, ws, "hethan@example.com", "active")
    member = _member(client, ws["id"], auth_header, "hethan@example.com")
    _enqueue_remove(client, ws, member["id"], auth_header)
    _in_window(monkeypatch)

    task = _pick_next(client, ws)

    assert task is not None and task["type"] == "REMOVE_MEMBER"
    assert task["payload"]["release_paid_seat_until"] == DEADLINE.isoformat()
    # Payload GỐC trong DB không đổi — cờ chỉ sống trong response, như dry_run.
    stored = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}&limit=50", headers=auth_header
    )
    assert stored.status_code == 200, stored.text
    rows = {r["id"]: r for r in stored.json()}
    assert task["id"] in rows
    assert "release_paid_seat_until" not in (rows[task["id"]].get("payload") or {})


def test_lenh_thu_hoi_cung_mang_gio_hoa_don_vi_duong_lui_go_o_tab_nguoi_dung(
    client: TestClient, auth_header: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _create_workspace(client, auth_header, "Ngày chốt — thu hồi")
    _upsert(client, ws, "choxacnhan@example.com", "pending")
    member = _member(client, ws["id"], auth_header, "choxacnhan@example.com")
    _enqueue_remove(client, ws, member["id"], auth_header)
    _in_window(monkeypatch)

    task = _pick_next(client, ws)

    assert task is not None and task["type"] == "REVOKE_INVITES"
    assert task["payload"]["release_paid_seat_until"] == DEADLINE.isoformat()


def test_giua_ky_hoac_khong_gian_30_ngay_thi_khong_co_co(
    client: TestClient, auth_header: dict
) -> None:
    # Workspace mới mặc định `legacy_30d` ⇒ `paid_seat_release_deadline` trả None thật,
    # không cần giả lập — đây là ca đối chứng chứng minh cờ không rò rỉ.
    ws = _create_workspace(client, auth_header, "Giữa kỳ")
    _upsert(client, ws, "binhthuong@example.com", "active")
    member = _member(client, ws["id"], auth_header, "binhthuong@example.com")
    _enqueue_remove(client, ws, member["id"], auth_header)

    task = _pick_next(client, ws)

    assert task is not None and task["type"] == "REMOVE_MEMBER"
    assert "release_paid_seat_until" not in task["payload"]


def test_hoan_tat_ghi_paid_seat_vao_audit(
    client: TestClient, auth_header: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _create_workspace(client, auth_header, "Ghi audit")
    _upsert(client, ws, "trasuat@example.com", "active")
    member = _member(client, ws["id"], auth_header, "trasuat@example.com")
    _enqueue_remove(client, ws, member["id"], auth_header)
    _in_window(monkeypatch)
    task = _pick_next(client, ws)
    assert task is not None

    done = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"verified": True, "paid_seat": "released"}},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert done.status_code == 200, done.text

    after = _member(client, ws["id"], auth_header, "trasuat@example.com")
    assert after["status"] == "removed"
    logs = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    rows = logs["items"] if isinstance(logs, dict) and "items" in logs else logs
    synced = [
        r
        for r in rows
        if r["action"] == "MEMBER_REMOVED_SYNCED" and r["target_id"] == member["id"]
    ]
    assert len(synced) == 1, synced
    assert synced[0]["data"]["paid_seat"] == "released"
