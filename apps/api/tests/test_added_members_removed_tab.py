"""Tab "Đã xoá" ở trang Email đã thêm (yêu cầu user 2026-08-24).

`GET /api/v1/added-members?removed=true` trả email ĐÃ RỜI team trong 30 ngày gần
nhất, kèm `removed_at` + `removed_reason` để bảng trả lời được "vì sao mất email
này". Kiểm 4 điểm dễ hỏng nhất:

  1. Email bị xoá KHÔNG lọt vào danh sách thường, và CHỈ lọt vào ?removed=true.
  2. Cửa sổ 30 ngày là mốc LỌC LÚC ĐỌC: xoá lâu hơn 30 ngày rơi khỏi tab dù record
     vẫn nằm trong DB (retention hard-delete riêng, 90 ngày — xem test_removed_retention).
  3. `removed_reason` phân biệt được HẾT HẠN (job nền, cả đường REMOVE_MEMBER lẫn
     REVOKE_INVITES) với ADMIN XOÁ TAY và THU HỒI LỜI MỜI — đây là lý do cột này tồn
     tại thay vì suy ngược từ audit log.
  4. Quy tắc ai-thấy-gì giữ nguyên: sub-admin chỉ thấy email mình add.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Member


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 25},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _invite(client: TestClient, headers: dict, ws_id: str, email: str) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _complete_open_removal(client: TestClient, auth_header: dict, ws: dict) -> str:
    """Giả lập extension hoàn tất task gỡ đang chờ → member chuyển 'removed'.

    Trả về loại task đã chốt. `auth_header` phải là super-admin: đọc hàng đợi cần
    quyền riêng, trong khi việc XOÁ có thể do sub-admin bấm.
    """
    queue = client.get("/api/v1/queue?limit=50", headers=auth_header).json()
    task = next(
        q
        for q in queue
        if q["type"] in ("REMOVE_MEMBER", "REVOKE_INVITES") and q["status"] == "PENDING"
    )
    if task["type"] == "REVOKE_INVITES":
        result = {
            "data": {
                "results": [{"email": e, "ok": True} for e in task["payload"]["emails"]]
            }
        }
    else:
        # CONTRACT v0.9.22: REMOVE_MEMBER chỉ mark removed khi có result.data.verified.
        result = {"data": {"verified": True}}
    resp = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": result},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    return task["type"]


def _remove_complete(
    client: TestClient,
    auth_header: dict,
    ws: dict,
    member_id: str,
    *,
    actor: dict | None = None,
) -> None:
    """DELETE + giả lập extension hoàn tất (giống test_removed_retention).

    Member pending → REVOKE_INVITES; active → REMOVE_MEMBER (cần result.data.verified).
    """
    assert (
        client.delete(
            f"/api/v1/workspaces/{ws['id']}/members/{member_id}",
            headers=actor or auth_header,
        ).status_code
        == 202
    )
    _complete_open_removal(client, auth_header, ws)


def _sync_active(client: TestClient, ws: dict, email: str) -> None:
    """Đưa email vào workspace ở trạng thái ACTIVE qua đường extension bulk-upsert.

    Cần cho các ca "admin xoá member đang hoạt động": mời qua dashboard chỉ tạo
    member `pending` → đường xoá là REVOKE_INVITES (thu hồi lời mời), khác hẳn.
    """
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": email, "status": "active"}], "is_full_sync": False},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code in (200, 201), resp.text


def _backdate_removed_at(member_id: str, *, days: int) -> None:
    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(member_id))
        row.removed_at = datetime.now(timezone.utc) - timedelta(days=days)
        db.commit()


def test_removed_tab_lists_only_removed_emails(
    client: TestClient, auth_header: dict
) -> None:
    """Member ĐANG HOẠT ĐỘNG bị admin xoá → rời list thường, vào tab "Đã xoá"."""
    ws = _ws(client, auth_header, "WS removed tab")
    _sync_active(client, ws, "gone@example.com")
    _invite(client, auth_header, ws["id"], "stay@example.com")
    with SessionLocal() as db:
        gone_id = str(
            db.query(Member).filter(Member.email == "gone@example.com").one().id
        )
    _remove_complete(client, auth_header, ws, gone_id)

    alive = client.get("/api/v1/added-members", headers=auth_header).json()
    assert [r["email"] for r in alive] == ["stay@example.com"]

    removed = client.get(
        "/api/v1/added-members?removed=true", headers=auth_header
    ).json()
    assert [r["email"] for r in removed] == ["gone@example.com"]
    assert removed[0]["status"] == "removed"
    assert removed[0]["removed_at"] is not None
    # Xoá tay từ dashboard (không phải job hết hạn).
    assert removed[0]["removed_reason"] == "removed_by_admin"
    # Vẫn kèm đủ thông tin để tra cứu như tab thường.
    assert removed[0]["workspace_name"] == ws["name"]


def test_removed_reason_invite_revoked_for_pending(
    client: TestClient, auth_header: dict
) -> None:
    """Email mới mời (chưa tham gia) bị xoá → "thu hồi lời mời", không phải "admin xoá".

    Hai đường khác hẳn nhau ở backend (REVOKE_INVITES vs REMOVE_MEMBER) và người dùng
    cần phân biệt: một bên là lời mời chưa từng vào team, bên kia là mất suất đang dùng.
    """
    ws = _ws(client, auth_header, "WS removed revoke")
    pending = _invite(client, auth_header, ws["id"], "pending@example.com")
    _remove_complete(client, auth_header, ws, pending["id"])

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    assert [r["removed_reason"] for r in rows] == ["invite_revoked"]


def test_removed_tab_drops_rows_older_than_window(
    client: TestClient, auth_header: dict
) -> None:
    """Quá 30 ngày → rơi khỏi tab, nhưng record VẪN còn trong DB (retention 90 ngày)."""
    ws = _ws(client, auth_header, "WS removed window")
    old = _invite(client, auth_header, ws["id"], "old@example.com")
    recent = _invite(client, auth_header, ws["id"], "recent@example.com")
    _remove_complete(client, auth_header, ws, old["id"])
    _remove_complete(client, auth_header, ws, recent["id"])
    _backdate_removed_at(old["id"], days=31)
    _backdate_removed_at(recent["id"], days=29)

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    assert [r["email"] for r in rows] == ["recent@example.com"]

    with SessionLocal() as db:
        assert db.get(Member, uuid.UUID(old["id"])) is not None


def test_removed_reason_expired_for_active_member(
    client: TestClient, auth_header: dict
) -> None:
    """Suất đang dùng hết hạn → job nền gỡ (REMOVE_MEMBER) → lý do 'expired'."""
    import app.main as m

    ws = _ws(client, auth_header, "WS removed expired active")
    _sync_active(client, ws, "expired-active@example.com")
    with SessionLocal() as db:
        row = (
            db.query(Member).filter(Member.email == "expired-active@example.com").one()
        )
        row.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.commit()

    m._enqueue_expired_removals_once()
    assert _complete_open_removal(client, auth_header, ws) == "REMOVE_MEMBER"

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    assert [(r["email"], r["removed_reason"]) for r in rows] == [
        ("expired-active@example.com", "expired")
    ]


def test_removed_reason_expired_for_pending_invite(
    client: TestClient, auth_header: dict
) -> None:
    """Lời mời chưa ai bấm mà HẾT HẠN cũng phải ghi 'expired'.

    Job nền chọn REVOKE_INVITES cho member `pending` — dùng CHUNG đường hoàn tất với
    thu hồi lời mời thủ công. Không phân biệt theo task gốc thì email chết vì hết hạn
    lại hiện "thu hồi lời mời", tức là đổ oan cho admin.
    """
    import app.main as m

    ws = _ws(client, auth_header, "WS removed expired pending")
    member = _invite(client, auth_header, ws["id"], "expired-pending@example.com")
    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(member["id"]))
        row.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.commit()

    m._enqueue_expired_removals_once()
    assert _complete_open_removal(client, auth_header, ws) == "REVOKE_INVITES"

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    assert [(r["email"], r["removed_reason"]) for r in rows] == [
        ("expired-pending@example.com", "expired")
    ]


def test_reinvite_clears_removed_reason(client: TestClient, auth_header: dict) -> None:
    """Mời lại = email sống lại → biến khỏi tab "Đã xoá", lý do xoá cũ phải sạch."""
    ws = _ws(client, auth_header, "WS removed revive")
    member = _invite(client, auth_header, ws["id"], "back@example.com")
    _remove_complete(client, auth_header, ws, member["id"])
    _invite(client, auth_header, ws["id"], "back@example.com")

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    assert rows == []
    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(member["id"]))
        assert row.removed_reason is None


def test_removed_tab_shows_email_change_chain(
    client: TestClient, auth_header: dict
) -> None:
    """Email đổi sang email khác, rồi email đó lại đổi tiếp → chuỗi chỉ tới email CUỐI.

    Người dùng nhìn email cũ trong tab "Đã xoá" cần biết hạn/tiền của nó giờ nằm ở
    đâu; bảng members KHÔNG có liên kết cũ→mới nên chuỗi phải lần theo nhật ký
    `MEMBER_EMAIL_CHANGED` (xem `_email_change_next_map`).
    """
    ws = _ws(client, auth_header, "WS email chain")
    first = _invite(client, auth_header, ws["id"], "first@example.com")

    second = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{first['id']}/change-email",
        json={"new_email": "second@example.com"},
        headers=auth_header,
    )
    assert second.status_code == 201, second.text
    third = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{second.json()['id']}/change-email",
        json={"new_email": "third@example.com"},
        headers=auth_header,
    )
    assert third.status_code == 201, third.text

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    chains = {r["email"]: r["email_changed_to"] for r in rows}
    assert chains == {
        # Email đầu chuỗi phải đi hết 2 chặng, không dừng ở chặng 1.
        "first@example.com": ["second@example.com", "third@example.com"],
        "second@example.com": ["third@example.com"],
    }
    reasons = {r["email"]: r["removed_reason"] for r in rows}
    assert reasons == {
        "first@example.com": "email_changed",
        "second@example.com": "email_changed",
    }


def test_removed_tab_chain_empty_for_other_reasons(
    client: TestClient, auth_header: dict
) -> None:
    """Email bị gỡ vì lý do KHÁC không được dính chuỗi đổi email (rỗng)."""
    ws = _ws(client, auth_header, "WS chain empty")
    member = _invite(client, auth_header, ws["id"], "revoked@example.com")
    _remove_complete(client, auth_header, ws, member["id"])

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    assert [r["email_changed_to"] for r in rows] == [[]]


def test_removed_tab_respects_ownership_visibility(
    client: TestClient, auth_header: dict
) -> None:
    """Sub-admin chỉ thấy email MÌNH add trong tab "Đã xoá" (như tab thường)."""
    ws = _ws(client, auth_header, "WS removed visibility")
    sub = client.post(
        "/api/v1/users",
        json={
            "username": "subdel1",
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE", "MEMBER_REMOVE"],
        },
        headers=auth_header,
    )
    assert sub.status_code == 201, sub.text
    assign = client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub.json()["id"]},
        headers=auth_header,
    )
    assert assign.status_code in (200, 201), assign.text
    sub_h = {
        "Authorization": "Bearer "
        + client.post(
            "/api/v1/auth/login",
            json={"identifier": "subdel1", "password": "SubPassword123!"},
        ).json()["access_token"]
    }

    mine = _invite(client, sub_h, ws["id"], "subowned@example.com")
    theirs = _invite(client, auth_header, ws["id"], "adminowned@example.com")
    # Sub-admin bấm xoá (actor), nhưng đọc/chốt hàng đợi bằng quyền super-admin.
    _remove_complete(client, auth_header, ws, mine["id"], actor=sub_h)
    _remove_complete(client, auth_header, ws, theirs["id"])

    sub_rows = client.get("/api/v1/added-members?removed=true", headers=sub_h).json()
    assert [r["email"] for r in sub_rows] == ["subowned@example.com"]

    admin_rows = client.get(
        "/api/v1/added-members?removed=true", headers=auth_header
    ).json()
    assert {r["email"] for r in admin_rows} == {
        "subowned@example.com",
        "adminowned@example.com",
    }


def test_removed_tab_chain_carries_member_ids(
    client: TestClient, auth_header: dict
) -> None:
    """Mỗi chặng của chuỗi đổi email kèm ID member — modal bấm mũi tên mới mở được.

    Tra theo CHUỖI EMAIL là không đủ (cùng một email có thể tồn tại ở nhiều
    workspace), nên `email_changed_to_ids` phải khớp 1-1 theo thứ tự với
    `email_changed_to`.
    """
    ws = _ws(client, auth_header, "WS chain ids")
    first = _invite(client, auth_header, ws["id"], "chain1@example.com")
    second = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{first['id']}/change-email",
        json={"new_email": "chain2@example.com"},
        headers=auth_header,
    )
    assert second.status_code == 201, second.text
    third = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{second.json()['id']}/change-email",
        json={"new_email": "chain3@example.com"},
        headers=auth_header,
    )
    assert third.status_code == 201, third.text

    rows = client.get("/api/v1/added-members?removed=true", headers=auth_header).json()
    row = next(r for r in rows if r["email"] == "chain1@example.com")
    assert row["email_changed_to"] == ["chain2@example.com", "chain3@example.com"]
    assert row["email_changed_to_ids"] == [second.json()["id"], third.json()["id"]]


def test_get_added_member_by_id_returns_detail_row(
    client: TestClient, auth_header: dict
) -> None:
    """`GET /added-members/{id}` trả ĐÚNG hình dạng 1 dòng danh sách (kèm workspace).

    Modal chi tiết bấm mũi tên "đã đổi sang" phải mở được email nhận — email đó còn
    sống nên KHÔNG nằm trong tab "Đã xoá" đang mở, phải hỏi thẳng theo id.
    """
    ws = _ws(client, auth_header, "WS detail by id")
    member = _invite(client, auth_header, ws["id"], "byid@example.com")

    resp = client.get(f"/api/v1/added-members/{member['id']}", headers=auth_header)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == member["id"]
    assert body["email"] == "byid@example.com"
    assert body["workspace_id"] == ws["id"]
    assert body["workspace_name"] == "WS detail by id"
    # Email còn sống, không phải ca đổi email → không có chuỗi.
    assert body["email_changed_to"] == []
    assert body["email_changed_to_ids"] == []


def test_get_added_member_by_id_404_for_unknown_and_others(
    client: TestClient, auth_header: dict
) -> None:
    """Id lạ → 404; email của người khác → cũng 404 với sub-admin (đúng luật danh sách)."""
    ws = _ws(client, auth_header, "WS detail visibility")
    sub = client.post(
        "/api/v1/users",
        json={
            "username": "subdetail1",
            "password": "SubPassword123!",
            "permissions": ["MEMBER_VIEW", "MEMBER_INVITE"],
        },
        headers=auth_header,
    )
    assert sub.status_code == 201, sub.text
    assign = client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub.json()["id"]},
        headers=auth_header,
    )
    assert assign.status_code in (200, 201), assign.text
    sub_h = {
        "Authorization": "Bearer "
        + client.post(
            "/api/v1/auth/login",
            json={"identifier": "subdetail1", "password": "SubPassword123!"},
        ).json()["access_token"]
    }

    theirs = _invite(client, auth_header, ws["id"], "adminonly@example.com")
    mine = _invite(client, sub_h, ws["id"], "subsees@example.com")

    assert (
        client.get(f"/api/v1/added-members/{theirs['id']}", headers=sub_h).status_code
        == 404
    )
    assert (
        client.get(f"/api/v1/added-members/{mine['id']}", headers=sub_h).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/v1/added-members/{uuid.uuid4()}", headers=auth_header
        ).status_code
        == 404
    )
