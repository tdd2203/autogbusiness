"""Báo cáo trong ngày ở trang Ví: email đã thêm + giao dịch (GET /wallet/daily-summary).

Chốt 6 điều: (1) đếm đúng email user tự thêm hôm nay + tiền phí, (2) email của
người khác / ngày khác KHÔNG lọt, (3) email đã rời team tách riêng, (4) lượt trả
qua hoá đơn tính vào "đã tiêu" chứ không bị triệt tiêu bởi bút toán order_topup,
(5) lượt mời HỎNG đã hoàn phí KHÔNG tính vào "đã tiêu" (`fee_net`), (6) lượt hỏng
trả qua hoá đơn thì tiền hoá đơn ở lại ví chứ không phải "đã tiêu qua hoá đơn".
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import assign, bearer, create_ws, make_beta_sub, set_settings

FEE = 100_000
VN_TZ = timezone(timedelta(hours=7))


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _summary(client: TestClient, token: str, date: str | None = None) -> dict:
    url = "/api/v1/wallet/daily-summary" + (f"?date={date}" if date else "")
    r = client.get(url, headers=bearer(token))
    assert r.status_code == 200, r.text
    return r.json()


def _bulk_invite(client: TestClient, token: str, ws_id: str, emails: list[str]) -> dict:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()


def test_counts_today_emails_and_fees(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Daily WS")
    sub = make_beta_sub(client, auth_header, username="daily1", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])
    _bulk_invite(client, sub["token"], ws["id"], ["d1@example.com", "d2@example.com", "d3@example.com"])

    s = _summary(client, sub["token"])
    assert s["date"] == datetime.now(VN_TZ).date().isoformat()
    assert s["emails_added"] == 3
    assert s["emails_removed"] == 0
    # 3 email dán trong MỘT lần bấm mời vẫn là 3 LỜI MỜI (đơn vị đếm là email).
    assert s["invite_count"] == 3
    assert s["fee_total"] == 3 * FEE
    # Ví đủ tiền → trừ thẳng số dư, không qua hoá đơn.
    assert s["fee_from_balance"] == 3 * FEE
    assert s["fee_from_invoice"] == 0
    # 1 lần nạp tay (adjust) + 3 phí mời.
    assert s["txn_count"] == 4
    kinds = {k["kind"]: k for k in s["by_kind"]}
    assert kinds["invite_fee"]["count"] == 3
    assert kinds["invite_fee"]["amount"] == -3 * FEE
    assert kinds["adjust"]["amount"] == 300_000


def test_other_user_and_other_day_excluded(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Daily WS 2")
    sub = make_beta_sub(client, auth_header, username="daily2", balance=200_000)
    other = make_beta_sub(client, auth_header, username="daily3", balance=0)
    assign(client, auth_header, ws["id"], sub["id"])
    _bulk_invite(client, sub["token"], ws["id"], ["x1@example.com", "x2@example.com"])

    # Người khác không thấy số của sub.
    mine_of_other = _summary(client, other["token"])
    assert mine_of_other["emails_added"] == 0
    assert mine_of_other["txn_count"] == 0

    # Hôm qua rỗng dù hôm nay có dữ liệu.
    yesterday = (datetime.now(VN_TZ).date() - timedelta(days=1)).isoformat()
    past = _summary(client, sub["token"], yesterday)
    assert past["date"] == yesterday
    assert past["emails_added"] == 0
    assert past["fee_total"] == 0
    assert past["txn_count"] == 0


def test_removed_email_counted_separately(client: TestClient, auth_header: dict) -> None:
    from app.db import SessionLocal
    from app.models import Member

    ws = create_ws(client, auth_header, "Daily WS 3")
    sub = make_beta_sub(client, auth_header, username="daily4", balance=200_000)
    assign(client, auth_header, ws["id"], sub["id"])
    _bulk_invite(client, sub["token"], ws["id"], ["rm1@example.com", "rm2@example.com"])

    with SessionLocal() as db:
        member = (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws["id"]), Member.email == "rm1@example.com")
            .one()
        )
        member.status = "removed"
        member.removed_at = datetime.now(timezone.utc)
        db.commit()

    s = _summary(client, sub["token"])
    assert s["emails_added"] == 1
    assert s["emails_removed"] == 1
    # Phí vẫn ghi nhận đủ 2 lượt — tiền đã tiêu không biến mất khi email bị gỡ.
    assert s["fee_total"] == 2 * FEE


def test_invoice_paid_fee_not_cancelled_out(client: TestClient, auth_header: dict) -> None:
    """Trả qua hoá đơn ghi order_topup +X rồi invite_fee −X cùng lúc: "đã tiêu" phải
    là X (tách sang cột hoá đơn), không phải 0."""
    from app.db import SessionLocal
    from app.models import User, WalletTransaction
    from app.services import wallet_service

    sub = make_beta_sub(client, auth_header, username="daily5", balance=0)
    with SessionLocal() as db:
        user = db.get(User, uuid.UUID(sub["id"]))
        wallet = wallet_service.get_or_create_wallet(db, user.id)
        for kind, amount in (("order_topup", FEE), ("invite_fee", -FEE)):
            db.add(
                WalletTransaction(
                    wallet_id=wallet.id,
                    user_id=user.id,
                    kind=kind,
                    amount=amount,
                    balance_after=0 if kind == "invite_fee" else FEE,
                    held_after=0,
                    ref_type="order",
                )
            )
        db.commit()

    s = _summary(client, sub["token"])
    assert s["fee_total"] == FEE
    assert s["fee_from_invoice"] == FEE
    assert s["fee_from_balance"] == 0
    assert s["topup_total"] == 0  # nạp chuyển khoản thật = 0
    assert s["txn_count"] == 2


def test_failed_invite_refund_not_counted_as_spent(
    client: TestClient, auth_header: dict
) -> None:
    """Mời 2 email, 1 lượt hỏng được hoàn phí → "đã tiêu" chỉ còn 1 lượt.

    Trước 26/8/2026 `fee_total` cộng cả lượt hỏng rồi để tiền hoàn nằm ở ô "nạp vào
    ví" — user phải tự trừ nhẩm mới ra số thật ("khó nhìn khó hiểu"). Giờ `fee_net`
    là số chính, phần hỏng kể riêng ở `fee_refunded` / `refunded_invite_count`.
    """
    ws = create_ws(client, auth_header, "Daily WS 4")
    sub = make_beta_sub(client, auth_header, username="daily6", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    _bulk_invite(client, sub["token"], ws["id"], ["ok@example.com"])
    bad = _bulk_invite(client, sub["token"], ws["id"], ["bad@example.com"])

    upd = client.patch(
        f"/api/v1/queue/{bad['queue_item_id']}",
        json={"status": "FAILED", "error_code": "FAILED_UI_CHANGED", "error_message": "hỏng"},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text

    s = _summary(client, sub["token"])
    assert s["fee_total"] == 2 * FEE  # tổng phí phát sinh vẫn đủ 2 lượt
    assert s["fee_refunded"] == FEE
    assert s["fee_net"] == FEE  # THỰC CHI: chỉ lượt mời sống
    assert s["fee_from_balance"] == FEE
    assert s["fee_from_invoice"] == 0
    assert s["invite_count"] == 2
    assert s["refunded_invite_count"] == 1
    assert s["refund_total"] == FEE
    # 1 adjust + 2 phí + 1 hoàn.
    assert s["txn_count"] == 4


def test_failed_invoice_paid_invite_leaves_money_in_wallet(
    client: TestClient, auth_header: dict
) -> None:
    """Lượt trả qua hoá đơn mà hỏng: tiền hoá đơn Ở LẠI ví ⇒ "đã tiêu" = 0.

    Ghép order_topup ↔ phí theo TỪNG MỐC created_at (không so tổng cả ngày) nên phí
    đã hoàn không kéo theo tiền hoá đơn vào cột "đã tiêu qua hoá đơn".
    """
    from app.db import SessionLocal
    from app.models import User, WalletTransaction
    from app.services import wallet_service

    sub = make_beta_sub(client, auth_header, username="daily7", balance=0)
    with SessionLocal() as db:
        user = db.get(User, uuid.UUID(sub["id"]))
        wallet = wallet_service.get_or_create_wallet(db, user.id)
        rows = [
            ("order_topup", FEE, FEE, False),
            ("invite_fee", -FEE, 0, True),  # reversed = đã hoàn
            ("invite_refund", FEE, FEE, False),
        ]
        for kind, amount, balance_after, was_reversed in rows:
            db.add(
                WalletTransaction(
                    wallet_id=wallet.id,
                    user_id=user.id,
                    kind=kind,
                    amount=amount,
                    balance_after=balance_after,
                    held_after=0,
                    ref_type="order" if kind == "order_topup" else "invite",
                    reversed=was_reversed,
                )
            )
        db.commit()

    s = _summary(client, sub["token"])
    assert s["fee_total"] == FEE
    assert s["fee_refunded"] == FEE
    assert s["fee_net"] == 0
    assert s["fee_from_invoice"] == 0  # tiền hoá đơn nằm lại trong ví, chưa tiêu
    assert s["fee_from_balance"] == 0
    assert s["refunded_invite_count"] == 1
    assert s["refund_total"] == FEE


def test_paid_invite_counts_ignore_free_reinvite(
    client: TestClient, auth_header: dict
) -> None:
    """Thẻ "Mời" đếm LỜI MỜI TÍNH PHÍ, không đếm mời lại email còn hạn (miễn phí).

    Mời lại email còn hạn vẫn đẩy `last_invited_at` sang ngày mới nên `emails_added`
    tính nó như email thêm trong ngày — user 2026-08-27 thấy thẻ ghi "2 / 1" trong
    ngày chỉ có đúng 1 email bị trừ tiền. `invite_count` đọc thẳng sổ ví nên không
    dính lượt miễn phí.
    """
    ws = create_ws(client, auth_header, "Daily WS 5")
    sub = make_beta_sub(client, auth_header, username="daily8", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    _bulk_invite(client, sub["token"], ws["id"], ["paid1@example.com", "paid2@example.com"])
    # Mời LẠI email vừa mời (gói còn hạn) → không sinh bút toán phí nào.
    _bulk_invite(client, sub["token"], ws["id"], ["paid1@example.com"])

    s = _summary(client, sub["token"])
    assert s["emails_added"] == 2
    assert s["invite_count"] == 2  # chỉ 2 email bị tính phí
    assert s["fee_total"] == 2 * FEE


def test_invite_success_is_total_minus_refunded(client: TestClient, auth_header: dict) -> None:
    """Cặp số của thẻ "Mời" = (tổng − đã hoàn) / tổng, gộp mọi lần bấm trong ngày."""
    ws = create_ws(client, auth_header, "Daily WS 6")
    sub = make_beta_sub(client, auth_header, username="daily9", balance=500_000)
    assign(client, auth_header, ws["id"], sub["id"])

    _bulk_invite(client, sub["token"], ws["id"], ["b1@example.com", "b2@example.com"])
    bad = _bulk_invite(client, sub["token"], ws["id"], ["b3@example.com"])
    upd = client.patch(
        f"/api/v1/queue/{bad['queue_item_id']}",
        json={"status": "FAILED", "error_code": "FAILED_UI_CHANGED", "error_message": "hỏng"},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text

    s = _summary(client, sub["token"])
    assert s["invite_count"] == 3  # tổng lời mời tính phí
    assert s["refunded_invite_count"] == 1  # 1 lời mời hỏng, đã hoàn
    assert s["invite_count"] - s["refunded_invite_count"] == 2  # thẻ hiện "2 / 3"


def _craft_txns(sub: dict, rows: list[tuple]) -> None:
    """Ghi thẳng bút toán vào sổ ví theo đúng thứ tự truyền vào (seq tăng dần).

    Mỗi phần tử: (kind, email, reversed, created_at). Dùng cho các ca New/Renew cần
    một lượt trả tiền từ NGÀY TRƯỚC — luồng mời thật không tạo được mốc quá khứ.
    """
    from app.db import SessionLocal
    from app.models import User, WalletTransaction
    from app.services import wallet_service

    with SessionLocal() as db:
        user = db.get(User, uuid.UUID(sub["id"]))
        wallet = wallet_service.get_or_create_wallet(db, user.id)
        for kind, email, was_reversed, created_at in rows:
            txn = WalletTransaction(
                wallet_id=wallet.id,
                user_id=user.id,
                kind=kind,
                amount=FEE if kind == "invite_refund" else -FEE,
                balance_after=0,
                held_after=0,
                ref_type="renew" if kind == "renew_fee" else "invite",
                meta={"email": email, "fee": FEE},
                reversed=was_reversed,
            )
            if created_at is not None:
                txn.created_at = created_at
            db.add(txn)
            db.flush()  # seq cấp theo thứ tự chèn
        db.commit()


def test_new_counts_only_first_paid_email(client: TestClient, auth_header: dict) -> None:
    """New = email chưa từng trả tiền lần nào; email cũ trả tiếp là Renew.

    Phân loại theo LOẠI bút toán thì email hết hạn add lại cũng đi qua `invite_fee`
    nên bị đếm thành email mới toanh (user 2026-08-28). Mốc đúng là sổ ví: đã có
    lượt thu phí thành công trước đó ⇒ Renew.
    """
    sub = make_beta_sub(client, auth_header, username="daily10", balance=0)
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)
    _craft_txns(
        sub,
        [
            ("invite_fee", "old@example.com", False, yesterday),
            # Hôm nay: email cũ add lại, email mới toanh, và một lượt gia hạn.
            ("invite_fee", "old@example.com", False, None),
            ("invite_fee", "fresh@example.com", False, None),
            ("renew_fee", "member@example.com", False, None),
        ],
    )

    s = _summary(client, sub["token"])
    assert s["new_email_count"] == 1  # chỉ fresh@
    assert s["renew_email_count"] == 2  # old@ add lại + member@ gia hạn
    assert s["invite_count"] == 2  # ô "Mời" vẫn đếm cả hai lượt invite_fee


def test_refunded_attempt_does_not_make_email_old(
    client: TestClient, auth_header: dict
) -> None:
    """Mời hỏng đã hoàn phí thì email đó chưa từng vào team ⇒ mời lại vẫn là New."""
    sub = make_beta_sub(client, auth_header, username="daily11", balance=0)
    _craft_txns(
        sub,
        [
            ("invite_fee", "retry@example.com", True, None),  # hỏng, đã hoàn
            ("invite_refund", "retry@example.com", False, None),
            ("invite_fee", "retry@example.com", False, None),  # mời lại, ăn tiền
        ],
    )

    s = _summary(client, sub["token"])
    assert s["new_email_count"] == 1
    assert s["renew_email_count"] == 0
    assert s["refunded_invite_count"] == 1


def test_fresh_invite_flow_counts_as_new(client: TestClient, auth_header: dict) -> None:
    """Luồng mời thật: 2 email chưa từng có trong sổ ⇒ New 2, Renew 0."""
    ws = create_ws(client, auth_header, "Daily WS 7")
    sub = make_beta_sub(client, auth_header, username="daily12", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])
    _bulk_invite(client, sub["token"], ws["id"], ["n1@example.com", "n2@example.com"])

    s = _summary(client, sub["token"])
    assert s["new_email_count"] == 2
    assert s["renew_email_count"] == 0
