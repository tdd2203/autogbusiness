"""Mẻ đồng bộ lời mời chạy xong phải BÁO CÁO ĐỐI CHIẾU, không chỉ khoe số vào nhóm.

User 2026-08-31 (workspace CHATGPT PRO): một mẻ quét 24 email, nhật ký ghi đúng một
câu "18 email đã vào nhóm" — không ai biết 18 đó trên tổng bao nhiêu, 6 email còn
lại đang chờ hay ChatGPT không thấy, và có email nào gửi đi mà không nhận được kết
quả không. Dòng `QUEUE_UPDATED:SYNC_MEMBERS_BATCH` phải mang đủ các con số ấy để
trang Nhật ký nói được "đối chiếu N/M email — …".
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _seed_pending(client: TestClient, key: dict, ws_id: str, emails: list[str]) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-upsert",
        json={
            "members": [{"email": e, "status": "pending"} for e in emails],
            "is_full_sync": False,
        },
        headers=key,
    )
    assert resp.status_code == 200, resp.text


def _batch_done(
    client: TestClient, auth_header: dict, ws: dict, emails: list[str], results: list[dict]
) -> dict:
    """Xếp mẻ đồng bộ cho `emails` rồi chốt COMPLETED với `results` của extension."""
    queued = client.post(
        f"/api/v1/workspaces/{ws['id']}/sync-members-batch",
        json={"emails": emails},
        headers=auth_header,
    )
    assert queued.status_code == 202, queued.text
    task_id = queued.json()["queue_item_id"]
    done = client.patch(
        f"/api/v1/queue/{task_id}",
        json={"status": "COMPLETED", "result": {"data": {"results": results}}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert done.status_code == 200, done.text

    rows = client.get("/api/v1/audit-logs?limit=200", headers=auth_header).json()
    log = next(
        r
        for r in rows
        if r["action"].startswith("QUEUE_UPDATED:SYNC_MEMBERS_BATCH")
        and r["target_id"] == task_id
    )
    return log["data"]


def test_bao_cao_du_ba_nhom_ket_qua(client: TestClient, auth_header: dict) -> None:
    """Quét 3 email: 1 đã vào nhóm, 1 còn chờ, 1 ChatGPT không thấy."""
    ws = _ws(client, auth_header, "Sync Report WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    emails = ["vao@example.com", "cho@example.com", "matgoc@example.com"]
    _seed_pending(client, key, ws["id"], emails)

    data = _batch_done(
        client,
        auth_header,
        ws,
        emails,
        [
            {"email": "vao@example.com", "found_in": "active"},
            {"email": "cho@example.com", "found_in": "pending"},
            {"email": "matgoc@example.com", "found_in": "none"},
        ],
    )
    assert data["sync_requested"] == 3
    assert data["sync_checked"] == 3
    assert data["sync_active"] == 1
    assert data["sync_pending"] == 1
    assert data["sync_not_found"] == 1
    # Số "vừa vào nhóm" là tập con của "đang ở trong nhóm" — vẫn ghi như cũ.
    assert data["promoted_active"] == 1
    assert data["promoted_emails"] == ["vao@example.com"]


def test_email_khong_co_ket_qua_thi_lech(client: TestClient, auth_header: dict) -> None:
    """Gửi 3 email mà extension chỉ trả về 1 → phần chênh phải đọc ra được."""
    ws = _ws(client, auth_header, "Sync Report Gap WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    emails = ["a@example.com", "b@example.com", "c@example.com"]
    _seed_pending(client, key, ws["id"], emails)

    data = _batch_done(
        client, auth_header, ws, emails, [{"email": "a@example.com", "found_in": "pending"}]
    )
    assert data["sync_requested"] == 3
    assert data["sync_checked"] == 1, "quét sót thì phải thấy được, đừng làm tròn thành đủ"
    assert data["sync_active"] == 0
    assert data["sync_pending"] == 1
    assert data["sync_not_found"] == 0


def test_khong_email_nao_doi_trang_thai_van_co_bao_cao(
    client: TestClient, auth_header: dict
) -> None:
    """Mẻ "không có gì thay đổi" vẫn phải nói ra là đã đối chiếu bao nhiêu."""
    ws = _ws(client, auth_header, "Sync Report Quiet WS")
    key = {"X-API-KEY": ws["extension_api_key"]}
    emails = ["q1@example.com", "q2@example.com"]
    _seed_pending(client, key, ws["id"], emails)

    data = _batch_done(
        client,
        auth_header,
        ws,
        emails,
        [{"email": e, "found_in": "pending"} for e in emails],
    )
    assert data["sync_requested"] == 2
    assert data["sync_checked"] == 2
    assert data["sync_pending"] == 2
    assert "promoted_active" not in data
