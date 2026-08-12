"""KIỂM CHỨNG bản vá 21/7 (`void_refunded_invite_periods`) trên đúng chuỗi thao tác
đã làm thất thoát 330k của stockbox.m ngày 15/7/2026:

  mời (tính phí) → mời lại (miễn phí vì còn hạn) → lệnh mời ĐẦU hỏng (hoàn phí)
  → lệnh mời SAU thành công.

Câu hỏi: sau chuỗi này email có còn "được dùng" mà ví thu ròng = 0 không?
"""

from __future__ import annotations

import uuid as _uuid

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    assign,
    bearer,
    create_ws,
    make_beta_sub,
    set_settings,
    wallet_of,
)

FEE = 100_000
EMAIL = "race@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _invite(client: TestClient, token: str, ws_id: str, email: str, months: int = 1):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", "subscription_months": months},
        headers=bearer(token),
    )


def _reinvite(client: TestClient, token: str, ws_id: str, member_id: str):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/re-invite",
        headers=bearer(token),
    )


def _queue(client: TestClient, auth_header: dict) -> list[dict]:
    return client.get("/api/v1/queue?limit=50", headers=auth_header).json()


def _patch(client: TestClient, api_key: str, item_id: str, body: dict):
    return client.patch(
        f"/api/v1/queue/{item_id}", json=body, headers={"X-API-KEY": api_key}
    )


def _member_row(member_id: str):
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.get(Member, _uuid.UUID(member_id))
        if m is None:
            return None
        return {
            "status": m.status,
            "end_at": m.subscription_end_at,
            "months": m.subscription_months,
            "joined_at": m.joined_at,
            "payment_status": m.payment_status,
            "cycles": [(c.cycle_number, c.payment_status) for c in m.subscription_cycles],
        }


def test_refund_then_free_reinvite_leaves_service_unpaid_but_flagged(
    client: TestClient, auth_header: dict
) -> None:
    """LỖ HỔNG CÒN LẠI sau bản vá 21/7 — email vẫn được phục vụ 1 tháng mà ví thu
    ròng = 0 ₫.

    Chuỗi (đúng ca stockbox.m 15/7/2026): mời (tính phí) → mời lại (MIỄN PHÍ vì còn
    hạn) → lệnh mời ĐẦU hỏng ⇒ hoàn phí + void kỳ → lệnh mời SAU thành công (email
    THẬT SỰ vào team) → đồng bộ tạo lại member với hạn mặc định 1 tháng
    (`reconcile.py::default_sub_months`). Phí của lệnh đầu đã hoàn, lệnh sau miễn
    phí ⇒ KHÔNG thu được đồng nào.

    Bản vá 21/7 KHÔNG bịt được đường này: nó void kỳ trên bản ghi member, nhưng
    member bị xoá phantom rồi SYNC dựng lại bản ghi MỚI.

    Chốt lại điều DUY NHẤT hệ thống đang bảo đảm: bản ghi dựng lại phải mang cờ
    **chưa thanh toán** (không kỳ nào 'paid') để admin còn nhìn thấy mà truy thu —
    khác ca 15/7 (bản ghi cũ hiện "Đã thanh toán", thất thoát ẩn hoàn toàn). Nếu ai
    đó đổi luồng làm nó thành 'paid', test này phải đỏ."""
    ws = create_ws(client, auth_header, "Race WS")
    sub = make_beta_sub(client, auth_header, username="race1", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], EMAIL, months=1)
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE

    rr = _reinvite(client, sub["token"], ws["id"], member_id)
    assert rr.status_code == 201, rr.text
    # Mời lại khi CÒN HẠN → miễn phí (đã trả cho kỳ này rồi).
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE

    tasks = [t for t in _queue(client, auth_header) if t["type"] == "INVITE_MEMBER"]
    first = next(t for t in tasks if not (t["payload"] or {}).get("reinvite"))
    second = next(t for t in tasks if (t["payload"] or {}).get("reinvite"))

    # Lệnh mời ĐẦU hỏng → hoàn phí + void kỳ (bản vá 21/7).
    assert _patch(
        client,
        ws["extension_api_key"],
        first["id"],
        {"status": "FAILED", "error_code": "CONTENT_TIMEOUT"},
    ).status_code == 200
    # Hoàn phí xong → ví về nguyên vẹn, bản ghi member (chưa từng tham gia) bị xoá.
    assert wallet_of(client, sub["token"])["balance"] == 300_000
    assert _member_row(member_id) is None

    # Lệnh mời SAU thành công.
    assert _patch(
        client,
        ws["extension_api_key"],
        second["id"],
        {"status": "COMPLETED", "result": {"ok": True}},
    ).status_code == 200

    # Đồng bộ báo email ĐÃ vào team (bước cuối của vòng đời thật).
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": EMAIL,
                    "name": "race",
                    "chatgpt_role": "member",
                    "status": "active",
                }
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text

    rows = client.get(
        f"/api/v1/workspaces/{ws['id']}/members?include_removed=true",
        headers=auth_header,
    ).json()
    assert len(rows) == 1 and rows[0]["email"] == EMAIL
    new_id = rows[0]["id"]
    row = _member_row(new_id)

    # Dịch vụ ĐÃ giao: member active, có hạn dùng 1 tháng do sync đặt mặc định.
    assert row["status"] == "active"
    assert row["end_at"] is not None
    # … nhưng không thu được đồng nào.
    pay = client.get(
        f"/api/v1/workspaces/{ws['id']}/members/{new_id}/payments", headers=auth_header
    ).json()
    assert (pay["charged_total"], pay["refunded_total"], pay["net_total"]) == (
        FEE,
        FEE,
        0,
    )
    # BẢO ĐẢM DUY NHẤT: không được coi là đã thanh toán → admin còn thấy để truy thu.
    assert row["payment_status"] == "unpaid"
    assert all(status == "unpaid" for _, status in row["cycles"])


def test_refund_voids_window_when_member_survives(
    client: TestClient, auth_header: dict
) -> None:
    """Bản vá 21/7 làm ĐÚNG việc của nó ở ca gốc (thuylinhtctbg): member ĐÃ TỪNG
    tham gia (`joined_at` != NULL) nên sống sót bước xoá phantom → hoàn phí phải
    VOID kỳ, để lần mời kế tiếp KHÔNG được miễn phí oan."""
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Member

    ws = create_ws(client, auth_header, "Void WS")
    sub = make_beta_sub(client, auth_header, username="void1", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], EMAIL, months=1)
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE

    # Đã tham gia rồi rời đội, gói cũ hết hạn → mời lại là chu kỳ MỚI (tính phí).
    with SessionLocal() as db:
        m = db.get(Member, _uuid.UUID(member_id))
        m.joined_at = datetime.now(timezone.utc) - timedelta(days=60)
        m.status = "removed"
        m.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=5)
        db.commit()

    r2 = _invite(client, sub["token"], ws["id"], EMAIL, months=1)
    assert r2.status_code in (200, 201), r2.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE * 2

    task = next(
        t
        for t in _queue(client, auth_header)
        if t["type"] == "INVITE_MEMBER" and t["status"] == "PENDING"
    )
    assert _patch(
        client,
        ws["extension_api_key"],
        task["id"],
        {"status": "FAILED", "error_code": "CONTENT_TIMEOUT"},
    ).status_code == 200

    # Hoàn phí lần 2 …
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE
    # … và kỳ bị VOID: member sống sót nhưng KHÔNG còn "hạn ma".
    row = _member_row(member_id)
    assert row is not None, "member có joined_at không được xoá phantom"
    # "Không còn hạn ma" = mốc hết hạn ở QUÁ KHỨ/HIỆN TẠI, KHÔNG phải NULL: NULL nghĩa
    # là VÔ THỜI HẠN (EXPIRY_RULES §5) nên bản ghi sống sót này sẽ không bao giờ bị quét
    # gỡ và dashboard hiện "Vô hạn" ⇒ dùng miễn phí vĩnh viễn (ca thật 12/8/2026).
    assert row["end_at"] is not None and row["end_at"] <= datetime.now(timezone.utc)
    assert row["months"] is None
    assert row["cycles"] == []

    # Mời lại lần nữa PHẢI tính phí — đây chính là chỗ bug gốc mất tiền: kỳ chưa
    # void thì `_is_paid_period_active` đọc "hạn ma" rồi cho mời lại miễn phí.
    r3 = _reinvite(client, sub["token"], ws["id"], member_id)
    assert r3.status_code in (200, 201), r3.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE * 2


def test_refund_flags_debt_when_member_already_active(
    client: TestClient, auth_header: dict
) -> None:
    """Hoàn phí khi member đã ACTIVE (email vẫn ở trong team) ⇒ KHÔNG kỳ nào được còn
    nhãn 'đã thanh toán'.

    `void_refunded_invite_periods` cố ý bỏ qua member `active` (void = xoá hạn = tặng
    vô thời hạn, EXPIRY_RULES §5). Chỗ trống đó do `flag_refunded_invite_debt` lấp:
    giữ nguyên hạn dùng, lật nhãn về CHƯA THANH TOÁN + ghi
    `MEMBER_REFUND_WHILE_IN_TEAM` để admin truy thu. Trước bản vá 2026-08-04, member
    giữ nguyên kỳ 'paid' → nhìn màn hình tưởng đã trả, thực thu 0 ₫ (ca stockbox.m)."""
    ws = create_ws(client, auth_header, "Active Refund WS")
    sub = make_beta_sub(client, auth_header, username="actref", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], EMAIL, months=1)
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE
    end_before = _member_row(member_id)["end_at"]

    # Đồng bộ thấy email đã vào team TRƯỚC khi task báo kết quả.
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": EMAIL, "name": "p", "chatgpt_role": "member", "status": "active"}
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )

    task = next(t for t in _queue(client, auth_header) if t["type"] == "INVITE_MEMBER")
    assert _patch(
        client,
        ws["extension_api_key"],
        task["id"],
        {"status": "FAILED", "error_code": "CONTENT_TIMEOUT"},
    ).status_code == 200

    assert wallet_of(client, sub["token"])["balance"] == 300_000  # đã hoàn sạch
    row = _member_row(member_id)
    # Nợ hiện ra …
    assert row["payment_status"] == "unpaid"
    assert all(status != "paid" for _, status in row["cycles"])
    # … nhưng dịch vụ KHÔNG bị cắt: hạn dùng giữ nguyên, member vẫn trong team.
    assert row["status"] == "active"
    assert row["end_at"] == end_before

    logs = client.get(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/logs", headers=auth_header
    ).json()
    alert = [x for x in logs if x["action"] == "MEMBER_REFUND_WHILE_IN_TEAM"]
    assert len(alert) == 1 and alert[0]["result"] == "ERROR"


def test_refund_keeps_paid_flag_when_money_still_collected(
    client: TestClient, auth_header: dict
) -> None:
    """Chốt chặn ngược: email VẪN còn tiền thu được (đã gia hạn có thu phí) thì nhãn
    'đã thanh toán' là THẬT — hoàn phí một lệnh mời hỏng KHÔNG được lật nó thành nợ."""
    ws = create_ws(client, auth_header, "Keep Paid WS")
    sub = make_beta_sub(client, auth_header, username="keeppaid", balance=500_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], EMAIL, months=1)
    member_id = r.json()["id"]
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": EMAIL, "name": "p", "chatgpt_role": "member", "status": "active"}
            ]
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    # Gia hạn CÓ THU PHÍ → tiền thực thu > 0 dù lệnh mời sắp bị hoàn.
    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/renew",
        json={"months": 1},
        headers=bearer(sub["token"]),
    )
    assert rr.status_code == 200, rr.text

    task = next(t for t in _queue(client, auth_header) if t["type"] == "INVITE_MEMBER")
    _patch(
        client,
        ws["extension_api_key"],
        task["id"],
        {"status": "FAILED", "error_code": "CONTENT_TIMEOUT"},
    )

    row = _member_row(member_id)
    assert row["payment_status"] == "paid"
    assert any(status == "paid" for _, status in row["cycles"])
