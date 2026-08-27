"""Đổi email mà lệnh GỠ email cũ hỏng — LÝ DO XOÁ không được biến mất.

Ca thật 22/8/2026 (`hdh2102`): `lampesdafret22` → `minalqureshi221` → `saghan876`.
Lệnh gỡ email cũ hỏng ⇒ ChatGPT vẫn giữ nó ⇒ lần đồng bộ sau HỒI SINH nó về `active`
và xoá luôn `removed_reason='email_changed'`. Bốn ngày sau nó mới thật sự rời đi, và
lần đó đồng bộ ghi `sync_missing`. Kết quả: dòng email cũ không còn chỗ nào nói nó đã
đổi sang đâu — chuỗi cũ→mới ở tab "Đã xoá" gác cửa đúng bằng `removed_reason`.

File này chốt cả VÒNG ĐỜI của cờ `email_change_stuck_at`:
  1. hồi sinh → đặt cờ (+ email kế thừa), chuỗi vẫn đọc được trong lúc mắc kẹt;
  2. rời đi thật (qua đồng bộ, hoặc qua lệnh gỡ chốt muộn) → lý do quay lại
     `email_changed`, cờ gỡ sạch;
  3. gia hạn cho nó → cờ hết hiệu lực (đã thành ghế có trả tiền, hết là phần thừa).

Xem `alembic/versions/0057_member_email_change_stuck.py` và `members/reconcile.py`.
"""

import uuid

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Member


def _ws(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Stuck reason WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _sync_active(client: TestClient, ws: dict, emails: list[str]) -> None:
    """Đồng bộ báo: ĐÚNG các email này đang có trên ChatGPT (email khác = đã rời)."""
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


def _member_by_email(client: TestClient, ws_id: str, email: str, headers: dict) -> dict:
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return {m["email"]: m for m in resp.json()}[email]


def _change_email(
    client: TestClient, ws_id: str, member_id: str, new_email: str, headers: dict
):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/change-email",
        json={"new_email": new_email},
        headers=headers,
    )


def _row(member_id: str) -> Member:
    """Đọc thẳng DB — cờ mắc kẹt là chuyện nội bộ, chưa phơi ra API."""
    with SessionLocal() as db:
        return db.get(Member, uuid.UUID(member_id))


def _chain(client: TestClient, member_id: str, headers: dict) -> list[str]:
    resp = client.get(f"/api/v1/added-members/{member_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json().get("email_changed_to") or []


def _stuck_after_failed_removal(
    client: TestClient, auth_header: dict, old_email: str, new_email: str
) -> tuple[dict, dict]:
    """Dựng ca MẮC KẸT: đổi email xong, lệnh gỡ hỏng nên đồng bộ thấy lại email cũ."""
    ws = _ws(client, auth_header)
    _sync_active(client, ws, [old_email])
    old = _member_by_email(client, ws["id"], old_email, auth_header)
    resp = _change_email(client, ws["id"], old["id"], new_email, auth_header)
    assert resp.status_code == 201, resp.text
    # Lệnh gỡ HỎNG (không ai chốt task) ⇒ ChatGPT vẫn trả về email cũ.
    _sync_active(client, ws, [old_email, new_email])
    return ws, old


def test_resurrection_keeps_lineage_and_flags_stuck(
    client: TestClient, auth_header: dict
) -> None:
    """Hồi sinh: `removed_reason` mất là ĐÚNG (dòng đang sống), nhưng dấu vết phải còn."""
    ws, old = _stuck_after_failed_removal(
        client, auth_header, "stuck-a@example.com", "stuck-b@example.com"
    )

    row = _row(old["id"])
    assert row.status == "active"
    assert row.removed_at is None and row.removed_reason is None
    assert row.email_change_stuck_at is not None, (
        "email cũ sống lại sau lệnh gỡ hỏng mà không có dấu vết nào — "
        "lần rời đi sau sẽ bị ghi là 'sync_missing'"
    )
    assert row.email_change_stuck_to == "stuck-b@example.com"
    # Chuỗi cũ→mới phải đọc được NGAY TRONG lúc mắc kẹt: đây đúng là lúc một suất
    # đang ăn hai ghế, cần nhìn thấy nhất.
    assert _chain(client, old["id"], auth_header) == ["stuck-b@example.com"]


def test_later_sync_removal_is_email_changed_not_sync_missing(
    client: TestClient, auth_header: dict
) -> None:
    """Email mắc kẹt rời đi ở lần đồng bộ sau = KẾT CỤC MUỘN của lần đổi email."""
    ws, old = _stuck_after_failed_removal(
        client, auth_header, "stuck-c@example.com", "stuck-d@example.com"
    )

    # Lần đồng bộ sau: ChatGPT không còn email cũ nữa (nó đã thật sự rời đi).
    _sync_active(client, ws, ["stuck-d@example.com"])

    row = _row(old["id"])
    assert row.status == "removed"
    assert row.removed_reason == "email_changed", (
        f"ghi {row.removed_reason!r} là làm đứt chuỗi cũ→mới ở tab 'Đã xoá'"
    )
    assert row.email_change_stuck_at is None and row.email_change_stuck_to is None
    assert _chain(client, old["id"], auth_header) == ["stuck-d@example.com"]


def test_late_remove_task_completion_is_email_changed_not_by_admin(
    client: TestClient, auth_header: dict
) -> None:
    """Lệnh gỡ chốt MUỘN (extension chạy lại) cũng là 'đổi email', không phải 'admin xoá'."""
    ws, old = _stuck_after_failed_removal(
        client, auth_header, "stuck-e@example.com", "stuck-f@example.com"
    )

    # Task gỡ email cũ vẫn nằm chờ từ lúc đổi email — nay extension chốt được.
    queue = client.get("/api/v1/queue?limit=50", headers=auth_header).json()
    task = next(
        q
        for q in queue
        if q["type"] in ("REMOVE_MEMBER", "REVOKE_INVITES") and q["status"] == "PENDING"
    )
    result = (
        {"data": {"results": [{"email": e, "ok": True} for e in task["payload"]["emails"]]}}
        if task["type"] == "REVOKE_INVITES"
        else {"data": {"verified": True}}
    )
    resp = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": result},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text

    row = _row(old["id"])
    assert row.status == "removed"
    assert row.removed_reason == "email_changed", (
        f"ghi {row.removed_reason!r} — lần gỡ này là phần còn lại của lệnh đổi email"
    )
    assert row.email_change_stuck_at is None and row.email_change_stuck_to is None


def test_renewal_clears_stuck_flag(client: TestClient, auth_header: dict) -> None:
    """Gia hạn cho email cũ đang mắc kẹt = giữ nó lại như ghế CÓ TRẢ TIỀN ⇒ gỡ cờ.

    Đây là đường "vòng đời mới" DUY NHẤT tới được: dòng mắc kẹt đang `active` nên
    không mời lại được (409), còn mọi đường gỡ thật đều đã tự gỡ cờ. Không gỡ ở đây
    thì lần gỡ sau bị gán nhầm lý do 'đổi email' và cảnh báo "chưa xong" kêu oan.
    """
    ws, old_row = _stuck_after_failed_removal(
        client, auth_header, "stuck-g@example.com", "stuck-h@example.com"
    )
    assert _row(old_row["id"]).email_change_stuck_at is not None

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{old_row['id']}/renew",
        json={"months": 1},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text

    row = _row(old_row["id"])
    assert row.email_change_stuck_at is None and row.email_change_stuck_to is None


def test_stuck_email_gets_its_removal_requeued(
    client: TestClient, auth_header: dict
) -> None:
    """Đã đổi email thì CHẮC CHẮN phải xoá: lệnh gỡ hỏng ⇒ đồng bộ xếp lại lệnh khác.

    Trước đây gỡ hỏng là hết đường — không thử lại, không cảnh báo, email cũ ở lại ăn
    ghế (ca thật 22/8/2026 kéo 4 ngày). Nhưng cũng KHÔNG được nhân bản task: đang có
    lệnh gỡ mở thì thôi, kẻo mỗi lượt đồng bộ đẻ thêm một task.
    """
    ws, old = _stuck_after_failed_removal(
        client, auth_header, "stuck-i@example.com", "stuck-j@example.com"
    )

    def _open_removals() -> list[dict]:
        tasks = client.get(
            f"/api/v1/queue?workspace_id={ws['id']}&limit=50", headers=auth_header
        ).json()
        return [
            t
            for t in tasks
            if t["type"] in ("REMOVE_MEMBER", "REVOKE_INVITES")
            and t["status"] in ("PENDING", "IN_PROGRESS")
        ]

    # Lệnh gỡ gốc CHỐT HỎNG (ca thật: FAILED_UI_CHANGED).
    stuck_task = _open_removals()[0]
    upd = client.patch(
        f"/api/v1/queue/{stuck_task['id']}",
        json={
            "status": "FAILED",
            "error_code": "UI_CHANGED",
            "error_message": "không tìm thấy nút xoá",
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text
    assert _open_removals() == []

    # Đồng bộ vẫn thấy email cũ trên ChatGPT ⇒ xếp LẠI lệnh gỡ.
    _sync_active(client, ws, ["stuck-i@example.com", "stuck-j@example.com"])
    again = _open_removals()
    assert len(again) == 1, "lệnh gỡ hỏng rồi mà không ai xếp lại — email cũ ở lại mãi"

    # Lượt đồng bộ kế tiếp KHÔNG được đẻ thêm task khi lệnh kia còn mở.
    _sync_active(client, ws, ["stuck-i@example.com", "stuck-j@example.com"])
    assert [t["id"] for t in _open_removals()] == [again[0]["id"]]


def test_resurrection_closes_legacy_open_window(
    client: TestClient, auth_header: dict
) -> None:
    """Dòng cũ KHÔNG được còn hạn: mời lại chính nó phải TRẢ PHÍ.

    `change_email` đóng hạn dòng cũ từ 24/8/2026; dòng đổi TRƯỚC mốc đó vẫn ôm hạn
    tương lai (ca `pablomarcolinoo` 28/7). Hạn tương lai = `_is_paid_period_active`
    trả True ⇒ mời lại MIỄN PHÍ trong khi email mới đang tiêu đúng kỳ đã trả, và
    `find_movable_paid_members` còn chuyển miễn phí "hạn ma" đó sang workspace khác.
    """
    from datetime import datetime, timedelta, timezone

    ws = _ws(client, auth_header)
    _sync_active(client, ws, ["stuck-k@example.com"])
    old = _member_by_email(client, ws["id"], "stuck-k@example.com", auth_header)
    resp = _change_email(client, ws["id"], old["id"], "stuck-l@example.com", auth_header)
    assert resp.status_code == 201, resp.text

    # Dựng lại dữ liệu CŨ: hạn dòng cũ còn ở tương lai (như trước bản vá 24/8).
    future = datetime.now(timezone.utc) + timedelta(days=25)
    with SessionLocal() as db:
        row = db.get(Member, uuid.UUID(old["id"]))
        row.subscription_end_at = future
        db.commit()

    # Lệnh gỡ hỏng ⇒ đồng bộ hồi sinh dòng cũ.
    _sync_active(client, ws, ["stuck-k@example.com", "stuck-l@example.com"])

    row = _row(old["id"])
    assert row.subscription_end_at is not None, "None = vô thời hạn, KHÔNG phải hết hạn"
    assert row.subscription_end_at <= datetime.now(timezone.utc), (
        "dòng cũ vẫn 'còn hạn' sau khi đổi email ⇒ mời lại nó được miễn phí"
    )


def test_failed_change_email_invite_keeps_carried_cycles(
    client: TestClient, auth_header: dict
) -> None:
    """Lượt mời của ĐỔI EMAIL hỏng: bản ghi mới KHÔNG được xoá kèm chu kỳ đã trả.

    `change_email` CHUYỂN (không copy) chu kỳ sang bản ghi email mới. Bản ghi đó là
    `pending` + `joined_at IS NULL` — đúng khuôn "ma" mà nhánh chốt-hỏng xoá thẳng
    bằng `DELETE FROM members`, chu kỳ cascade đi theo. Mất lịch sử tiền ⇒ báo cáo hụt
    lần mua đầu, và mời lại email đó bị tính phí như email MỚI: khách trả lần hai cho
    cùng một ghế (ca thật 22/8/2026). Bản ghi phải Ở LẠI dưới dạng `removed`.
    """
    from app.models import MemberSubscriptionCycle

    ws = _ws(client, auth_header)
    _sync_active(client, ws, ["carry-old@example.com"])
    old = _member_by_email(client, ws["id"], "carry-old@example.com", auth_header)

    upd = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{old['id']}/subscription",
        json={"subscription_months": 1},
        headers=auth_header,
    )
    assert upd.status_code == 200, upd.text
    with SessionLocal() as db:
        cycles = (
            db.query(MemberSubscriptionCycle)
            .filter(MemberSubscriptionCycle.member_id == uuid.UUID(old["id"]))
            .all()
        )
        assert cycles, "cần ít nhất 1 chu kỳ để kiểm chứng"
        for c in cycles:
            c.payment_status = "paid"
        db.commit()
        paid_before = len(cycles)

    changed = _change_email(
        client, ws["id"], old["id"], "carry-new@example.com", auth_header
    )
    assert changed.status_code == 201, changed.text
    new_id = changed.json()["id"]

    # Lượt mời email MỚI hỏng.
    tasks = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}&limit=50", headers=auth_header
    ).json()
    invite_task = next(t for t in tasks if t["type"] == "INVITE_MEMBER")
    resp = client.patch(
        f"/api/v1/queue/{invite_task['id']}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": "ChatGPT báo lỗi",
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text

    row = _row(new_id)
    assert row is not None, "bản ghi kế thừa bị XOÁ HẲN — chu kỳ đã trả đi theo"
    assert row.status == "removed" and row.removed_reason == "invite_failed"
    with SessionLocal() as db:
        still = (
            db.query(MemberSubscriptionCycle)
            .filter(MemberSubscriptionCycle.member_id == uuid.UUID(new_id))
            .count()
        )
    assert still == paid_before, f"kỳ đã trả còn {still}/{paid_before}"
