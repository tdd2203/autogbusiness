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

    # Member đang pending → gỡ bằng REVOKE_INVITES (tab Lời mời), KHÔNG phải
    # REMOVE_MEMBER. Completion mark removed khi result.data.results[].ok=true.
    queue = _list_queue(client, auth_header)
    revoke_task = next(q for q in queue if q["type"] == "REVOKE_INVITES")
    _patch_task_as_extension(
        client,
        revoke_task["id"],
        ws["extension_api_key"],
        status="COMPLETED",
        result={"data": {"results": [{"email": "re@example.com", "ok": True}]}},
    )

    # Giờ re-invite phải thành công (member.status đã 'removed')
    again = _invite_one(client, ws["id"], email="re@example.com", headers=auth_header)
    assert again["status"] == "pending"
    assert again["id"] == member_id  # reuse cùng row (UPSERT theo email)


def test_reinvite_after_removed_resets_joined_at_to_now(
    client: TestClient, auth_header: dict
) -> None:
    """Email đã THAM GIA rồi bị XOÁ → mời lại: ngày tham gia phải là LÚC MỜI LẠI,
    không giữ ngày tham gia lần trước (bất biến invite-time = join-date). Lịch sử
    removed vẫn còn (cùng member.id) — xem test_member_logs cho phần lịch sử."""
    ws = _create_workspace(client, auth_header)
    first = _invite_one(client, ws["id"], email="rejoin@example.com", headers=auth_header)
    member_id = first["id"]

    # 1) Giả lập member đã accept lần đầu: bulk-upsert active + joined_at cũ.
    old_joined = "2026-05-19T10:00:00+00:00"
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": "rejoin@example.com",
                    "name": "Rejoin",
                    "chatgpt_role": "member",
                    "status": "active",
                    "joined_at": old_joined,
                }
            ],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    # 2) Xoá member (DELETE + giả lập extension hoàn tất → status='removed').
    client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}", headers=auth_header
    )
    remove_task = next(
        q for q in _list_queue(client, auth_header) if q["type"] == "REMOVE_MEMBER"
    )
    _patch_task_as_extension(
        client, remove_task["id"], ws["extension_api_key"], status="COMPLETED"
    )

    # 3) Mời lại → joined_at phải được reset (KHÁC ngày tham gia lần đầu) và
    #    non-null (giữ record + lịch sử trước phantom-cleanup). (Member này vẫn CÒN
    #    HẠN do reconcile cấp gói mặc định 1 tháng — nhưng mời-lại-còn-hạn CHỈ giữ
    #    cửa sổ hạn, joined_at/last_invited_at vẫn reset như thường.)
    again = _invite_one(client, ws["id"], email="rejoin@example.com", headers=auth_header)
    assert again["id"] == member_id  # reuse cùng row → lịch sử removed còn nguyên
    assert again["status"] == "pending"
    assert again["joined_at"] is not None
    assert again["joined_at"] != old_joined
    # joined_at mới phải khớp last_invited_at (cùng mốc "lúc mời lại").
    assert again["joined_at"] == again["last_invited_at"]


def _revoke_and_complete(
    client: TestClient, ws: dict, auth_header: dict, email: str
) -> None:
    """Xoá 1 member đang 'pending' (DELETE → REVOKE_INVITES) rồi giả lập extension
    hoàn tất → status='removed'."""
    members = {m["email"]: m for m in _list_members(client, ws["id"], auth_header)}
    client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{members[email]['id']}",
        headers=auth_header,
    )
    revoke = next(
        q for q in _list_queue(client, auth_header) if q["type"] == "REVOKE_INVITES"
    )
    _patch_task_as_extension(
        client, revoke["id"], ws["extension_api_key"], status="COMPLETED",
        result={"data": {"results": [{"email": email, "ok": True}]}},
    )


def _invite_with_months(
    client: TestClient, ws_id: str, *, email: str, months: int, headers: dict
) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", "subscription_months": months},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_reinvite_still_valid_member_preserves_window(
    client: TestClient, auth_header: dict
) -> None:
    """CÒN HẠN + bị xoá → mời lại GIỮ NGUYÊN cửa sổ hạn (không tạo chu kỳ mới, không
    tính phí): dù mời lại với số THÁNG KHÁC, subscription_months + subscription_end_at
    vẫn là của kỳ ĐÃ TRẢ trước đó (bỏ qua months yêu cầu). Xem yêu cầu user 2026-07-14
    "email còn hạn, dù bị xoá mời lại cũng không bị tính phí"."""
    ws = _create_workspace(client, auth_header)
    first = _invite_with_months(
        client, ws["id"], email="valid@example.com", months=3, headers=auth_header
    )
    orig_months = first["subscription_months"]
    orig_end = first["subscription_end_at"]
    assert orig_months == 3
    assert orig_end is not None  # có hạn cụ thể (còn hạn, ≈ now + 90 ngày)

    _revoke_and_complete(client, ws, auth_header, "valid@example.com")

    # Mời lại với months KHÁC (1) → PHẢI giữ nguyên cửa sổ cũ (3 tháng), KHÔNG đặt lại
    # thành 1 tháng-từ-bây-giờ (đó mới là "mua gói mới" bị tính phí).
    again = _invite_with_months(
        client, ws["id"], email="valid@example.com", months=1, headers=auth_header
    )
    assert again["id"] == first["id"]
    assert again["status"] == "pending"
    assert again["subscription_months"] == orig_months, (
        "còn hạn → mời lại phải GIỮ số tháng đã trả, không nhận months mới"
    )
    assert again["subscription_end_at"] == orig_end, (
        "còn hạn → mời lại phải GIỮ hạn cũ, không tạo cửa sổ mới (không service free)"
    )


def test_reinvite_expired_member_resets_window(
    client: TestClient, auth_header: dict
) -> None:
    """HẾT HẠN + bị xoá → mời lại = CHU KỲ MỚI: reset cửa sổ theo months yêu cầu (đây
    là ca ĐƯỢC tính phí — trái ngược với ca còn hạn)."""
    import uuid as _uuid
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Member as _Member

    ws = _create_workspace(client, auth_header)
    first = _invite_with_months(
        client, ws["id"], email="expired@example.com", months=1, headers=auth_header
    )

    # Ép hạn về quá khứ → member hết hạn.
    past = datetime.now(timezone.utc) - timedelta(days=10)
    with SessionLocal() as db:
        m = db.get(_Member, _uuid.UUID(first["id"]))
        m.subscription_end_at = past
        db.commit()

    _revoke_and_complete(client, ws, auth_header, "expired@example.com")

    before = datetime.now(timezone.utc)
    again = _invite_with_months(
        client, ws["id"], email="expired@example.com", months=2, headers=auth_header
    )
    assert again["id"] == first["id"]
    assert again["subscription_months"] == 2, "hết hạn → chu kỳ mới nhận months yêu cầu"
    new_end = datetime.fromisoformat(again["subscription_end_at"])
    # Cửa sổ mới = bây giờ + 2×30 ngày (không giữ hạn quá khứ).
    assert abs((new_end - (before + timedelta(days=60))).total_seconds()) < 5


def test_paid_member_moves_to_correct_workspace_free(
    client: TestClient, auth_header: dict
) -> None:
    """ADD NHẦM WORKSPACE (user 2026-07-16): email đã THANH TOÁN + còn hạn, bị gỡ khỏi
    ws SAI, giờ mời sang ws ĐÚNG → CHUYỂN nguyên record (cùng member.id) sang ws đúng,
    GIỮ NGUYÊN cửa sổ hạn đã trả (KHÔNG tính phí, BỎ QUA months mới), và biến mất khỏi
    ws cũ. Trước fix: mời sang ws khác bị coi là email MỚI → tính phí lại oan."""
    ws_wrong = _create_workspace(client, auth_header, name="Sai WS")
    ws_right = _create_workspace(client, auth_header, name="Đúng WS")

    # Mua gói 3 tháng ở ws SAI → có cửa sổ hạn cụ thể (còn hạn).
    first = _invite_with_months(
        client, ws_wrong["id"], email="wrongws@example.com", months=3, headers=auth_header
    )
    orig_id = first["id"]
    orig_months = first["subscription_months"]
    orig_end = first["subscription_end_at"]
    assert orig_months == 3 and orig_end is not None

    # Gỡ khỏi ws SAI → status 'removed' (cửa sổ hạn GIỮ nguyên, đã trả tiền rồi).
    _revoke_and_complete(client, ws_wrong, auth_header, "wrongws@example.com")

    # Mời sang ws ĐÚNG với months KHÁC (1) → phải CHUYỂN record cũ + giữ cửa sổ 3 tháng
    # (nếu tạo member mới sẽ ra id khác + months=1 = bị tính phí lại).
    moved = _invite_with_months(
        client, ws_right["id"], email="wrongws@example.com", months=1, headers=auth_header
    )
    assert moved["id"] == orig_id, "phải CHUYỂN record cũ (cùng id), không tạo member mới"
    assert moved["status"] == "pending"
    assert moved["subscription_months"] == orig_months, "giữ số tháng đã trả (miễn phí)"
    assert moved["subscription_end_at"] == orig_end, "giữ nguyên cửa sổ hạn đã trả"

    # ws SAI KHÔNG còn email này (record đã dời đi).
    wrong_emails = {
        m["email"] for m in _list_members(client, ws_wrong["id"], auth_header)
    }
    assert "wrongws@example.com" not in wrong_emails, "record phải rời ws sai"

    # ws ĐÚNG có email này ở trạng thái pending (chờ tham gia đội đúng).
    right = {m["email"]: m for m in _list_members(client, ws_right["id"], auth_header)}
    assert right["wrongws@example.com"]["status"] == "pending"


def test_move_consolidates_over_expired_tombstone_in_target_ws(
    client: TestClient, auth_header: dict
) -> None:
    """ADD NHẦM WORKSPACE — biến thể HỢP NHẤT (ca thật ksorhlen74, 2026-07-16): ws ĐÚNG
    đã có tombstone `removed` HẾT HẠN (gói cũ), còn gói CÒN HẠN đã trả nằm ở ws SAI. Mời
    lại vào ws đúng phải HỢP NHẤT về gói còn hạn (xoá tombstone hết hạn + chuyển record
    còn hạn sang), GIỮ nguyên cửa sổ đã trả, KHÔNG tính phí. Trước fix: nhánh existing-
    hết-hạn ở ws đúng tính phí oan dù gói còn hạn nằm ws khác."""
    import uuid as _uuid
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Member as _Member

    ws_right = _create_workspace(client, auth_header, name="Đúng WS")
    ws_wrong = _create_workspace(client, auth_header, name="Sai WS")

    # 1) ws ĐÚNG: gói CŨ 1 tháng → ép hết hạn → gỡ → tombstone removed HẾT HẠN.
    old = _invite_with_months(
        client, ws_right["id"], email="consol@example.com", months=1, headers=auth_header
    )
    tombstone_id = old["id"]
    with SessionLocal() as db:
        m = db.get(_Member, _uuid.UUID(tombstone_id))
        m.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=3)
        db.commit()
    _revoke_and_complete(client, ws_right, auth_header, "consol@example.com")

    # 2) ws SAI: gói MỚI 3 tháng (còn hạn) → gỡ → donor removed CÒN HẠN.
    donor = _invite_with_months(
        client, ws_wrong["id"], email="consol@example.com", months=3, headers=auth_header
    )
    donor_id = donor["id"]
    assert donor_id != tombstone_id
    _revoke_and_complete(client, ws_wrong, auth_header, "consol@example.com")

    # 3) Mời lại vào ws ĐÚNG (months=1) → HỢP NHẤT: dùng record donor còn hạn (id donor),
    #    xoá tombstone hết hạn, giữ cửa sổ 3 tháng, miễn phí.
    moved = _invite_with_months(
        client, ws_right["id"], email="consol@example.com", months=1, headers=auth_header
    )
    assert moved["id"] == donor_id, "phải HỢP NHẤT về record còn hạn (id donor)"
    assert moved["id"] != tombstone_id, "tombstone hết hạn phải bị xoá, không tái dùng"
    assert moved["status"] == "pending"
    assert moved["subscription_months"] == 3, "giữ cửa sổ đã trả (3 tháng), bỏ qua months mới"

    # ws SAI không còn record; ws ĐÚNG có email pending.
    wrong = {m["email"] for m in _list_members(client, ws_wrong["id"], auth_header)}
    assert "consol@example.com" not in wrong
    right = {m["email"]: m for m in _list_members(client, ws_right["id"], auth_header)}
    assert right["consol@example.com"]["status"] == "pending"
    assert right["consol@example.com"]["id"] == donor_id


def test_invite_preview_reports_free_for_cross_workspace_move(
    client: TestClient, auth_header: dict
) -> None:
    """Endpoint /invite-preview: email có gói còn hạn ở ws khác (chuyển ws) → báo
    free_emails chứa email + total_fee=0 (để modal hiện 'Miễn phí' đúng, không doạ phí)."""
    ws_right = _create_workspace(client, auth_header, name="Prev Right")
    ws_wrong = _create_workspace(client, auth_header, name="Prev Wrong")
    _invite_with_months(
        client, ws_wrong["id"], email="prev@example.com", months=3, headers=auth_header
    )
    _revoke_and_complete(client, ws_wrong, auth_header, "prev@example.com")

    resp = client.post(
        f"/api/v1/workspaces/{ws_right['id']}/members/invite-preview",
        json={
            "invites": [{"email": "prev@example.com", "subscription_months": 1}],
            "role": "member",
        },
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "prev@example.com" in body["free_emails"]
    assert body["total_fee"] == 0


def test_expired_member_move_to_other_workspace_still_charges(
    client: TestClient, auth_header: dict
) -> None:
    """Ngược lại: email HẾT HẠN ở ws cũ → mời sang ws khác KHÔNG được miễn phí (không
    còn 'đã trả cho kỳ hiện tại'): tạo member MỚI, cửa sổ mới theo months yêu cầu."""
    import uuid as _uuid
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Member as _Member

    ws_a = _create_workspace(client, auth_header, name="Exp A")
    ws_b = _create_workspace(client, auth_header, name="Exp B")
    first = _invite_with_months(
        client, ws_a["id"], email="expmove@example.com", months=1, headers=auth_header
    )
    # Ép hết hạn rồi gỡ.
    with SessionLocal() as db:
        m = db.get(_Member, _uuid.UUID(first["id"]))
        m.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=5)
        db.commit()
    _revoke_and_complete(client, ws_a, auth_header, "expmove@example.com")

    moved = _invite_with_months(
        client, ws_b["id"], email="expmove@example.com", months=2, headers=auth_header
    )
    assert moved["id"] != first["id"], "hết hạn → member MỚI ở ws B (không chuyển free)"
    assert moved["subscription_months"] == 2


def test_remove_not_found_does_not_mark_removed(
    client: TestClient, auth_header: dict
) -> None:
    """Regression: extension báo UI_ELEMENT_NOT_FOUND cho REMOVE_MEMBER KHÔNG
    còn bị backend tự coi là 'đã removed'. Trên list dài, extension có thể tìm
    sót row dù member vẫn còn trên ChatGPT → không được đánh dấu removed nhầm.
    Task để FAILED; SYNC mới là nguồn chân lý."""
    ws = _create_workspace(client, auth_header)
    m = _invite_one(client, ws["id"], email="stay@example.com", headers=auth_header)
    member_id = m["id"]

    # Regression này thuộc REMOVE_MEMBER (tab Người dùng) → cho member 'active' (đã
    # tham gia). Member 'pending' sẽ đi REVOKE_INVITES (tab Lời mời) — luồng khác.
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": "stay@example.com",
                    "name": "Stay",
                    "chatgpt_role": "member",
                    "status": "active",
                }
            ],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    del_resp = client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}", headers=auth_header
    )
    assert del_resp.status_code == 202

    queue = _list_queue(client, auth_header)
    remove_task = next(q for q in queue if q["type"] == "REMOVE_MEMBER")

    patched = _patch_task_as_extension(
        client,
        remove_task["id"],
        ws["extension_api_key"],
        status="FAILED",
        error_code="UI_ELEMENT_NOT_FOUND",
        error_message="Không tìm thấy row sau khi duyệt hết trang",
    )
    # Task GIỮ FAILED — không bị convert sang COMPLETED.
    assert patched["status"] == "FAILED"

    # Member KHÔNG bị mark removed → vẫn hiện trong danh sách (list mặc định
    # ẩn removed, nên còn thấy nghĩa là chưa bị xoá nhầm).
    members = _list_members(client, ws["id"], auth_header)
    target = next((x for x in members if x["id"] == member_id), None)
    assert target is not None, "member bị ẩn → đã bị đánh dấu removed nhầm"
    assert target["status"] != "removed"


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
    # Gán workspace cho sub-admin (bắt buộc kể từ workspace-assignment RBAC).
    assign = client.post(
        f"/api/v1/workspaces/{ws['id']}/assignments",
        json={"user_id": sub["id"]},
        headers=auth_header,
    )
    assert assign.status_code == 201, assign.text
    sub_token = _login(client, "inviter")

    body = _invite_one(
        client, ws["id"], email="bysub@example.com", headers=_bearer(sub_token)
    )
    assert body["invited_by_user_id"] == sub["id"]


# =====================================================================
# B'. Cơ chế chủ sở hữu (owner lock) — toàn hệ thống
# =====================================================================


def _assign_ws(client: TestClient, auth_header: dict, ws_id: str, user_id: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/assignments",
        json={"user_id": user_id},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text


def test_owner_lock_blocks_other_account_same_workspace(
    client: TestClient, auth_header: dict
) -> None:
    """Email đã mời bởi tài khoản A → tài khoản B mời lại cùng workspace bị 409
    (cơ chế chủ sở hữu), không phải chỉ 'đã tồn tại'."""
    ws = _create_workspace(client, auth_header)
    a = _create_sub_admin(
        client, auth_header, email="own-a@example.com", username="owna",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    b = _create_sub_admin(
        client, auth_header, email="own-b@example.com", username="ownb",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    _assign_ws(client, auth_header, ws["id"], a["id"])
    _assign_ws(client, auth_header, ws["id"], b["id"])

    _invite_one(
        client, ws["id"], email="claimed@example.com",
        headers=_bearer(_login(client, "owna")),
    )
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "claimed@example.com", "role": "member"},
        headers=_bearer(_login(client, "ownb")),
    )
    assert resp.status_code == 409, resp.text
    assert "chủ sở hữu" in resp.json()["detail"]


def test_owner_lock_blocks_super_admin_too(
    client: TestClient, auth_header: dict
) -> None:
    """Ngay cả super-admin cũng không mời được email của tài khoản khác (đúng khiếu
    nại: admin@example.com mời email do sub-admin sở hữu)."""
    ws = _create_workspace(client, auth_header)
    a = _create_sub_admin(
        client, auth_header, email="own-c@example.com", username="ownc",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    _assign_ws(client, auth_header, ws["id"], a["id"])
    _invite_one(
        client, ws["id"], email="subowned@example.com",
        headers=_bearer(_login(client, "ownc")),
    )
    # Super-admin (auth_header) thử mời lại → chặn.
    _invite_one(
        client, ws["id"], email="subowned@example.com",
        headers=auth_header, expect=409,
    )


def test_owner_lock_is_global_across_workspaces(
    client: TestClient, auth_header: dict
) -> None:
    """Email do A mời ở WS1 → B mời sang WS2 (khác workspace) vẫn bị chặn (global)."""
    ws1 = _create_workspace(client, auth_header, name="Owner WS1")
    ws2 = _create_workspace(client, auth_header, name="Owner WS2")
    a = _create_sub_admin(
        client, auth_header, email="own-d@example.com", username="ownd",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    b = _create_sub_admin(
        client, auth_header, email="own-e@example.com", username="owne",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    _assign_ws(client, auth_header, ws1["id"], a["id"])
    _assign_ws(client, auth_header, ws2["id"], b["id"])
    _invite_one(
        client, ws1["id"], email="global@example.com",
        headers=_bearer(_login(client, "ownd")),
    )
    resp = client.post(
        f"/api/v1/workspaces/{ws2['id']}/members/invite",
        json={"email": "global@example.com", "role": "member"},
        headers=_bearer(_login(client, "owne")),
    )
    assert resp.status_code == 409, resp.text


def test_owner_can_reinvite_after_removed(
    client: TestClient, auth_header: dict
) -> None:
    """Chủ sở hữu cũ vẫn mời lại được email của chính mình sau khi removed."""
    ws = _create_workspace(client, auth_header)
    first = _invite_one(client, ws["id"], email="mine@example.com", headers=auth_header)
    member_id = first["id"]
    client.delete(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}", headers=auth_header
    )
    revoke = next(
        q for q in _list_queue(client, auth_header) if q["type"] == "REVOKE_INVITES"
    )
    _patch_task_as_extension(
        client, revoke["id"], ws["extension_api_key"], status="COMPLETED",
        result={"data": {"results": [{"email": "mine@example.com", "ok": True}]}},
    )
    again = _invite_one(client, ws["id"], email="mine@example.com", headers=auth_header)
    assert again["id"] == member_id  # cùng chủ → mời lại OK


def test_owner_lock_bulk_invite_blocks_other_account(
    client: TestClient, auth_header: dict
) -> None:
    """bulk-invite của tài khoản khác chứa 1 email đã có chủ → 409 (trước đây bulk
    thiếu guard, ghi đè invited_by_user_id)."""
    ws = _create_workspace(client, auth_header)
    a = _create_sub_admin(
        client, auth_header, email="own-f@example.com", username="ownf",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    b = _create_sub_admin(
        client, auth_header, email="own-g@example.com", username="owng",
        permissions=["MEMBER_INVITE", "MEMBER_VIEW"],
    )
    _assign_ws(client, auth_header, ws["id"], a["id"])
    _assign_ws(client, auth_header, ws["id"], b["id"])
    _invite_one(
        client, ws["id"], email="claimed2@example.com",
        headers=_bearer(_login(client, "ownf")),
    )
    _bulk_invite(
        client, ws["id"],
        payload={"emails": ["fresh@example.com", "claimed2@example.com"], "role": "member"},
        headers=_bearer(_login(client, "owng")),
        expect=409,
    )


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


def _member_logs(client: TestClient, ws_id: str, member_id: str, headers: dict) -> list[dict]:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/logs?limit=200",
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_invite_completed_marks_verified_and_sets_joined_at(
    client: TestClient, auth_header: dict
) -> None:
    """COMPLETED (không có unverified) → email verified: joined_at = LÚC THÀNH CÔNG
    (trước đó None), và ghi audit MEMBER_INVITE_VERIFIED result=COMPLETED gắn member
    + queue_item_id (để timeline hiện xanh thay vì PENDING đóng băng)."""
    ws = _create_workspace(client, auth_header)
    m = _invite_one(client, ws["id"], email="ok@example.com", headers=auth_header)
    assert m["joined_at"] is None
    task = next(
        q for q in _list_queue(client, auth_header) if q["type"] == "INVITE_MEMBER"
    )
    _patch_task_as_extension(
        client, task["id"], ws["extension_api_key"], status="COMPLETED", result={}
    )

    target = next(
        x for x in _list_members(client, ws["id"], auth_header) if x["id"] == m["id"]
    )
    assert target["joined_at"] is not None, "verified → joined_at phải được set"

    logs = _member_logs(client, ws["id"], m["id"], auth_header)
    verified = [lg for lg in logs if lg["action"] == "MEMBER_INVITE_VERIFIED"]
    assert len(verified) == 1
    assert verified[0]["result"] == "COMPLETED"
    assert verified[0]["data"]["queue_item_id"] == task["id"]


def test_invite_verify_scrape_failed_does_not_mark_verified(
    client: TestClient, auth_header: dict
) -> None:
    """verify_scrape_failed=true → CHƯA xác minh được → KHÔNG chấm thành công:
    joined_at vẫn None, không có log VERIFIED (timeline giữ PENDING)."""
    ws = _create_workspace(client, auth_header)
    m = _invite_one(client, ws["id"], email="unknown@example.com", headers=auth_header)
    task = next(
        q for q in _list_queue(client, auth_header) if q["type"] == "INVITE_MEMBER"
    )
    _patch_task_as_extension(
        client,
        task["id"],
        ws["extension_api_key"],
        status="COMPLETED",
        result={"verify_scrape_failed": True},
    )
    target = next(
        x for x in _list_members(client, ws["id"], auth_header) if x["id"] == m["id"]
    )
    assert target["joined_at"] is None
    logs = _member_logs(client, ws["id"], m["id"], auth_header)
    assert not [lg for lg in logs if lg["action"] == "MEMBER_INVITE_VERIFIED"]


def test_invite_failed_logs_failure_for_surviving_member(
    client: TestClient, auth_header: dict
) -> None:
    """Task FAILED nhưng member đã active (joined_at set → phantom cleanup GIỮ) →
    ghi audit MEMBER_INVITE_FAILED result=FAILED gắn member (timeline hiện đỏ)."""
    ws = _create_workspace(client, auth_header)
    m = _invite_one(client, ws["id"], email="act@example.com", headers=auth_header)
    # Promote active (joined_at set) để không bị phantom-cleanup xoá khi FAILED.
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": "act@example.com",
                    "name": "Act",
                    "chatgpt_role": "member",
                    "status": "active",
                    "joined_at": "2026-05-19T10:00:00+00:00",
                }
            ],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    task = next(
        q for q in _list_queue(client, auth_header) if q["type"] == "INVITE_MEMBER"
    )
    _patch_task_as_extension(
        client,
        task["id"],
        ws["extension_api_key"],
        status="FAILED",
        error_code="VERIFY_FAILED",
    )
    logs = _member_logs(client, ws["id"], m["id"], auth_header)
    failed = [lg for lg in logs if lg["action"] == "MEMBER_INVITE_FAILED"]
    assert len(failed) == 1
    assert failed[0]["result"] == "FAILED"
    assert failed[0]["data"]["queue_item_id"] == task["id"]


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
