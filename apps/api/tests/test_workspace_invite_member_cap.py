"""TRẦN THÀNH VIÊN MỖI WORKSPACE — chạm trần là ngưng mời (chốt user 3/9/2026).

Vì sao có cột riêng thay vì dùng `seat_total`: `seat_total` là số SCRAPE từ ChatGPT,
đổi theo lần sync gần nhất nên không dám chặn cứng bằng nó (guard suất sẵn có còn
phải nới +50% chính vì thế). Trần này là số super-admin TỰ GÕ = số suất đã mua thật,
nên chặn đúng bằng nó được.

Bất biến phải khoá:

  1. Chạm trần ⇒ lệnh mời bị TỪ CHỐI ở API (409) với ĐÚNG câu user chốt, và không
     trừ đồng nào của đại lý.
  2. Trần đo theo `seat_used` (đã vào + ĐANG CHỜ). Lời mời treo cũng chiếm chỗ —
     đếm theo `active` như guard suất thì mời tràn cả mẻ rồi mới biết.
  3. Cả mẻ vượt trần thì TỪ CHỐI CẢ MẺ, không mời được bao nhiêu hay bấy nhiêu:
     mời nửa mẻ là vừa vượt trần vừa phải đi dò xem ai đã vào ai chưa.
  4. Người ĐANG giữ chỗ (gia hạn / mời lại `pending`) vẫn chạy được khi đã chạm
     trần — họ không làm con số tăng thêm.
  5. Để trống = không chặn; 0 = ngưng hẳn; và super-admin KHÔNG có cửa đi vòng
     (vượt trần là mất tiền thật, mà chính họ sửa được con số trong một cú bấm).
  6. Câu từ chối là câu ADMIN SOẠN, đã thay {conlai}/{ngay}/{ten} — cùng một câu
     với chỗ hiện trên trang Mời, để đại lý không đọc hai kiểu chữ khác nhau.
  7. Trần phải được kiểm LẠI lúc hoá đơn QR được trả tiền, không chỉ lúc tạo hoá
     đơn: giữa hai mốc đó chỗ trống cuối cùng có thể đã bị lệnh khác lấy mất.
  8. Ghế chỉ được NHẢ khi đã gỡ THẬT trên ChatGPT. Chuyển hạn/đổi email chỉ xếp lệnh
     gỡ rồi chờ bằng chứng — nhả sớm là đếm ra một chỗ trống không tồn tại.
"""

import uuid

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


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _set_cap(
    client: TestClient,
    auth_header: dict,
    ws_id: str,
    cap: int | None,
    *,
    reopen_at: str | None = None,
):
    body: dict = {"invite_member_cap": cap}
    if reopen_at is not None:
        body["invite_cap_reopen_at"] = reopen_at
    r = client.patch(
        f"/api/v1/workspaces/{ws_id}", json=body, headers=auth_header
    )
    assert r.status_code == 200, r.text
    return r.json()


def _set_message(client: TestClient, auth_header: dict, text: str | None):
    r = client.put(
        "/api/v1/admin/invite-settings",
        json={"cap_message": text},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _default_message(client: TestClient, auth_header: dict) -> str:
    r = client.get("/api/v1/admin/invite-settings", headers=auth_header)
    assert r.status_code == 200, r.text
    return r.json()["default_message"]


def _invite(client: TestClient, token: str, ws_id: str, *emails: str):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": list(emails), "role": "member"},
        headers=bearer(token),
    )


def _seats_row(client: TestClient, auth_header: dict, ws_id: str) -> dict:
    r = client.get("/api/v1/workspaces/seats", headers=auth_header)
    assert r.status_code == 200, r.text
    row = next(x for x in r.json() if x["workspace_id"] == ws_id)
    return row


def _member_count(ws_id: str) -> int:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        return (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws_id), Member.status != "removed")
            .count()
        )


def test_cap_reached_refuses_invite_without_charging(
    client: TestClient, auth_header: dict
) -> None:
    ws = create_ws(client, auth_header, "Cap WS")
    _set_cap(client, auth_header, ws["id"], 1)
    sub = make_beta_sub(client, auth_header, username="capsub", balance=FEE * 3)
    assign(client, auth_header, ws["id"], sub["id"])

    first = _invite(client, sub["token"], ws["id"], "cap1@example.com")
    assert first.status_code == 202, first.text
    assert wallet_of(client, sub["token"])["balance"] == FEE * 2

    # (2) Người đầu mới chỉ `pending` mà đã chiếm chỗ ⇒ người thứ hai bị chặn.
    blocked = _invite(client, sub["token"], ws["id"], "cap2@example.com")
    assert blocked.status_code == 409, blocked.text
    assert "0 suất" in blocked.json()["detail"]
    # (1) Bị từ chối thì không trừ đồng nào, cũng không để lại member nào.
    assert wallet_of(client, sub["token"])["balance"] == FEE * 2
    assert _member_count(ws["id"]) == 1


def test_batch_over_cap_is_refused_whole(client: TestClient, auth_header: dict) -> None:
    """(3) Còn 1 chỗ mà dán 3 email ⇒ từ chối cả mẻ, không mời lấy một người."""
    ws = create_ws(client, auth_header, "Cap WS batch")
    _set_cap(client, auth_header, ws["id"], 1)
    sub = make_beta_sub(client, auth_header, username="capbatch", balance=FEE * 5)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(
        client,
        sub["token"],
        ws["id"],
        "b1@example.com",
        "b2@example.com",
        "b3@example.com",
    )
    assert r.status_code == 409, r.text
    assert "1 suất" in r.json()["detail"], (
        "câu từ chối phải nói còn ĐÚNG 1 chỗ, không phải 0 — dán 3 email vào 1 chỗ "
        "trống thì cả mẻ bị chặn nhưng chỗ trống vẫn còn nguyên"
    )
    assert _member_count(ws["id"]) == 0
    assert wallet_of(client, sub["token"])["balance"] == FEE * 5


def test_existing_seat_holder_still_goes_through_at_cap(
    client: TestClient, auth_header: dict
) -> None:
    """(4) Chạm trần vẫn mời lại được người ĐANG giữ chỗ — họ không làm số tăng."""
    ws = create_ws(client, auth_header, "Cap WS holder")
    _set_cap(client, auth_header, ws["id"], 1)
    sub = make_beta_sub(client, auth_header, username="capholder", balance=FEE * 4)
    assign(client, auth_header, ws["id"], sub["id"])

    assert _invite(client, sub["token"], ws["id"], "holder@example.com").status_code == 202
    again = _invite(client, sub["token"], ws["id"], "holder@example.com")
    assert again.status_code == 202, again.text
    assert _member_count(ws["id"]) == 1


def test_no_cap_and_zero_cap(client: TestClient, auth_header: dict) -> None:
    """(5) Để trống = mời thoải mái; 0 = ngưng hẳn ngay từ email đầu tiên."""
    ws = create_ws(client, auth_header, "Cap WS none")
    sub = make_beta_sub(client, auth_header, username="capnone", balance=FEE * 5)
    assign(client, auth_header, ws["id"], sub["id"])

    assert _invite(client, sub["token"], ws["id"], "n1@example.com").status_code == 202
    assert _invite(client, sub["token"], ws["id"], "n2@example.com").status_code == 202

    _set_cap(client, auth_header, ws["id"], 0)
    stopped = _invite(client, sub["token"], ws["id"], "n3@example.com")
    assert stopped.status_code == 409, stopped.text

    # Bỏ trần (gửi null) ⇒ mời lại được ngay, không cần đụng gì khác.
    _set_cap(client, auth_header, ws["id"], None)
    assert _invite(client, sub["token"], ws["id"], "n3@example.com").status_code == 202


def test_super_admin_has_no_way_around_the_cap(
    client: TestClient, auth_header: dict
) -> None:
    """(5) Guard suất cũ chừa cửa cho super-admin; trần thì KHÔNG."""
    ws = create_ws(client, auth_header, "Cap WS super")
    _set_cap(client, auth_header, ws["id"], 0)
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": ["super@example.com"], "role": "member"},
        headers=auth_header,
    )
    assert r.status_code == 409, r.text


def test_seats_endpoint_reports_cap_state(client: TestClient, auth_header: dict) -> None:
    """Trang Mời đọc trạng thái chạm trần từ `GET /workspaces/seats` (poll 15s),
    không thêm lượt gọi nào — nên cột phải có ở đó."""
    ws = create_ws(client, auth_header, "Cap WS seats")
    sub = make_beta_sub(client, auth_header, username="capseats", balance=FEE * 2)
    assign(client, auth_header, ws["id"], sub["id"])

    row = _seats_row(client, auth_header, ws["id"])
    assert row["invite_member_cap"] is None
    assert row["invite_cap_reached"] is False

    _set_cap(client, auth_header, ws["id"], 1)
    assert _invite(client, sub["token"], ws["id"], "s1@example.com").status_code == 202
    row = _seats_row(client, auth_header, ws["id"])
    assert row["invite_member_cap"] == 1
    assert row["seat_used"] == 1
    assert row["invite_cap_reached"] is True


def test_admin_message_is_used_and_placeholders_filled(
    client: TestClient, auth_header: dict
) -> None:
    """(6) Câu admin soạn thay hẳn câu mặc định, và {conlai}/{ngay}/{ten} được thay."""
    ws = create_ws(client, auth_header, "Cap WS msg")
    _set_cap(client, auth_header, ws["id"], 1, reopen_at="2026-09-07")
    _set_message(
        client,
        auth_header,
        "{ten} còn {conlai} suất, mở lại ngày {ngay}.",
    )
    sub = make_beta_sub(client, auth_header, username="capmsg", balance=FEE * 3)
    assign(client, auth_header, ws["id"], sub["id"])

    assert _invite(client, sub["token"], ws["id"], "m1@example.com").status_code == 202
    blocked = _invite(client, sub["token"], ws["id"], "m2@example.com")
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["detail"] == "Cap WS msg còn 0 suất, mở lại ngày 7/9/2026."

    # Cùng một câu đó phải có sẵn trong ảnh chụp suất — trang Mời in thẳng, không ghép.
    assert _seats_row(client, auth_header, ws["id"])["invite_cap_message"] == (
        "Cap WS msg còn 0 suất, mở lại ngày 7/9/2026."
    )


def test_blank_message_falls_back_to_default(
    client: TestClient, auth_header: dict
) -> None:
    """Xoá trắng ô soạn ⇒ quay về câu mặc định, KHÔNG phải từ chối không lời."""
    ws = create_ws(client, auth_header, "Cap WS blank")
    _set_cap(client, auth_header, ws["id"], 0)
    _set_message(client, auth_header, "   ")
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": ["blank@example.com"], "role": "member"},
        headers=auth_header,
    )
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail.strip(), "không được từ chối bằng câu rỗng"
    assert "chưa thông báo" in detail, "chưa đặt ngày ⇒ {ngay} phải thành 'chưa thông báo'"
    assert "{" not in _default_message(client, auth_header).replace("{conlai}", "").replace(
        "{ngay}", ""
    ), "câu mặc định chỉ được dùng chỗ thay động đã khai báo"


def test_broken_placeholder_does_not_crash_invite(
    client: TestClient, auth_header: dict
) -> None:
    """Admin gõ lạc một dấu ngoặc nhọn thì lệnh mời vẫn phải chạy tới nơi (dùng
    `str.replace`, không `str.format`) — chỗ lạ để nguyên văn cho admin thấy mà sửa."""
    ws = create_ws(client, auth_header, "Cap WS braces")
    _set_cap(client, auth_header, ws["id"], 0)
    _set_message(client, auth_header, "Hết chỗ {conlai} {khong_ton_tai} {")
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": ["brace@example.com"], "role": "member"},
        headers=auth_header,
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "Hết chỗ 0 {khong_ton_tai} {"


def _webhook_body(note: str, amount: int, txn_id: str) -> dict:
    return {
        "transferType": "in",
        "transferAmount": amount,
        "content": note,
        "id": txn_id,
        "referenceCode": txn_id,
    }


def test_cap_filled_while_paying_qr_refuses_fulfillment(
    client: TestClient, auth_header: dict
) -> None:
    """Bất biến 7 — cửa sổ chờ trả tiền.

    Ví thiếu ⇒ 402 + hoá đơn QR, và lúc đó CHƯA có Member nào được tạo. Trần thì
    thường được đặt đúng bằng số đang dùng, nên chỗ trống cuối cùng bị đại lý khác
    lấy mất trong lúc người này còn quét QR là chuyện thường ngày. Guard ở endpoint
    chỉ chứng minh được lúc TẠO hoá đơn còn chỗ ⇒ phải kiểm LẠI lúc thực thi.

    Tiền QR vẫn credit vào ví (không mất đồng nào), KHÔNG trừ phí, không tạo member,
    không sinh queue, và `fulfillment_error` mang đúng câu admin soạn để đại lý đọc
    được lý do thay vì ngồi chờ một lời mời không bao giờ tới.
    """
    ws = create_ws(client, auth_header, "Cap WS race")
    _set_cap(client, auth_header, ws["id"], 1)
    _set_message(client, auth_header, "Hết chỗ, còn {conlai} suất.")
    a = make_beta_sub(client, auth_header, username="capracea", balance=0)
    b = make_beta_sub(client, auth_header, username="capraceb", balance=FEE)
    assign(client, auth_header, ws["id"], a["id"])
    assign(client, auth_header, ws["id"], b["id"])

    # A ví rỗng → 402 + hoá đơn. Lúc này còn đúng 1 chỗ nên guard endpoint cho qua.
    r = _invite(client, a["token"], ws["id"], "capracea@example.com")
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]

    # B lấy mất chỗ cuối TRƯỚC khi A trả tiền.
    assert _invite(client, b["token"], ws["id"], "capraceb@example.com").status_code == 202
    assert _member_count(ws["id"]) == 1

    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-CAP-1"))
    assert wh.status_code == 200 and wh.json().get("success") is True

    o = client.get(
        f"/api/v1/wallet/orders/{order['id']}", headers=bearer(a["token"])
    ).json()
    assert o["status"] == "paid"
    assert o["queue_item_id"] is None, "vượt trần thì KHÔNG được sinh lệnh mời"
    assert o["fulfillment_error"] == "Hết chỗ, còn 0 suất.", (
        "phải là câu admin soạn, không phải 'HTTPException(...)' hay mã 409"
    )
    # Tiền ở lại ví A, không trừ phí, và trần vẫn đúng 1 người.
    assert wallet_of(client, a["token"])["balance"] == FEE
    assert _member_count(ws["id"]) == 1


def _member_id(client: TestClient, auth_header: dict, ws_id: str, email: str) -> str:
    r = client.get(f"/api/v1/workspaces/{ws_id}/members", headers=auth_header)
    assert r.status_code == 200, r.text
    return {m["email"]: m["id"] for m in r.json()}[email]


def _finish_removal(client: TestClient, ws: dict, auth_header: dict, email: str) -> None:
    """Extension chốt lệnh gỡ KÈM BẰNG CHỨNG (`verified`) — chỉ lúc này ghế mới trống."""
    tasks = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}&limit=50", headers=auth_header
    ).json()
    task = next(
        t
        for t in tasks
        if t["type"] == "REMOVE_MEMBER" and (t["payload"] or {}).get("email") == email
    )
    r = client.patch(
        f"/api/v1/queue/{task['id']}",
        json={"status": "COMPLETED", "result": {"data": {"verified": True}}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def test_transfer_does_not_free_seat_until_removal_verified(
    client: TestClient, auth_header: dict
) -> None:
    """Bất biến 8 — GHẾ CHỈ ĐƯỢC NHẢ KHI ĐÃ GỠ THẬT.

    Chuyển hạn/đổi email trước 5/9/2026 đánh dấu email cho là `removed` NGAY lúc bấm,
    trong khi việc gỡ trên ChatGPT mới chỉ là một task vừa xếp hàng. Phép đếm suất vì
    thế báo trống một chỗ mà ChatGPT không có, và chỗ ma đó được bán cho người tiếp
    theo. Ca thật GPT1 5/9/2026: lệnh gỡ kết luận "không thấy ở tab Người dùng" rồi
    mark removed mà KHÔNG bấm xoá — email ăn ghế thật thêm 16.7 tiếng, workspace vượt
    trần 387/386 khi đồng bộ chữa lại sự thật.

    Dùng ca CỘNG DỒN (email nhận đang là thành viên) để cô lập đúng một biến: không có
    lệnh mời nào, nên mọi thay đổi của `seat_used` chỉ đến từ việc nhả ghế.
    """
    ws = create_ws(client, auth_header, "Cap WS transfer", seat_total=50)
    _set_cap(client, auth_header, ws["id"], 2)
    sub = make_beta_sub(client, auth_header, username="captrans", balance=FEE * 5)
    assign(client, auth_header, ws["id"], sub["id"])

    first = _invite(
        client, sub["token"], ws["id"], "capt-a@example.com", "capt-b@example.com"
    )
    assert first.status_code == 202, first.text
    assert _member_count(ws["id"]) == 2, "đã chạm đúng trần"

    invites_before = _tasks_of_type(client, auth_header, ws["id"], "INVITE_MEMBER")
    a_id = _member_id(client, auth_header, ws["id"], "capt-a@example.com")
    moved = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{a_id}/transfer-subscription",
        json={"target_email": "capt-b@example.com"},
        headers=auth_header,
    )
    assert moved.status_code == 201, moved.text
    # Email nhận đang dùng ⇒ chỉ cộng dồn hạn, KHÔNG sinh thêm lệnh mời nào.
    assert (
        _tasks_of_type(client, auth_header, ws["id"], "INVITE_MEMBER") == invites_before
    )

    # Ghế CHƯA trống: email cho vẫn đang ngồi trên ChatGPT tới khi lệnh gỡ chứng minh.
    assert _member_count(ws["id"]) == 2
    assert _seats_row(client, auth_header, ws["id"])["seat_used"] == 2
    blocked = _invite(client, sub["token"], ws["id"], "capt-c@example.com")
    assert blocked.status_code == 409, (
        "chuyển hạn vừa nhả một ghế MA — đúng cách bán tràn quá trần"
    )

    # Gỡ xong KÈM BẰNG CHỨNG → giờ mới thật sự còn chỗ.
    _finish_removal(client, ws, auth_header, "capt-a@example.com")
    assert _member_count(ws["id"]) == 1
    assert _seats_row(client, auth_header, ws["id"])["seat_used"] == 1
    assert _invite(client, sub["token"], ws["id"], "capt-c@example.com").status_code == 202


def _tasks_of_type(
    client: TestClient, auth_header: dict, ws_id: str, ttype: str
) -> int:
    tasks = client.get(
        f"/api/v1/queue?workspace_id={ws_id}&limit=50", headers=auth_header
    ).json()
    return sum(1 for t in tasks if t["type"] == ttype)


def _mark_paid_removed(ws_id: str, email: str, *, joined: bool = False) -> None:
    """Dựng KHÁCH ĐÃ TRẢ TIỀN MÀ MẤT CHỖ: còn hạn, `paid`, nhưng đã bị gỡ.

    `joined=False` là đúng ca sinh ra luật (`mme.hebrahimi` 6/9/2026): lệnh mời đầu
    tiên chết vì hết giờ nên họ chưa từng vào đội, backend hoàn phí rồi xoá bản ghi,
    trong khi gói vẫn còn hạn.
    """
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Member

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws_id), Member.email == email)
            .one()
        )
        m.status = "removed"
        m.removed_at = now
        m.joined_at = now - timedelta(days=2) if joined else None
        m.payment_status = "paid"
        m.subscription_end_at = now + timedelta(days=28)
        db.commit()


def test_paid_customer_who_lost_seat_gets_back_in_at_cap(
    client: TestClient, auth_header: dict
) -> None:
    """(9) Trần KHÔNG chặn khách ĐÃ TRẢ TIỀN mà đang mất chỗ (chốt user 7/9/2026).

    Trần gác chuyện tiêu tiền cho NGƯỜI MỚI. Khách đã trả tiền thì chỗ ngồi là món
    nợ của mình với họ — bắt họ chờ tới ngày admin mở trần là hạn cứ trôi mà không
    dùng được ngày nào.
    """
    ws = create_ws(client, auth_header, "Cap WS paid")
    _set_cap(client, auth_header, ws["id"], 1)
    sub = make_beta_sub(client, auth_header, username="cappaid", balance=FEE * 4)
    assign(client, auth_header, ws["id"], sub["id"])

    assert _invite(client, sub["token"], ws["id"], "daitra@example.com").status_code == 202
    _mark_paid_removed(ws["id"], "daitra@example.com")
    # Trần đã đầy bởi một người khác đang ngồi.
    assert _invite(client, sub["token"], ws["id"], "nguoikhac@example.com").status_code == 202
    assert _member_count(ws["id"]) == 1

    back = _invite(client, sub["token"], ws["id"], "daitra@example.com")
    assert back.status_code == 202, back.text


def test_cap_still_stops_expired_customer_coming_back(
    client: TestClient, auth_header: dict
) -> None:
    """(9) Hết hạn thì KHÔNG được miễn: lần mời sau là chu kỳ mới có phí, tức chi
    tiêu mới — vẫn phải xin phép trần."""
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Member

    ws = create_ws(client, auth_header, "Cap WS expired")
    _set_cap(client, auth_header, ws["id"], 1)
    sub = make_beta_sub(client, auth_header, username="capexp", balance=FEE * 4)
    assign(client, auth_header, ws["id"], sub["id"])

    assert _invite(client, sub["token"], ws["id"], "hethan@example.com").status_code == 202
    _mark_paid_removed(ws["id"], "hethan@example.com")
    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws["id"]),
                Member.email == "hethan@example.com",
            )
            .one()
        )
        m.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.commit()
    assert _invite(client, sub["token"], ws["id"], "nguoikhac@example.com").status_code == 202

    stopped = _invite(client, sub["token"], ws["id"], "hethan@example.com")
    assert stopped.status_code == 409, stopped.text
