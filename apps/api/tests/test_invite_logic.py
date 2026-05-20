"""Test cases cho logic mời trực tiếp (direct invite).

Bao phủ:
  A. Single invite — POST /workspaces/{ws}/members/invite
  B. Bulk invite — POST /workspaces/{ws}/members/bulk-invite
  C. Phantom cleanup — PATCH /queue/{item_id} (FAILED / unverified_emails /
     verify_scrape_failed) theo memory feedback_no_phantom_invite.md (v0.4.13)
  D. Permission + visibility cho sub-admin

Reference:
  - apps/api/app/routers/members.py:97-323  (single + bulk-invite)
  - apps/api/app/routers/queue.py:404-630   (update_task + phantom cleanup)
"""

from __future__ import annotations

from fastapi.testclient import TestClient


# ---------- helpers ----------

def _create_workspace(client: TestClient, auth_header: dict, name: str = "Invite WS") -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 25},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_sub_admin(
    client: TestClient,
    auth_header: dict,
    *,
    email: str,
    username: str,
    permissions: list[str],
) -> dict:
    resp = client.post(
        "/api/v1/users",
        json={
            "email": email,
            "username": username,
            "password": "SubPassword123!",
            "permissions": permissions,
        },
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login(client: TestClient, identifier: str, password: str = "SubPassword123!") -> str:
    resp = client.post(
        "/api/v1/auth/login",
        json={"identifier": identifier, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _invite_one(
    client: TestClient,
    ws_id: str,
    *,
    email: str,
    role: str = "member",
    headers: dict,
    expect: int = 201,
) -> dict | None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": role},
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json() if expect < 400 else None


def _bulk_invite(
    client: TestClient,
    ws_id: str,
    *,
    payload: dict,
    headers: dict,
    expect: int = 202,
) -> dict | None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json=payload,
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json() if expect < 400 else None


def _list_members(client: TestClient, ws_id: str, headers: dict) -> list[dict]:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _list_queue(client: TestClient, headers: dict) -> list[dict]:
    resp = client.get("/api/v1/queue?limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _patch_task_as_extension(
    client: TestClient,
    task_id: str,
    api_key: str,
    *,
    status: str,
    result: dict | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> dict:
    body: dict = {"status": status}
    if result is not None:
        body["result"] = result
    if error_code is not None:
        body["error_code"] = error_code
    if error_message is not None:
        body["error_message"] = error_message
    resp = client.patch(
        f"/api/v1/queue/{task_id}",
        json=body,
        headers={"X-API-KEY": api_key},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# =====================================================================
# A. Single invite — happy path
# =====================================================================


def test_single_invite_creates_member_invite_and_queue_item(
    client: TestClient, auth_header: dict
) -> None:
    """Mời 1 email → tạo đúng 3 records: Member(pending) + Invite(pending) +
    QueueItem(INVITE_MEMBER, PENDING) với payload.email + payload.role."""
    ws = _create_workspace(client, auth_header)

    body = _invite_one(
        client, ws["id"], email="alice@example.com", role="member", headers=auth_header
    )

    assert body["email"] == "alice@example.com"
    assert body["status"] == "pending"
    assert body["chatgpt_role"] == "member"
    assert body["joined_at"] is None
    assert body["invited_by_user_id"] is not None  # super-admin id

    # Queue item tạo đúng
    queue = _list_queue(client, auth_header)
    invites = [q for q in queue if q["type"] == "INVITE_MEMBER"]
    assert len(invites) == 1
    qi = invites[0]
    assert qi["status"] == "PENDING"
    assert qi["workspace_id"] == ws["id"]
    assert qi["payload"]["email"] == "alice@example.com"
    assert qi["payload"]["role"] == "member"
    # Single-invite payload là single email, KHÔNG có field 'emails' (list).
    assert "emails" not in qi["payload"]


def test_single_invite_normalizes_email_to_lowercase(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_workspace(client, auth_header)
    body = _invite_one(
        client, ws["id"], email="UPPER@Example.COM", role="member", headers=auth_header
    )
    assert body["email"] == "upper@example.com"

    queue = _list_queue(client, auth_header)
    invites = [q for q in queue if q["type"] == "INVITE_MEMBER"]
    assert invites[0]["payload"]["email"] == "upper@example.com"


def test_single_invite_default_role_is_member(
    client: TestClient, auth_header: dict
) -> None:
    """MemberInviteIn.role default = 'member' khi caller không gửi role."""
    ws = _create_workspace(client, auth_header)
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "default-role@example.com"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["chatgpt_role"] == "member"


def test_single_invite_accepts_analytics_viewer_role(
    client: TestClient, auth_header: dict
) -> None:
    """v0.4.16: dashboard mở thêm role analytics_viewer cho invite."""
    ws = _create_workspace(client, auth_header)
    body = _invite_one(
        client,
        ws["id"],
        email="av@example.com",
        role="analytics_viewer",
        headers=auth_header,
    )
    assert body["chatgpt_role"] == "analytics_viewer"


# =====================================================================
# B. Single invite — edge cases
# =====================================================================


def test_single_invite_duplicate_pending_returns_409(
    client: TestClient, auth_header: dict
) -> None:
    """Email đã pending trong cùng workspace → 409 Conflict."""
    ws = _create_workspace(client, auth_header)
    _invite_one(client, ws["id"], email="dup@example.com", headers=auth_header)
    _invite_one(
        client, ws["id"], email="dup@example.com", headers=auth_header, expect=409
    )


def test_single_invite_after_removed_resets_to_pending(
    client: TestClient, auth_header: dict
) -> None:
    """Email đã 'removed' → re-invite được, status reset về pending."""
    ws = _create_workspace(client, auth_header)
    first = _invite_one(client, ws["id"], email="re@example.com", headers=auth_header)
    member_id = first["id"]

    # Xoá member (qua endpoint chính thức — tạo REMOVE task, nhưng status chưa
    # đổi sang 'removed' cho tới khi extension PATCH COMPLETED). Để test
    # deterministic, gọi DELETE rồi giả lập extension hoàn tất.
    del_resp = client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}", headers=auth_header
    )
    assert del_resp.status_code == 202

    # Lấy REMOVE_MEMBER task vừa tạo + giả lập extension hoàn tất
    queue = _list_queue(client, auth_header)
    remove_task = next(q for q in queue if q["type"] == "REMOVE_MEMBER")
    _patch_task_as_extension(
        client,
        remove_task["id"],
        ws["extension_api_key"],
        status="COMPLETED",
    )

    # Giờ re-invite phải thành công (member.status đã 'removed')
    again = _invite_one(client, ws["id"], email="re@example.com", headers=auth_header)
    assert again["status"] == "pending"
    assert again["id"] == member_id  # reuse cùng row (UPSERT theo email)


def test_single_invite_workspace_not_found_returns_404(
    client: TestClient, auth_header: dict
) -> None:
    fake_ws = "00000000-0000-0000-0000-000000000000"
    resp = client.post(
        f"/api/v1/workspaces/{fake_ws}/members/invite",
        json={"email": "ghost@example.com", "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 404


def test_single_invite_requires_member_invite_permission(
    client: TestClient, auth_header: dict
) -> None:
    """Sub-admin thiếu MEMBER_INVITE permission → 403."""
    ws = _create_workspace(client, auth_header)
    _create_sub_admin(
        client,
        auth_header,
        email="noinv@example.com",
        username="noinv",
        permissions=["MEMBER_VIEW"],  # KHÔNG có MEMBER_INVITE
    )
    sub_token = _login(client, "noinv")

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "x@example.com", "role": "member"},
        headers=_bearer(sub_token),
    )
    assert resp.status_code == 403


def test_sub_admin_invite_sets_invited_by_to_self(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_workspace(client, auth_header)
    sub = _create_sub_admin(
        client,
        auth_header,
        email="inviter@example.com",
        username="inviter",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    sub_token = _login(client, "inviter")

    body = _invite_one(
        client, ws["id"], email="bysub@example.com", headers=_bearer(sub_token)
    )
    assert body["invited_by_user_id"] == sub["id"]


# =====================================================================
# C. Bulk invite — happy + dedupe + active-protect
# =====================================================================


def test_bulk_invite_creates_one_queue_item_with_emails_list(
    client: TestClient, auth_header: dict
) -> None:
    """Bulk-invite N emails → đúng 1 QueueItem (payload.emails là list), N
    Member + N Invite, response 202 + count + member_ids."""
    ws = _create_workspace(client, auth_header)
    body = _bulk_invite(
        client,
        ws["id"],
        payload={
            "emails": ["a@example.com", "b@example.com", "c@example.com"],
            "role": "member",
        },
        headers=auth_header,
    )
    assert body["count"] == 3
    assert len(body["member_ids"]) == 3

    queue = _list_queue(client, auth_header)
    invite_tasks = [q for q in queue if q["type"] == "INVITE_MEMBER"]
    assert len(invite_tasks) == 1
    qi = invite_tasks[0]
    assert qi["payload"]["role"] == "member"
    assert sorted(qi["payload"]["emails"]) == [
        "a@example.com",
        "b@example.com",
        "c@example.com",
    ]

    members = _list_members(client, ws["id"], auth_header)
    pending_emails = sorted(m["email"] for m in members if m["status"] == "pending")
    assert pending_emails == ["a@example.com", "b@example.com", "c@example.com"]


def test_bulk_invite_dedupes_emails_case_insensitive(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_workspace(client, auth_header)
    body = _bulk_invite(
        client,
        ws["id"],
        payload={
            "emails": ["x@example.com", "X@Example.com", "y@example.com"],
            "role": "member",
        },
        headers=auth_header,
    )
    assert body["count"] == 2


def test_bulk_invite_empty_after_dedupe_returns_400(
    client: TestClient, auth_header: dict
) -> None:
    ws = _create_workspace(client, auth_header)
    _bulk_invite(
        client,
        ws["id"],
        payload={"emails": [], "role": "member"},
        headers=auth_header,
        expect=400,
    )


def test_bulk_invite_does_not_downgrade_active_member(
    client: TestClient, auth_header: dict
) -> None:
    """Admin lỡ bulk-invite email đã 'active' (sync từ ChatGPT) → backend phải
    GIỮ NGUYÊN status=active (không downgrade về pending). Xem
    members.py:252-259 — comment giải thích vì sao."""
    ws = _create_workspace(client, auth_header)

    # Bootstrap 1 active member qua bulk-upsert (như extension scrape về)
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": "active@example.com",
                    "name": "Active Person",
                    "chatgpt_role": "member",
                    "status": "active",
                }
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    # Admin bulk-invite cùng email + 1 email mới
    _bulk_invite(
        client,
        ws["id"],
        payload={
            "emails": ["active@example.com", "new@example.com"],
            "role": "member",
        },
        headers=auth_header,
    )

    members = {m["email"]: m for m in _list_members(client, ws["id"], auth_header)}
    assert members["active@example.com"]["status"] == "active", (
        "Active member KHÔNG được downgrade về pending khi bulk-invite trùng email"
    )
    assert members["new@example.com"]["status"] == "pending"


def test_bulk_invite_per_email_subscription_via_invites_path(
    client: TestClient, auth_header: dict
) -> None:
    """Path mới (2026-05-19): invites=[{email, subscription_months}] cho
    per-email subscription."""
    ws = _create_workspace(client, auth_header)
    _bulk_invite(
        client,
        ws["id"],
        payload={
            "invites": [
                {"email": "short@example.com", "subscription_months": 1},
                {"email": "long@example.com", "subscription_months": 12},
            ],
            "role": "member",
        },
        headers=auth_header,
    )
    members = {m["email"]: m for m in _list_members(client, ws["id"], auth_header)}
    assert members["short@example.com"]["subscription_months"] == 1
    assert members["long@example.com"]["subscription_months"] == 12


# =====================================================================
# D. Phantom cleanup — PATCH /queue/{task_id} (FAILED, unverified, verify_failed)
# =====================================================================


def test_phantom_cleanup_failed_deletes_all_pending_records(
    client: TestClient, auth_header: dict
) -> None:
    """FAILED → xoá toàn bộ Member (pending+joined_at NULL) + Invite của task này.
    Memory feedback_no_phantom_invite.md (v0.4.13)."""
    ws = _create_workspace(client, auth_header)
    _bulk_invite(
        client,
        ws["id"],
        payload={
            "emails": ["fail1@example.com", "fail2@example.com"],
            "role": "member",
        },
        headers=auth_header,
    )
    queue = _list_queue(client, auth_header)
    task = next(q for q in queue if q["type"] == "INVITE_MEMBER")

    # Pre: 2 pending members
    pre = _list_members(client, ws["id"], auth_header)
    assert {m["email"] for m in pre if m["status"] == "pending"} == {
        "fail1@example.com",
        "fail2@example.com",
    }

    # Extension báo FAILED
    _patch_task_as_extension(
        client,
        task["id"],
        ws["extension_api_key"],
        status="FAILED",
        error_code="CONTENT_NOT_INJECTED",
        error_message="Content script không inject được",
    )

    # Post: cả 2 member bị xoá khỏi DB
    post = _list_members(client, ws["id"], auth_header)
    assert not any(
        m["email"] in {"fail1@example.com", "fail2@example.com"} for m in post
    ), "FAILED → Member pending phải bị phantom-cleanup xoá hết"


def test_phantom_cleanup_failed_preserves_joined_member(
    client: TestClient, auth_header: dict
) -> None:
    """Member đã sync sang active (joined_at SET) thì KHÔNG được xoá kể cả khi
    task FAILED. Bảo vệ: `status='pending' AND joined_at IS NULL`."""
    ws = _create_workspace(client, auth_header)

    # 1) Invite email A → tạo pending Member
    _invite_one(client, ws["id"], email="joined@example.com", headers=auth_header)

    # 2) Giả lập ChatGPT đã accept invite: extension scrape → bulk-upsert update
    #    cùng email sang status=active + joined_at set.
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": "joined@example.com",
                    "name": "Joined",
                    "chatgpt_role": "member",
                    "status": "active",
                    "joined_at": "2026-05-19T10:00:00+00:00",
                }
            ],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    # 3) Task INVITE_MEMBER tương ứng bị FAILED muộn (vd extension restart)
    queue = _list_queue(client, auth_header)
    task = next(q for q in queue if q["type"] == "INVITE_MEMBER")
    _patch_task_as_extension(
        client,
        task["id"],
        ws["extension_api_key"],
        status="FAILED",
        error_code="UNKNOWN",
    )

    # 4) Member 'joined@' phải VẪN còn, status=active (joined_at NOT NULL bảo vệ)
    members = _list_members(client, ws["id"], auth_header)
    joined = next(m for m in members if m["email"] == "joined@example.com")
    assert joined["status"] == "active"
    assert joined["joined_at"] is not None


def test_phantom_cleanup_completed_unverified_only_deletes_listed(
    client: TestClient, auth_header: dict
) -> None:
    """COMPLETED + result.unverified_emails=[a] → xoá a, giữ b."""
    ws = _create_workspace(client, auth_header)
    _bulk_invite(
        client,
        ws["id"],
        payload={
            "emails": ["verified@example.com", "rejected@example.com"],
            "role": "member",
        },
        headers=auth_header,
    )
    queue = _list_queue(client, auth_header)
    task = next(q for q in queue if q["type"] == "INVITE_MEMBER")

    _patch_task_as_extension(
        client,
        task["id"],
        ws["extension_api_key"],
        status="COMPLETED",
        result={
            "verified_emails": ["verified@example.com"],
            "unverified_emails": ["rejected@example.com"],
            "verify_scrape_failed": False,
        },
    )

    members_by_email = {
        m["email"]: m for m in _list_members(client, ws["id"], auth_header)
    }
    assert "verified@example.com" in members_by_email
    assert members_by_email["verified@example.com"]["status"] == "pending"
    assert "rejected@example.com" not in members_by_email, (
        "unverified email phải bị phantom-cleanup xoá"
    )


def test_phantom_cleanup_completed_verify_scrape_failed_keeps_all(
    client: TestClient, auth_header: dict
) -> None:
    """COMPLETED + verify_scrape_failed=true (extension không scrape được tab
    pending) → KHÔNG xoá gì cả (safe default, admin tự check)."""
    ws = _create_workspace(client, auth_header)
    _bulk_invite(
        client,
        ws["id"],
        payload={
            "emails": ["safe1@example.com", "safe2@example.com"],
            "role": "member",
        },
        headers=auth_header,
    )
    queue = _list_queue(client, auth_header)
    task = next(q for q in queue if q["type"] == "INVITE_MEMBER")

    _patch_task_as_extension(
        client,
        task["id"],
        ws["extension_api_key"],
        status="COMPLETED",
        result={"verify_scrape_failed": True},
    )

    emails = {m["email"] for m in _list_members(client, ws["id"], auth_header)}
    assert "safe1@example.com" in emails
    assert "safe2@example.com" in emails


def test_phantom_cleanup_completed_no_unverified_keeps_all(
    client: TestClient, auth_header: dict
) -> None:
    """COMPLETED không có unverified_emails (cũng không có verify_scrape_failed)
    → coi như tất cả verified → giữ nguyên."""
    ws = _create_workspace(client, auth_header)
    _bulk_invite(
        client,
        ws["id"],
        payload={
            "emails": ["ok1@example.com", "ok2@example.com"],
            "role": "member",
        },
        headers=auth_header,
    )
    queue = _list_queue(client, auth_header)
    task = next(q for q in queue if q["type"] == "INVITE_MEMBER")

    _patch_task_as_extension(
        client,
        task["id"],
        ws["extension_api_key"],
        status="COMPLETED",
        result={},
    )

    emails = {m["email"] for m in _list_members(client, ws["id"], auth_header)}
    assert "ok1@example.com" in emails
    assert "ok2@example.com" in emails


def test_phantom_cleanup_scoped_to_workspace(
    client: TestClient, auth_header: dict
) -> None:
    """FAILED ở WS A KHÔNG được đụng tới Member của WS B (cùng email)."""
    ws_a = _create_workspace(client, auth_header, name="WS A")
    ws_b = _create_workspace(client, auth_header, name="WS B")

    _invite_one(client, ws_a["id"], email="shared@example.com", headers=auth_header)
    _invite_one(client, ws_b["id"], email="shared@example.com", headers=auth_header)

    # FAIL task của WS A
    queue = _list_queue(client, auth_header)
    task_a = next(
        q
        for q in queue
        if q["type"] == "INVITE_MEMBER" and q["workspace_id"] == ws_a["id"]
    )
    _patch_task_as_extension(
        client,
        task_a["id"],
        ws_a["extension_api_key"],
        status="FAILED",
        error_code="UNKNOWN",
    )

    a_emails = {m["email"] for m in _list_members(client, ws_a["id"], auth_header)}
    b_emails = {m["email"] for m in _list_members(client, ws_b["id"], auth_header)}
    assert "shared@example.com" not in a_emails, "WS A phải bị xoá"
    assert "shared@example.com" in b_emails, "WS B phải còn (khác workspace)"
