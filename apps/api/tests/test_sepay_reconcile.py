"""Đối soát ngân hàng: mọi webhook SePay đều để lại dấu vết (GET /wallet/sepay-events).

Chốt 5 điều: (1) khoản cộng ví thành công có dòng `credited` gắn đúng chủ, (2) khoản
chuyển SAI NỘI DUNG vẫn được ghi (`unmatched`) chứ không bốc hơi, (3) khoản LỆCH TIỀN
so với hoá đơn ghi `declined` kèm lý do, (4) user thường chỉ thấy phần của mình còn
super-admin thấy tất, (5) tổng ngày cộng đúng: nhận − vào ví = phần đang kẹt.

Vì sao cần: trước 26/8/2026 chỉ `wallet_transactions` (tiền ĐÃ vào ví) và `sepay_idem`
(mỗi cái key) được lưu, nên "tiền về mà ví đứng im" không tra được ở đâu cả.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from tests.wallet_helpers import bearer, make_beta_sub, set_settings, wallet_of

VN_TZ = timezone(timedelta(hours=7))


def _webhook_body(note: str, amount: int, txn_id: str) -> dict:
    return {
        "transferType": "in",
        "transferAmount": amount,
        "content": note,
        "id": txn_id,
        "referenceCode": txn_id,
    }


def _events(client: TestClient, token: str, date: str | None = None) -> dict:
    url = "/api/v1/wallet/sepay-events" + (f"?date={date}" if date else "")
    r = client.get(url, headers=bearer(token))
    assert r.status_code == 200, r.text
    return r.json()


def test_credited_transfer_is_recorded(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="soat1")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(sub["token"])
    ).json()

    client.post("/webhook/sepay", json=_webhook_body(topup["note"], 200_000, "SP-SOAT-1"))
    assert wallet_of(client, sub["token"])["balance"] == 200_000

    day = _events(client, sub["token"])
    assert day["date"] == datetime.now(VN_TZ).date().isoformat()
    assert day["received_total"] == 200_000
    assert day["credited_total"] == 200_000
    assert day["pending_total"] == 0
    assert len(day["events"]) == 1
    ev = day["events"][0]
    assert ev["result"] == "credited"
    assert ev["flow"] == "topup"
    assert ev["provider_txn_id"] == "SP-SOAT-1"
    assert ev["amount"] == 200_000
    assert ev["source"] == "webhook"


def test_wrong_content_transfer_is_not_lost(client: TestClient, auth_header: dict) -> None:
    """Chuyển tiền KHÔNG có mã nạp: ví không nhảy, nhưng khoản tiền phải hiện ra.

    Đây chính là ca trước đây mất tăm — webhook trả "no recognized code" rồi thôi.
    """
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="soat2")

    wh = client.post("/webhook/sepay", json=_webhook_body("chuyen tien cho ban", 500_000, "SP-SOAT-2"))
    assert wh.status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 0

    # Không khớp ai → user thường KHÔNG thấy (nội dung CK người lạ), super-admin thấy.
    assert _events(client, sub["token"])["received_total"] == 0
    admin_day = _events(client, auth_header["Authorization"].split(" ", 1)[1])
    unmatched = [e for e in admin_day["events"] if e["provider_txn_id"] == "SP-SOAT-2"]
    assert len(unmatched) == 1
    assert unmatched[0]["result"] == "unmatched"
    assert unmatched[0]["amount"] == 500_000
    assert admin_day["pending_total"] >= 500_000
    assert admin_day["is_admin_view"] is True


def test_amount_mismatch_is_recorded_with_reason(client: TestClient, auth_header: dict) -> None:
    """Hoá đơn 300k mà chuyển 100k: không thực thi, và sổ đối soát nói rõ lệch bao nhiêu."""
    set_settings(client, auth_header, amount_tolerance_vnd=1000)
    sub = make_beta_sub(client, auth_header, username="soat3")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 300_000}, headers=bearer(sub["token"])
    ).json()

    # Mã NẠP cộng đúng số tiền nhận (không phụ thuộc lệnh) → dùng mã ORDER không tồn tại
    # để tạo ca "khớp tiền tố nhưng handler từ chối".
    client.post("/webhook/sepay", json=_webhook_body("ORDERkhongcothat", 100_000, "SP-SOAT-3"))
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert topup["status"] == "pending"

    admin_token = auth_header["Authorization"].split(" ", 1)[1]
    rows = [e for e in _events(client, admin_token)["events"] if e["provider_txn_id"] == "SP-SOAT-3"]
    assert len(rows) == 1
    assert rows[0]["result"] == "declined"
    assert rows[0]["flow"] == "order"
    assert "không tồn tại" in (rows[0]["note"] or "")


def test_duplicate_webhook_not_counted_twice(client: TestClient, auth_header: dict) -> None:
    """Webhook lặp: ví cộng 1 lần, sổ đối soát cũng chỉ 1 dòng (khoá theo txn id)."""
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="soat4")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 150_000}, headers=bearer(sub["token"])
    ).json()

    body = _webhook_body(topup["note"], 150_000, "SP-SOAT-4")
    client.post("/webhook/sepay", json=body)
    client.post("/webhook/sepay", json=body)

    assert wallet_of(client, sub["token"])["balance"] == 150_000
    day = _events(client, sub["token"])
    assert len(day["events"]) == 1
    assert day["received_total"] == 150_000
    assert day["credited_total"] == 150_000


def test_other_day_is_empty(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="soat5")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 120_000}, headers=bearer(sub["token"])
    ).json()
    client.post("/webhook/sepay", json=_webhook_body(topup["note"], 120_000, "SP-SOAT-5"))

    yesterday = (datetime.now(VN_TZ).date() - timedelta(days=1)).isoformat()
    past = _events(client, sub["token"], yesterday)
    assert past["date"] == yesterday
    assert past["received_total"] == 0
    assert past["events"] == []
    assert past["empty"] is True


def test_bank_time_decides_the_day(client: TestClient, auth_header: dict) -> None:
    """SePay gửi kèm `transactionDate` → giao dịch thuộc NGÀY NGÂN HÀNG ghi nhận.

    Webhook retry muộn (qua nửa đêm) mà tính theo giờ mình nhận thì tiền rơi nhầm sang
    ngày hôm sau, đối soát lệch cả hai ngày.
    """
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="soat6")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 90_000}, headers=bearer(sub["token"])
    ).json()

    yesterday = (datetime.now(VN_TZ).date() - timedelta(days=1)).isoformat()
    body = _webhook_body(topup["note"], 90_000, "SP-SOAT-6")
    body["transactionDate"] = f"{yesterday} 23:58:00"
    client.post("/webhook/sepay", json=body)

    assert _events(client, sub["token"])["received_total"] == 0  # không phải hôm nay
    past = _events(client, sub["token"], yesterday)
    assert past["received_total"] == 90_000
    assert past["events"][0]["result"] == "credited"


def test_empty_ledger_says_why(client: TestClient, auth_header: dict) -> None:
    """Sổ trống phải nói được VÌ SAO trống, không im lặng như thể hỏng.

    User mở "Đối soát ngân hàng" ngay sau khi deploy, thấy trắng trơn và tưởng tính
    năng chết (2026-08-27). Thật ra sổ chỉ ghi từ lúc bản đó chạy — cần `ledger_first_date`
    (sổ bắt đầu từ ngày nào) và `sync_needs_token` (thiếu token nên chưa kéo được ngày
    cũ) để màn hình phân biệt "không ai chuyển tiền" với "chưa có dữ liệu ở đây".
    """
    admin_token = auth_header["Authorization"].split(" ", 1)[1]
    day = _events(client, admin_token)
    assert day["events"] == []
    assert day["empty"] is True
    assert day["ledger_first_date"] is None  # sổ chưa ghi gì
    # Test chạy không có SEPAY_USER_API_TOKEN → phải chỉ ra là thiếu token.
    assert day["can_sync"] is False
    assert day["sync_needs_token"] is True


def test_ledger_first_date_tracks_earliest_row(client: TestClient, auth_header: dict) -> None:
    """Có dữ liệu rồi thì `ledger_first_date` = ngày sớm nhất sổ có, theo giờ VN."""
    set_settings(client, auth_header)
    sub = make_beta_sub(client, auth_header, username="soat7")
    topup = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 80_000}, headers=bearer(sub["token"])
    ).json()

    yesterday = (datetime.now(VN_TZ).date() - timedelta(days=1)).isoformat()
    body = _webhook_body(topup["note"], 80_000, "SP-SOAT-7")
    body["transactionDate"] = f"{yesterday} 08:00:00"
    client.post("/webhook/sepay", json=body)

    # Hỏi ngày HÔM NAY (trống) nhưng vẫn biết sổ bắt đầu từ hôm qua.
    day = _events(client, sub["token"])
    assert day["events"] == []
    assert day["ledger_first_date"] == yesterday


def test_admin_can_scope_events_to_one_user(client: TestClient, auth_header: dict) -> None:
    """Admin mở đối soát từ trang ví của một người: chỉ tiền vào của người đó.

    Trước đây trang ví của tuan hiện cả 40 giao dịch trong ngày của mọi tài khoản
    (user 2026-08-29) — nhìn vào không biết khoản nào là của ai.
    """
    set_settings(client, auth_header)
    a = make_beta_sub(client, auth_header, username="soat9a")
    b = make_beta_sub(client, auth_header, username="soat9b")
    admin_token = auth_header["Authorization"].split(" ", 1)[1]

    note_a = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 200_000}, headers=bearer(a["token"])
    ).json()["note"]
    note_b = client.post(
        "/api/v1/wallet/topups", json={"amount_vnd": 300_000}, headers=bearer(b["token"])
    ).json()["note"]
    client.post("/webhook/sepay", json=_webhook_body(note_a, 200_000, "SP-SOAT-9A"))
    client.post("/webhook/sepay", json=_webhook_body(note_b, 300_000, "SP-SOAT-9B"))
    # Khoản không khớp ai: chỉ được nằm ở bảng tổng, không rơi vào ví ai cả.
    client.post("/webhook/sepay", json=_webhook_body("chuyen khoan la", 90_000, "SP-SOAT-9C"))

    r = client.get(
        f"/api/v1/wallet/sepay-events?user_id={a['id']}", headers=bearer(admin_token)
    )
    assert r.status_code == 200, r.text
    scoped = r.json()
    assert [e["provider_txn_id"] for e in scoped["events"]] == ["SP-SOAT-9A"]
    assert scoped["received_total"] == 200_000
    assert scoped["credited_total"] == 200_000
    assert scoped["is_admin_view"] is False  # đang bó theo một người, không phải bảng tổng
    assert scoped["can_sync"] == _events(client, admin_token)["can_sync"]

    # Bảng tổng vẫn thấy đủ cả ba khoản.
    total = _events(client, admin_token)
    ids = {e["provider_txn_id"] for e in total["events"]}
    assert {"SP-SOAT-9A", "SP-SOAT-9B", "SP-SOAT-9C"} <= ids
    assert total["received_total"] >= 590_000


def test_non_admin_cannot_scope_to_another_user(client: TestClient, auth_header: dict) -> None:
    """User thường bịa `user_id` của người khác: bị chặn, không rò tiền vào của ai cả."""
    set_settings(client, auth_header)
    a = make_beta_sub(client, auth_header, username="soat10a")
    b = make_beta_sub(client, auth_header, username="soat10b")

    r = client.get(f"/api/v1/wallet/sepay-events?user_id={a['id']}", headers=bearer(b["token"]))
    assert r.status_code == 403
