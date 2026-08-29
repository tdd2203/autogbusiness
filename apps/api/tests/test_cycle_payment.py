"""Đại lý TỰ TRẢ kỳ CÒN NỢ — nút "Thanh toán" phải ra TIỀN, không ra lời hứa.

Ca thật 28-29/8/2026 (hdh2102, GPT1, 7 email): mời đi thật → chốt hỏng oan → hoàn
phí → lần đồng bộ sau dựng lại bản ghi member KHÔNG mang ký ức nào về tiền ⇒ 7 email
nằm ở diện "chưa thanh toán" trong khi khách đã dùng dịch vụ. Đại lý bấm "Thanh toán"
thì hệ thống chỉ GỬI YÊU CẦU cho super-admin bấm "Xác nhận" — không đồng nào chạy,
xác nhận xong là đóng dấu ĐÃ TRẢ trên một cái két rỗng (đúng kiểu đã mất 4.290.000đ
một lần rồi).

Test này giữ luật mới (chốt user 2026-08-29): đại lý đã bật Ví bấm "Thanh toán" =
`POST /added-members/pay` → ví đủ trừ thẳng, ví thiếu ra hoá đơn QR `kind='cycle'`,
webhook nhận đủ tiền mới đóng dấu kỳ. KHÔNG bao giờ đẩy ví xuống âm.

Phí GHIM = 100k (fixture `_pin_fee`) + cấu hình ngân hàng để dựng được QR.
"""

import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import (
    adjust,
    assign,
    bearer,
    create_ws,
    create_user,
    login,
    make_beta_sub,
    set_beta,
    set_settings,
    wallet_of,
)

FEE = 100_000
EMAIL = "cycledebt@example.com"


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


def _invite(client: TestClient, token: str, ws_id: str, email: str = EMAIL, months: int = 1):
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", "subscription_months": months},
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _cycles(member_id: str) -> list:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        return [
            {"id": str(c.id), "status": c.payment_status, "months": c.months}
            for c in m.subscription_cycles
        ]


def _member_status(member_id: str) -> str:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        return db.get(Member, uuid.UUID(member_id)).payment_status


def _blind_refund(
    member_id: str, *, requested: bool = False, drop_cycles: bool = False
) -> None:
    """Đưa member về đúng trạng thái sau ca hoàn phí mù: kỳ quay lại 'chưa thanh
    toán' (tuỳ chọn: đại lý đã lỡ gửi yêu cầu duyệt như 7 email trong ảnh).

    `drop_cycles=True` dựng lại hình dạng THẬT của 7 email đó: bản ghi member do lần
    đồng bộ sau đẻ ra — có hạn dùng, `subscription_months`, nhưng KHÔNG chu kỳ nào."""
    from app.db import SessionLocal
    from app.models import Member

    state = "requested" if requested else "unpaid"
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        m.payment_status = state
        m.paid_at = None
        m.paid_marked_by_id = None
        m.payment_requested_at = now if requested else None
        if drop_cycles:
            m.subscription_cycles = []
        else:
            for c in m.subscription_cycles:
                c.payment_status = state
                c.paid_at = None
                c.paid_marked_by_id = None
        db.commit()


def _setup_debt(
    client: TestClient,
    auth_header: dict,
    ws_name: str,
    username: str,
    *,
    refund_back: bool = True,
    requested: bool = False,
    drop_cycles: bool = False,
    months: int = 1,
):
    """Đại lý Ví có 1 email ĐÃ giao dịch vụ mà kỳ còn nợ (tiền đã hoàn về ví)."""
    ws = create_ws(client, auth_header, ws_name)
    sub = make_beta_sub(client, auth_header, username=username, balance=FEE * months)
    assign(client, auth_header, ws["id"], sub["id"])
    member_id = _invite(client, sub["token"], ws["id"], months=months)
    assert wallet_of(client, sub["token"])["balance"] == 0, "mời phải trừ phí"
    _blind_refund(member_id, requested=requested, drop_cycles=drop_cycles)
    if refund_back:
        adjust(client, auth_header, sub["id"], FEE * months, reason="hoàn phí mù")
    return ws, sub, member_id


def _pay(client: TestClient, token: str, **body):
    return client.post(
        "/api/v1/added-members/pay",
        json={"member_ids": [], "cycle_ids": [], **body},
        headers=bearer(token),
    )


def _txn_kinds(client: TestClient, token: str) -> list[str]:
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(token)).json()["items"]
    return [t["kind"] for t in txns]


# ── Ví đủ → trừ thẳng ────────────────────────────────────────────────────────

def test_pay_charges_wallet_and_marks_cycle_paid(
    client: TestClient, auth_header: dict
) -> None:
    """Cốt lõi: bấm "Thanh toán" là TIỀN RỜI VÍ, kỳ thành 'đã thanh toán' ngay —
    không phải xin super-admin xác nhận."""
    _ws, sub, member_id = _setup_debt(client, auth_header, "Pay WS", "paycyc1")
    cycle = _cycles(member_id)[0]
    assert cycle["status"] == "unpaid"

    r = _pay(client, sub["token"], cycle_ids=[cycle["id"]])
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 1, "charged_vnd": FEE}

    assert wallet_of(client, sub["token"])["balance"] == 0, "phải thu lại đúng số đã hoàn"
    assert _cycles(member_id)[0]["status"] == "paid"
    assert _member_status(member_id) == "paid"
    assert "cycle_fee" in _txn_kinds(client, sub["token"])


def test_pay_by_member_covers_every_unpaid_cycle(
    client: TestClient, auth_header: dict
) -> None:
    """Bấm ở cấp EMAIL trả hết mọi kỳ còn nợ, phí tính theo SỐ THÁNG của kỳ."""
    _ws, sub, member_id = _setup_debt(
        client, auth_header, "Months WS", "paycyc2", months=3
    )
    assert _cycles(member_id)[0]["months"] == 3

    r = _pay(client, sub["token"], member_ids=[member_id])
    assert r.status_code == 200, r.text
    assert r.json()["charged_vnd"] == 3 * FEE, "phí = đơn giá × số tháng của kỳ"
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert _cycles(member_id)[0]["status"] == "paid"


def test_pay_covers_cycle_already_requested(
    client: TestClient, auth_header: dict
) -> None:
    """ĐÚNG CA 7 EMAIL: kỳ đã lỡ gửi yêu cầu duyệt vẫn trả thẳng được, khỏi phải rút
    yêu cầu trước — và sau đó biến khỏi hàng chờ của super-admin."""
    _ws, sub, member_id = _setup_debt(
        client, auth_header, "Requested WS", "paycyc3", requested=True
    )
    before = client.get("/api/v1/added-members/pending-count", headers=auth_header)
    assert before.json()["count"] == 1

    r = _pay(client, sub["token"], member_ids=[member_id])
    assert r.status_code == 200, r.text
    assert r.json()["charged_vnd"] == FEE

    after = client.get("/api/v1/added-members/pending-count", headers=auth_header)
    assert after.json()["count"] == 0, (
        "đã trả tiền thật thì không còn gì cho super-admin bấm 'Xác nhận'"
    )


def test_pay_legacy_member_without_any_cycle(
    client: TestClient, auth_header: dict
) -> None:
    """HÌNH DẠNG THẬT của 7 email 28-29/8: bản ghi do sync dựng lại KHÔNG có chu kỳ
    nào, nợ nằm thẳng ở cấp member. Đường này không đi qua bảng chu kỳ nên
    `_recompute_member_payment_status` return sớm — dấu vết chờ duyệt phải được dọn
    tại chỗ, nếu không email đã trả tiền vẫn đeo mốc 'đã gửi yêu cầu'."""
    from app.db import SessionLocal
    from app.models import Member

    _ws, sub, member_id = _setup_debt(
        client,
        auth_header,
        "Legacy WS",
        "paycyc9",
        requested=True,
        drop_cycles=True,
    )
    assert _cycles(member_id) == [], "ca này phải KHÔNG có chu kỳ nào"
    assert client.get(
        "/api/v1/added-members/pending-count", headers=auth_header
    ).json()["count"] == 1

    r = _pay(client, sub["token"], member_ids=[member_id])
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 1, "charged_vnd": FEE}
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert _member_status(member_id) == "paid"

    with SessionLocal() as db:
        m = db.get(Member, uuid.UUID(member_id))
        assert m.paid_at is not None
        assert m.payment_requested_at is None, "đã trả tiền thì không còn yêu cầu treo"
        assert m.payment_requested_by_id is None

    assert client.get(
        "/api/v1/added-members/pending-count", headers=auth_header
    ).json()["count"] == 0


# ── Ví thiếu → QR → trả tiền → đóng dấu ──────────────────────────────────────

def test_pay_without_balance_returns_qr_and_keeps_cycle_unpaid(
    client: TestClient, auth_header: dict
) -> None:
    """Ví thiếu KHÔNG đẩy số dư xuống âm (lý do reconcile từ chối tự trừ): ra hoá
    đơn QR, kỳ giữ nguyên 'chưa thanh toán' tới khi tiền về."""
    _ws, sub, member_id = _setup_debt(
        client, auth_header, "QR Cycle WS", "paycyc4", refund_back=False
    )
    assert wallet_of(client, sub["token"])["balance"] == 0

    r = _pay(client, sub["token"], member_ids=[member_id])
    assert r.status_code == 402, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "PAYMENT_QR_REQUIRED"
    order = detail["order"]
    assert order["kind"] == "cycle" and order["amount_vnd"] == FEE

    assert _cycles(member_id)[0]["status"] == "unpaid", "chưa trả tiền thì chưa đóng dấu"
    assert wallet_of(client, sub["token"])["balance"] == 0

    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-CYC-1"))
    assert wh.status_code == 200 and wh.json().get("success") is True

    o = client.get(
        f"/api/v1/wallet/orders/{order['id']}", headers=bearer(sub["token"])
    ).json()
    assert o["status"] == "paid"
    assert _cycles(member_id)[0]["status"] == "paid"
    assert wallet_of(client, sub["token"])["balance"] == 0, "nạp 100k − phí 100k = 0"
    assert "cycle_fee" in _txn_kinds(client, sub["token"])


def test_qr_order_paid_after_super_admin_confirmed_leaves_money_in_wallet(
    client: TestClient, auth_header: dict
) -> None:
    """Trong lúc chờ chuyển khoản, super-admin lỡ bấm "Xác nhận": tính lại thì không
    còn gì để thu ⇒ tiền QR ở lại ví, KHÔNG thu hai lần."""
    _ws, sub, member_id = _setup_debt(
        client, auth_header, "Race WS", "paycyc5", refund_back=False
    )
    r = _pay(client, sub["token"], member_ids=[member_id])
    assert r.status_code == 402
    order = r.json()["detail"]["order"]

    ok = client.post(
        "/api/v1/added-members/mark-paid",
        json={"member_ids": [member_id], "cycle_ids": [], "paid": True},
        headers=auth_header,
    )
    assert ok.status_code == 200, ok.text

    wh = client.post("/webhook/sepay", json=_webhook_body(order["note"], FEE, "ORD-CYC-2"))
    assert wh.status_code == 200

    assert wallet_of(client, sub["token"])["balance"] == FEE, (
        "kỳ đã được xác nhận trước đó → tiền QR phải nằm lại ví, không bị thu lần hai"
    )
    assert _txn_kinds(client, sub["token"]).count("cycle_fee") == 0


# ── Quyền ────────────────────────────────────────────────────────────────────

def test_pay_rejects_user_without_wallet(client: TestClient, auth_header: dict) -> None:
    """Đại lý chưa bật Ví không có gì để trừ → giữ đường cũ (gửi yêu cầu duyệt)."""
    ws = create_ws(client, auth_header, "NoWallet WS")
    user = create_user(client, auth_header, "nowallet1", ["MEMBER_VIEW", "MEMBER_INVITE"])
    # Tài khoản mới MẶC ĐỊNH bật Ví (users.py) → phải tắt tay mới ra được ca này.
    set_beta(client, auth_header, user["id"], False)
    assign(client, auth_header, ws["id"], user["id"])
    token = login(client, "nowallet1")
    member_id = _invite(client, token, ws["id"], email="nowallet@example.com")
    _blind_refund(member_id)

    r = _pay(client, token, member_ids=[member_id])
    assert r.status_code == 403, r.text
    assert _cycles(member_id)[0]["status"] == "unpaid"


def test_pay_ignores_emails_owned_by_someone_else(
    client: TestClient, auth_header: dict
) -> None:
    """Chỉ trả được email CHÍNH MÌNH add: id lạ là no-op, không trừ đồng nào."""
    _ws, owner, member_id = _setup_debt(client, auth_header, "Owner WS", "paycyc6")
    other = make_beta_sub(client, auth_header, username="paycyc7", balance=FEE)

    r = _pay(client, other["token"], member_ids=[member_id])
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 0, "charged_vnd": 0}
    assert wallet_of(client, other["token"])["balance"] == FEE, "không trừ ví người lạ"
    assert _cycles(member_id)[0]["status"] == "unpaid"


def test_pay_is_idempotent_for_already_paid_cycles(
    client: TestClient, auth_header: dict
) -> None:
    """Bấm hai lần không thu hai lần: kỳ 'paid' bị bỏ qua."""
    _ws, sub, member_id = _setup_debt(client, auth_header, "Twice WS", "paycyc8")
    assert _pay(client, sub["token"], member_ids=[member_id]).status_code == 200
    assert wallet_of(client, sub["token"])["balance"] == 0

    adjust(client, auth_header, sub["id"], FEE, reason="nạp thêm")
    r = _pay(client, sub["token"], member_ids=[member_id])
    assert r.json() == {"count": 0, "charged_vnd": 0}
    assert wallet_of(client, sub["token"])["balance"] == FEE, "không thu lần hai"
