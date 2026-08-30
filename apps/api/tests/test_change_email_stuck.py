"""Đổi email mà lệnh GỠ email cũ hỏng — email cũ ở lại, liên kết chuỗi biến mất.

Dựng lại ca thật 22/8/2026 (`hdh2102`): lampesdafret22 → minalqureshi221 → saghan876.
Lệnh thu hồi email giữa chuỗi hỏng (FAILED_UI_CHANGED) nên ChatGPT vẫn giữ email đó;
lần đồng bộ sau thấy lại và HỒI SINH nó về `active`, xoá luôn `removed_reason`. Hậu quả
dây chuyền:

  1. Một ghế thành HAI (email giữa chuỗi sống lại bên cạnh email cuối).
  2. Trang "Email đã thêm" MẤT liên kết đổi-email, vì liên kết chỉ dựng khi
     `removed_reason == 'email_changed'` — nhãn vừa bị đồng bộ xoá — dù nhật ký
     `MEMBER_EMAIL_CHANGED` còn nguyên bằng chứng.
  3. Mời lại email cuối bị tính phí như email MỚI, vì không còn dấu vết kế thừa.

File này CHỐT hành vi đúng sau bản vá, và trước hết là để TÌM RA đường nào khôi phục
hạn của email cũ (ca thật: hạn vẫn là `mua_lúc + 30 ngày` chính xác tới giây, dù
change_email đã đóng nó về thời điểm đổi).
"""

import uuid
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Member


def _ws(client: TestClient, auth_header: dict) -> dict:
    r = client.post(
        "/api/v1/workspaces",
        json={"name": "Stuck WS", "plan": "business", "seat_total": 50},
        headers=auth_header,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _sync_active(client: TestClient, ws: dict, emails: list[str]) -> None:
    """Đồng bộ báo về: các email này ĐANG có trong ChatGPT (tab Người dùng)."""
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": e, "name": e.split("@")[0], "chatgpt_role": "member", "status": "active"}
                for e in emails
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def _members(client: TestClient, ws_id: str, headers: dict) -> dict:
    r = client.get(f"/api/v1/workspaces/{ws_id}/members?include_removed=true", headers=headers)
    assert r.status_code == 200, r.text
    return {m["email"]: m for m in r.json()}


def _change_email(client: TestClient, ws_id: str, member_id: str, new_email: str, headers: dict):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/change-email",
        json={"new_email": new_email},
        headers=headers,
    )


def test_sync_resurrect_reopens_closed_window_of_old_email(
    client: TestClient, auth_header: dict
) -> None:
    """ĐÂY LÀ CHỖ CẦN TÌM: đồng bộ hồi sinh email cũ thì hạn đã đóng có mở lại không?

    `change_email` đóng hạn email cũ về thời điểm đổi. Nếu đồng bộ hồi sinh nó mà hạn
    mở lại thành `mua_lúc + 30 ngày`, thì email cũ lại "còn hạn" ⇒ mời lại nó được
    MIỄN PHÍ trong khi email mới đang tiêu đúng kỳ đã trả — một suất thành hai.
    """
    ws = _ws(client, auth_header)
    _sync_active(client, ws, ["a@example.com"])
    a = _members(client, ws["id"], auth_header)["a@example.com"]

    r = _change_email(client, ws["id"], a["id"], "b@example.com", auth_header)
    assert r.status_code == 201, r.text

    with SessionLocal() as db:
        old = db.get(Member, uuid.UUID(a["id"]))
        closed_end = old.subscription_end_at
        assert closed_end is not None and closed_end <= datetime.now(timezone.utc)
        assert old.removed_reason == "email_changed"

    # Lệnh gỡ HỎNG ⇒ ChatGPT vẫn giữ email cũ ⇒ lần đồng bộ sau thấy lại cả hai.
    _sync_active(client, ws, ["a@example.com", "b@example.com"])

    with SessionLocal() as db:
        old = db.get(Member, uuid.UUID(a["id"]))
        print(
            f"\n[HỒI SINH] status={old.status} removed_reason={old.removed_reason!r} "
            f"end={old.subscription_end_at} purchased={old.subscription_purchased_at}"
        )
        # Hạn đã đóng KHÔNG được mở lại chỉ vì ChatGPT còn thấy email.
        assert old.subscription_end_at == closed_end, (
            "hạn email cũ bị mở lại khi đồng bộ hồi sinh — email cũ lại 'còn hạn'"
        )


def test_email_change_link_survives_resurrection(
    client: TestClient, auth_header: dict
) -> None:
    """Liên kết đổi-email phải sống sót qua hồi sinh.

    Nhật ký `MEMBER_EMAIL_CHANGED` là bằng chứng bất biến và vẫn còn nguyên; chuỗi
    hiển thị thì lại gác cửa bằng `removed_reason` — một cột `varchar(32)` mà đồng bộ
    có quyền ghi đè (hồi sinh xoá về NULL, gỡ lần sau ghi đè thành `sync_missing`).
    Nhãn mất thì liên kết mất, dù sự thật còn nguyên.
    """
    ws = _ws(client, auth_header)
    _sync_active(client, ws, ["c@example.com"])
    c = _members(client, ws["id"], auth_header)["c@example.com"]
    r = _change_email(client, ws["id"], c["id"], "d@example.com", auth_header)
    assert r.status_code == 201, r.text

    row = client.get(f"/api/v1/added-members/{c['id']}", headers=auth_header)
    assert row.status_code == 200, row.text
    assert row.json().get("email_changed_to") == ["d@example.com"]

    # Gỡ hỏng ⇒ đồng bộ thấy lại email cũ ⇒ hồi sinh (removed_reason về NULL).
    _sync_active(client, ws, ["c@example.com", "d@example.com"])

    row = client.get(f"/api/v1/added-members/{c['id']}", headers=auth_header)
    assert row.status_code == 200, row.text
    assert row.json().get("email_changed_to") == ["d@example.com"], (
        "liên kết đổi-email biến mất sau khi đồng bộ hồi sinh email cũ"
    )


def test_failed_invite_must_not_destroy_carried_paid_cycles(
    client: TestClient, auth_header: dict
) -> None:
    """LỖI TIỀN: lượt mời của đổi-email hỏng thì KHÔNG được xoá mất kỳ ĐÃ TRẢ.

    `change_email` CHUYỂN (không copy) `member_subscription_cycles` sang bản ghi email
    mới. Bản ghi đó là `pending` + `joined_at IS NULL`, đúng khuôn mà nhánh chốt-hỏng
    xoá thẳng bằng `DELETE FROM members …` (completion.py) — chu kỳ cascade đi theo.
    Lịch sử đã trả tiền BIẾN MẤT vĩnh viễn.

    Hậu quả kép, cả hai đều đã xảy ra thật (22/8/2026):
      • báo cáo tài chính hụt mất lần mua đầu (report.py cộng theo chu kỳ `paid`);
      • mất bằng chứng kế thừa ⇒ mời lại email đó bị tính phí như email MỚI, khách
        trả tiền lần thứ hai cho cùng một ghế.

    Dữ liệu thật còn nguyên dấu vết: chuỗi lampesdafret22 → minalqureshi221 →
    saghan876 chỉ còn ĐÚNG MỘT chu kỳ, bắt đầu lúc 12:08:55 (lượt trả tiền lần hai);
    chu kỳ gốc mua lúc 06:24:31 không còn ở bản ghi nào.

    Kỳ vọng sau khi vá: chu kỳ đã trả phải còn — hoặc ở lại email cũ (hoàn tác việc
    đổi vì nó chưa hoàn tất), hoặc theo email mới nhưng bản ghi không bị xoá.
    """
    from app.models import MemberSubscriptionCycle

    ws = _ws(client, auth_header)
    _sync_active(client, ws, ["payer@example.com"])
    payer = _members(client, ws["id"], auth_header)["payer@example.com"]

    # Vật chất hoá 1 kỳ ĐÃ TRẢ cho email gốc.
    r = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{payer['id']}/subscription",
        json={"subscription_months": 1},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        cycles = (
            db.query(MemberSubscriptionCycle)
            .filter(MemberSubscriptionCycle.member_id == uuid.UUID(payer["id"]))
            .all()
        )
        assert cycles, "cần ít nhất 1 chu kỳ để kiểm chứng"
        for c in cycles:
            c.payment_status = "paid"
        db.commit()
        paid_before = len(cycles)

    changed = _change_email(client, ws["id"], payer["id"], "newpayer@example.com", auth_header)
    assert changed.status_code == 201, changed.text
    new_id = changed.json()["id"]

    # Chu kỳ đã CHUYỂN sang email mới.
    with SessionLocal() as db:
        moved = (
            db.query(MemberSubscriptionCycle)
            .filter(MemberSubscriptionCycle.member_id == uuid.UUID(new_id))
            .count()
        )
        assert moved == paid_before, "đổi email phải chuyển nguyên chu kỳ sang email mới"

    # Lượt mời email MỚI hỏng (ChatGPT tự báo lỗi ⇒ chốt hỏng ngay, không hoãn).
    tasks = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}&limit=50", headers=auth_header
    ).json()
    invite_task = next(t for t in tasks if t["type"] == "INVITE_MEMBER")
    upd = client.patch(
        f"/api/v1/queue/{invite_task['id']}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": "ChatGPT báo lỗi",
            "result": {"submit_clicked": True, "chatgpt_error_hint": "invalid domain"},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text

    # KỲ ĐÃ TRẢ PHẢI CÒN — ở bất kỳ bản ghi nào của chuỗi.
    with SessionLocal() as db:
        still = (
            db.query(MemberSubscriptionCycle)
            .filter(
                MemberSubscriptionCycle.member_id.in_(
                    [uuid.UUID(payer["id"]), uuid.UUID(new_id)]
                )
            )
            .count()
        )
    assert still == paid_before, (
        f"kỳ ĐÃ TRẢ bị xoá mất khi lượt mời hỏng ({still}/{paid_before} còn lại) — "
        "lịch sử tiền biến mất, lần mời sau sẽ bị tính phí lại"
    )
