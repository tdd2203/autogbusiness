"""HOÁ ĐƠN QR PHẢI GIAO ĐÚNG THỨ ĐÃ BÁN — không nhiều hơn, không miễn phí.

Ba tật cùng một gốc: giữa lúc in mã QR và lúc tiền về là một khoảng chờ, mà cả HẠN
lẫn TIỀN ở chế độ `cycle_aligned` đều đo từ ĐIỂM NỐI (EXPIRY_RULES §3.6.2). Cứ lấy giờ
lúc tiền về là giao thêm một quãng mà hoá đơn không hề tính tiền — chiều lệch luôn về
phía khách, không bao giờ về phía mình.

  1. Hoá đơn phải mang dấu mốc báo giá (`priced_at`), và webhook phải áp lại bằng đúng
     dấu đó (luồng MỜI và luồng ĐỔI HẠN; luồng GIA HẠN đã khoá ở `test_payment_flow`).
  2. Đổi hạn khi tiền về phải thu ĐÚNG con số in trên mã QR, không tính lại.
  3. Thực thi hỏng giữa chừng thì phải HOÀN TÁC hết, đừng để lại phần đã làm. Ca thật:
     khách chuyển thiếu trong dung sai (mặc định 1.000đ) → ví được cộng đúng số nhận
     nhưng phí trừ theo số trên hoá đơn ⇒ trừ ví hỏng SAU khi hạn đã dời ⇒ gia hạn
     không mất tiền.
"""

import uuid
from datetime import datetime, timedelta, timezone

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


def _webhook_body(note: str, amount: int, txn_id: str) -> dict:
    return {
        "transferType": "in",
        "transferAmount": amount,
        "content": note,
        "id": txn_id,
        "referenceCode": txn_id,
    }


def _invite(client: TestClient, token: str, ws_id: str, email: str, **extra):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", **extra},
        headers=bearer(token),
    )


def _order_row(order_id: str):
    from app.db import SessionLocal
    from app.models import PaymentOrder

    with SessionLocal() as db:
        o = db.get(PaymentOrder, uuid.UUID(order_id))
        return {
            "payload": dict(o.payload or {}),
            "amount_vnd": int(o.amount_vnd),
            "status": o.status,
            "fulfillment_error": o.fulfillment_error,
            "fulfilled_at": o.fulfilled_at,
        }


def _stamp_priced_at(order_id: str, at: datetime) -> None:
    """Ghi đè dấu mốc báo giá — giả lập "hoá đơn được in lúc đó, tiền về bây giờ"."""
    from app.db import SessionLocal
    from app.models import PaymentOrder

    with SessionLocal() as db:
        o = db.get(PaymentOrder, uuid.UUID(order_id))
        o.payload = {**(o.payload or {}), "priced_at": at.isoformat()}
        db.commit()


def _member_row(member_id: str):
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        return {
            "end_at": m.subscription_end_at,
            "purchased_at": m.subscription_purchased_at,
            "months": m.subscription_months,
        }


def _set_end_at(member_id: str, at: datetime | None) -> None:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        m.subscription_end_at = at
        db.commit()


def _switch_to_cycle_aligned(ws_id: str, anchor_day: int = 25) -> None:
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        ws = db.get(Workspace, uuid.UUID(ws_id))
        ws.billing_mode = "cycle_aligned"
        ws.cycle_anchor_day = anchor_day
        db.commit()


# ── 1. Dấu mốc báo giá phải có trên hoá đơn ──────────────────────────────────

def test_hoa_don_moi_mang_dau_moc_bao_gia(client: TestClient, auth_header: dict) -> None:
    """Thiếu dấu này thì webhook chỉ còn cách đoán, và nó đoán bằng giờ lúc tiền về."""
    ws = create_ws(client, auth_header, "Dau Moc Moi WS")
    sub = make_beta_sub(client, auth_header, username="daumocmoi", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "dm1@example.com")
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]

    payload = _order_row(order["id"])["payload"]
    assert "priced_at" in payload, "hoá đơn mời không đóng dấu mốc báo giá"
    at = datetime.fromisoformat(payload["priced_at"])
    assert at.tzinfo is not None
    assert abs((datetime.now(timezone.utc) - at).total_seconds()) < 60


def test_hoa_don_doi_han_mang_dau_moc_bao_gia(
    client: TestClient, auth_header: dict
) -> None:
    ws = create_ws(client, auth_header, "Dau Moc Doi Han WS")
    sub = make_beta_sub(client, auth_header, username="daumocdh", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    member_id = _invite(client, sub["token"], ws["id"], "dm2@example.com").json()["id"]
    r = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/subscription",
        json={"subscription_months": 2},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]

    payload = _order_row(order["id"])["payload"]
    assert "priced_at" in payload, "hoá đơn đổi hạn không đóng dấu mốc báo giá"


# ── 2. Webhook áp lại bằng đúng mốc đã báo giá ───────────────────────────────

def test_webhook_moi_ap_theo_moc_da_bao_gia(
    client: TestClient, auth_header: dict
) -> None:
    """Mốc neo ghi lên member phải là mốc ĐÃ BÁO GIÁ, không phải giờ lúc tiền về.

    Ví được nạp dư để phép trừ phí không phải thứ quyết định kết quả — bài này hỏi
    đúng một câu: cửa sổ giao ra đo từ đồng hồ nào."""
    ws = create_ws(client, auth_header, "Ap Moc Moi WS")
    sub = make_beta_sub(client, auth_header, username="apmocmoi", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "am1@example.com")
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]

    priced = datetime.now(timezone.utc) - timedelta(days=3)
    _stamp_priced_at(order["id"], priced)

    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-AMOC-1")
    )
    assert wh.status_code == 200 and wh.json().get("success") is True

    members = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=bearer(sub["token"])
    ).json()
    m = next(m for m in members if m["email"] == "am1@example.com")
    row = _member_row(m["id"])
    assert row["purchased_at"] is not None
    delta = abs((row["purchased_at"].replace(tzinfo=timezone.utc) - priced).total_seconds())
    assert delta < 5, "mời qua QR vẫn tính cửa sổ theo giờ lúc tiền về"


def test_webhook_doi_han_thu_dung_so_in_tren_ma(
    client: TestClient, auth_header: dict
) -> None:
    """Hạn member bị đổi trong lúc chờ chuyển khoản KHÔNG được làm đổi số tiền thu.

    `amount_vnd` là con số khách đã nhìn thấy và đã chuyển đúng bằng đó; tính lại lúc
    tiền về chỉ là một giả thuyết về thế giới ở thời điểm khác — và giả thuyết đó có
    thể ra 0đ, để tiền khách kẹt lại trong ví mà không ai biết."""
    ws = create_ws(client, auth_header, "Thu Dung So WS")
    sub = make_beta_sub(client, auth_header, username="thudungso", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    member_id = _invite(client, sub["token"], ws["id"], "ts1@example.com").json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 0

    r = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/subscription",
        json={"subscription_months": 2},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]
    amount = order["amount_vnd"]

    # Trong lúc chờ chuyển khoản, một lệnh khác chuyển email này sang VÔ THỜI HẠN →
    # cách tính lại ra "không kéo dài" ⇒ phí 0 ⇒ tiền QR nằm kẹt trong ví.
    _set_end_at(member_id, None)

    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], amount, "ORD-TDS-1")
    )
    assert wh.status_code == 200 and wh.json().get("success") is True

    # Nạp `amount` rồi trừ đúng `amount` → ví về 0, không đồng nào kẹt lại.
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert _order_row(order["id"])["fulfilled_at"] is not None


def test_doi_han_ghi_ky_dung_cua_so_vua_ban(
    client: TestClient, auth_header: dict
) -> None:
    """Kỳ ghi lại phải là CHÍNH cửa sổ vừa bán, không phải "hạn cũ → hạn mới, 1 tháng".

    Báo cáo doanh thu đọc `months` khi dòng kỳ không có phần lẻ, nên kỳ sai là sổ ghi
    trọn một tháng cho quãng chỉ chạy tới mốc chốt — ví trừ một đằng, sổ ghi một nẻo.
    Đầu kỳ cũng phải trùng mốc neo (§3.6.7)."""
    import uuid as _uuid

    ws = create_ws(client, auth_header, "Ky Doi Han WS")
    sub = make_beta_sub(client, auth_header, username="kydoihan", balance=10 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    member_id = _invite(client, sub["token"], ws["id"], "kd1@example.com").json()["id"]
    # Ngày neo cách hôm nay ~15 ngày ⇒ điểm nối luôn rơi GIỮA chu kỳ ở mọi ngày chạy.
    anchor = ((datetime.now(timezone.utc).day + 15 - 1) % 28) + 1
    _switch_to_cycle_aligned(ws["id"], anchor_day=anchor)
    _set_end_at(member_id, datetime.now(timezone.utc) - timedelta(days=10))

    r = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/subscription",
        json={"subscription_months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 200, r.text

    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.get(Member, _uuid.UUID(member_id))
        cycle = sorted(m.subscription_cycles, key=lambda c: c.cycle_number)[-1]
        assert cycle.prorated_half_days is not None and cycle.prorated_half_days > 0
        assert (cycle.months or 0) == 0, "kỳ đang khai trọn một tháng"
        assert cycle.start_at.replace(tzinfo=timezone.utc) == m.subscription_purchased_at.replace(
            tzinfo=timezone.utc
        ), "đầu kỳ lệch khỏi mốc neo"
        assert cycle.end_at.replace(tzinfo=timezone.utc) == m.subscription_end_at.replace(
            tzinfo=timezone.utc
        )


def test_webhook_doi_han_ap_theo_moc_da_bao_gia(
    client: TestClient, auth_header: dict
) -> None:
    """Đổi hạn qua QR cũng phải đo cửa sổ từ đồng hồ ĐÃ BÁO GIÁ.

    Dựng ở không gian chốt theo chu kỳ vì chỉ ở đó mốc mới nhìn thấy được: mốc neo
    lưu lại chính là ĐIỂM NỐI của cửa sổ vừa bán (§3.6.7)."""
    ws = create_ws(client, auth_header, "Ap Moc Doi Han WS")
    sub = make_beta_sub(client, auth_header, username="apmocdh", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    member_id = _invite(client, sub["token"], ws["id"], "ad1@example.com").json()["id"]
    _switch_to_cycle_aligned(ws["id"], anchor_day=25)
    # Hết hạn → điểm nối = mốc báo giá, không phải hạn cũ.
    _set_end_at(member_id, datetime.now(timezone.utc) - timedelta(days=10))

    r = client.patch(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/subscription",
        json={"subscription_months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]

    priced = datetime.now(timezone.utc) - timedelta(days=2)
    _stamp_priced_at(order["id"], priced)

    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], order["amount_vnd"], "ORD-AMDH-1")
    )
    assert wh.status_code == 200 and wh.json().get("success") is True

    row = _member_row(member_id)
    delta = abs(
        (row["purchased_at"].replace(tzinfo=timezone.utc) - priced).total_seconds()
    )
    assert delta < 5, "đổi hạn qua QR vẫn đo cửa sổ theo giờ lúc tiền về"


# ── 3. Thực thi hỏng thì hoàn tác sạch, không giao hàng miễn phí ─────────────

def test_tra_thieu_trong_dung_sai_khong_duoc_gia_han_mien_phi(
    client: TestClient, auth_header: dict
) -> None:
    """Chuyển thiếu 999đ (lọt dung sai) mà ví rỗng ⇒ trừ phí hỏng.

    Phần đã làm trước lúc hỏng (dời hạn, nối chu kỳ 'đã thanh toán') PHẢI bị huỷ theo,
    bằng không khách được gia hạn mà ví không mất đồng nào. Tiền đã nhận vẫn ở lại ví
    (không mất) và hoá đơn ghi rõ lý do hỏng."""
    ws = create_ws(client, auth_header, "Tra Thieu WS")
    sub = make_beta_sub(client, auth_header, username="trathieu", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    member_id = _invite(client, sub["token"], ws["id"], "tt1@example.com").json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 0
    before = _member_row(member_id)

    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/renew",
        json={"months": 3},
        headers=bearer(sub["token"]),
    )
    assert rr.status_code == 402, rr.text
    order = rr.json()["detail"]["order"]
    amount = order["amount_vnd"]

    short = amount - 999  # lệch 999đ < dung sai mặc định 1.000đ → webhook vẫn nhận
    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], short, "ORD-TT-1")
    )
    assert wh.status_code == 200 and wh.json().get("success") is True

    after = _member_row(member_id)
    assert after["end_at"] == before["end_at"], "gia hạn vẫn được áp dù trừ phí hỏng"
    assert after["months"] == before["months"]
    # Tiền khách chuyển KHÔNG bị nuốt: nằm nguyên trong ví.
    assert wallet_of(client, sub["token"])["balance"] == short
    row = _order_row(order["id"])
    assert row["fulfilled_at"] is None
    # Câu lỗi là tiếng Việt nói được cách gỡ, không phải chuỗi nội bộ của thư viện.
    err = row["fulfillment_error"] or ""
    assert "thiếu" in err and "999" in err
    assert "Insufficient" not in err and "shortfall" not in err


def test_tra_du_thi_gia_han_chay_binh_thuong(
    client: TestClient, auth_header: dict
) -> None:
    """Đối chứng cho bài trên: đủ tiền thì savepoint không được cản đường."""
    ws = create_ws(client, auth_header, "Tra Du WS")
    sub = make_beta_sub(client, auth_header, username="tradu", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    member_id = _invite(client, sub["token"], ws["id"], "td1@example.com").json()["id"]
    before = _member_row(member_id)

    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/renew",
        json={"months": 3},
        headers=bearer(sub["token"]),
    )
    order = rr.json()["detail"]["order"]
    amount = order["amount_vnd"]

    wh = client.post(
        "/webhook/sepay", json=_webhook_body(order["note"], amount, "ORD-TD-1")
    )
    assert wh.status_code == 200

    after = _member_row(member_id)
    assert after["end_at"] > before["end_at"]
    assert wallet_of(client, sub["token"])["balance"] == 0
    row = _order_row(order["id"])
    assert row["fulfilled_at"] is not None and row["fulfillment_error"] is None
