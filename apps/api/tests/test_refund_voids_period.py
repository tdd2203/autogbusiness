"""Bất biến TIỀN: HOÀN PHÍ ⇒ PHẢI HUỶ KỲ HẠN ĐÃ TRẢ.

Vì sao có file này (ca thật `stockbox.m@gmail.com`, 15/7/2026 — thất thoát 660k):

  10:28:28  mời lần 2 → trừ 330k, member `pending`, kỳ hạn tới 14/8
  10:29:04.744  extension gọi /reconcile-after-invite (email không thấy trong tab
                'Lời mời đang chờ xử lý') → member `pending` ➜ **`removed`**
  10:29:04.772  extension PATCH task = FAILED → hoàn 330k
                ⇒ nhưng kỳ hạn KHÔNG bị huỷ (lúc đó code chưa có bản vá)
  10:29:12  mời lần 3: thấy email "CÒN HẠN" ➜ mời lại MIỄN PHÍ ➜ không trừ đồng nào
  ⇒ khách dùng trọn 30 ngày, hệ thống thực thu 0đ.

Điểm ĐỘC của ca này, và là lý do test phải gọi reconcile TRƯỚC khi báo FAILED:
member đã bị lật sang `removed` trong một request KHÁC, xảy ra trước request báo
lỗi chỉ 28 mili-giây. Mọi bộ lọc theo trạng thái trong luồng xử-lý-task-hỏng vì
thế đều nhìn thấy `removed` chứ không phải `pending`. Test nào chỉ báo FAILED mà
bỏ qua bước reconcile sẽ KHÔNG tái hiện được lỗi.

Bản vá `void_refunded_invite_periods` ra đời 21/7 (commit 4891f5c), tức 6 ngày SAU
sự cố. File này khoá bất biến đó lại để không tái diễn qua bất kỳ ngã nào.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import assign, bearer, create_ws, make_beta_sub, set_settings, wallet_of

FEE = 100_000
EMAIL = "stockboxlike@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _member_row(ws_id: str, email: str):
    """Đọc thẳng DB: (status, subscription_end_at, payment_status, số kỳ 'paid')."""
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws_id),
                Member.email == email.lower(),
            )
            .one_or_none()
        )
        if m is None:
            return None
        return {
            "status": m.status,
            "end_at": m.subscription_end_at,
            "payment_status": m.payment_status,
            "paid_cycles": sum(
                1 for c in m.subscription_cycles if c.payment_status == "paid"
            ),
        }


def _backdate(ws_id: str, email: str, minutes: int = 11) -> None:
    """Vượt GUARD 10 PHÚT của phantom-cleanup: member 'tươi' <10′ cố ý được giữ lại
    chờ sync phân xử (completion.py, fix 2026-07-13). Ca thật cách nhau 26 phút."""
    from app.db import SessionLocal
    from app.models import Member

    past = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws_id),
                Member.email == email.lower(),
            )
            .one()
        )
        m.last_invited_at = past
        m.created_at = past
        db.commit()


def test_refund_after_reconcile_marked_removed_must_void_period(
    client: TestClient, auth_header: dict
) -> None:
    """Tái hiện ĐÚNG ca stockbox.m: reconcile lật `removed` TRƯỚC, rồi task FAILED.

    Bất biến: sau khi hoàn phí, email KHÔNG được còn hạn dùng — nếu còn, lần mời kế
    tiếp sẽ đi nhánh 'còn hạn ⇒ miễn phí' và khách dùng free.
    """
    ws = create_ws(client, auth_header, "Void WS")
    sub = make_beta_sub(client, auth_header, username="voidsub", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    # 1. Mời → trừ tiền, member pending + có hạn dùng.
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 202, r.text
    item_id = r.json()["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == 0, "phải bị trừ phí mời"

    before = _member_row(ws["id"], EMAIL)
    assert before is not None and before["end_at"] is not None, (
        "mời tính phí phải tạo hạn dùng — không có thì test không chứng minh được gì"
    )

    _backdate(ws["id"], EMAIL)

    # 2. Extension reconcile: email KHÔNG thấy trong tab 'Lời mời' → lật sang removed.
    #    (đây là request chạy TRƯỚC, cách 28ms trong ca thật)
    rec = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={"verified_emails": [], "unverified_emails": [EMAIL],
              "verify_scrape_failed": False},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert rec.status_code == 200, rec.text
    assert rec.json()["removed"] == 1, "reconcile phải lật member sang removed"
    assert _member_row(ws["id"], EMAIL)["status"] == "removed"

    # 3. Extension báo task FAILED → hoàn phí.
    upd = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": "Đã submit nhưng không email nào vào tab 'Lời mời'",
            "result": {"verified_count": 0, "unverified_count": 1,
                       "unverified_emails": [EMAIL], "verify_scrape_failed": False},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text

    # ── Bất biến 1: tiền phải quay về ví ──────────────────────────────────
    assert wallet_of(client, sub["token"])["balance"] == FEE, "phí mời phải được hoàn"

    # ── Bất biến 2: hoàn phí ⇒ KHÔNG còn hạn dùng ────────────────────────
    after = _member_row(ws["id"], EMAIL)
    if after is not None:
        assert after["end_at"] is None, (
            f"THẤT THOÁT: đã hoàn phí nhưng email vẫn còn hạn tới {after['end_at']} "
            "→ lần mời kế tiếp sẽ MIỄN PHÍ (đúng ca stockbox.m)"
        )
        assert after["paid_cycles"] == 0, (
            f"THẤT THOÁT: còn {after['paid_cycles']} kỳ ghi 'đã thanh toán' "
            "dù tiền đã hoàn"
        )
        assert after["payment_status"] != "paid"


def test_reinvite_after_refund_is_charged_again(
    client: TestClient, auth_header: dict
) -> None:
    """Hệ quả TIỀN của bất biến trên: mời lại sau khi hoàn phí PHẢI bị tính phí.

    Đây mới là thiệt hại thật của ca stockbox.m — không phải bản thân kỳ hạn ma, mà
    là lần mời KẾ TIẾP đi nhánh 'còn hạn ⇒ miễn phí' nên không thu được đồng nào.
    """
    ws = create_ws(client, auth_header, "Void WS 2")
    sub = make_beta_sub(client, auth_header, username="voidsub2", balance=FEE * 2)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 202, r.text
    item_id = r.json()["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == FEE

    _backdate(ws["id"], EMAIL)
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/reconcile-after-invite",
        json={"verified_emails": [], "unverified_emails": [EMAIL],
              "verify_scrape_failed": False},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    client.patch(
        f"/api/v1/queue/{item_id}",
        json={"status": "FAILED", "error_code": "VERIFY_FAILED",
              "error_message": "x",
              "result": {"verified_count": 0, "unverified_count": 1,
                         "unverified_emails": [EMAIL], "verify_scrape_failed": False}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert wallet_of(client, sub["token"])["balance"] == FEE * 2, "đã hoàn phí"

    # Mời LẠI — phải bị trừ phí lần nữa (không được coi là 'còn hạn ⇒ miễn phí').
    r2 = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r2.status_code == 202, r2.text
    assert wallet_of(client, sub["token"])["balance"] == FEE, (
        "THẤT THOÁT: mời lại sau khi hoàn phí mà KHÔNG bị trừ tiền — email được "
        "dùng miễn phí (đúng ca stockbox.m 15/7)"
    )
