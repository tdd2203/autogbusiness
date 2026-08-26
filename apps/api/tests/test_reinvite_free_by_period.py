"""MIỄN PHÍ THEO GÓI CÒN HẠN, KHÔNG THEO CỬA VÀO (user 2026-08-26).

Ca thật 26/8/2026: `phiastraliz123@…` được mời lúc 12:10:47 (trừ 330.000đ, gói 1
tháng) rồi lệnh mời rơi vào timeout hiển thị "Thất bại" — dù lời mời đi được thật.
Người dùng gõ lại email vào form mời thường để chắc ăn, và bị trừ phí LẦN HAI cho
đúng cái kỳ vừa trả. Cùng email đó nếu bấm nút "Mời lại" thì 0đ (`khanhlynam0@…`
12:29, `quochuyng1712@…` 12:31 — cả hai đều miễn phí).

Luật cũ: `pending` còn hạn chỉ miễn phí khi `reinvite=True`; mời thường chỉ miễn phí
cho `removed`. Hai cửa vào, hai số tiền, cho cùng một kỳ đã thanh toán.
Luật mới: gói CÒN HẠN (`subscription_end_at` ở tương lai) ⇒ mời lại không mất tiền,
đi cửa nào cũng vậy.

Ranh giới KHÔNG được nới thêm: VÔ THỜI HẠN (`subscription_end_at IS NULL`) vẫn tính
phí như cũ — 'vô hạn' không phải 'còn hạn' (xem `_is_paid_period_active`).
"""

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


def _invite(client: TestClient, token: str, ws_id: str, email: str, **extra):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member", **extra},
        headers=bearer(token),
    )


def _bulk(client: TestClient, token: str, ws_id: str, emails: list[str], **extra):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member", **extra},
        headers=bearer(token),
    )


def _invite_fees(client: TestClient, token: str) -> list[dict]:
    txns = client.get(
        "/api/v1/wallet/transactions", headers=bearer(token)
    ).json()["items"]
    return [t for t in txns if t["kind"] == "invite_fee"]


def _set_period(
    client: TestClient, auth_header: dict, ws_id: str, member_id: str, body: dict
) -> None:
    r = client.patch(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/subscription",
        json=body,
        headers=auth_header,
    )
    assert r.status_code == 200, r.text


def test_moi_lai_email_pending_con_han_qua_form_thuong_thi_mien_phi(
    client: TestClient, auth_header: dict
) -> None:
    """Gõ lại email vào form mời thường (KHÔNG phải nút "Mời lại") — đã trả cho kỳ
    đang chạy thì không được trừ lần hai. Đúng ca `phiastraliz123@…` ngày 26/8."""
    ws = create_ws(client, auth_header, "Reinvite Form WS")
    sub = make_beta_sub(client, auth_header, username="formreinviter", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "keep@example.com", subscription_months=1)
    assert r.status_code == 201, r.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE

    # Member vẫn 'pending' (chưa ai bấm nhận) — mời lại qua form hàng loạt của trang
    # Mời thành viên (endpoint mà form thường dùng cho cả 1 lẫn nhiều email).
    br = _bulk(client, sub["token"], ws["id"], ["keep@example.com"], subscription_months=1)
    assert br.status_code == 202, br.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE, (
        "mời lại email CÒN HẠN qua form thường KHÔNG được trừ phí lần 2"
    )
    assert len(_invite_fees(client, sub["token"])) == 1


def test_het_han_thi_van_tinh_phi_nhu_cu(client: TestClient, auth_header: dict) -> None:
    """Ranh giới: hết hạn ⇒ chu kỳ mới ⇒ tính phí. Luật mới chỉ miễn phí kỳ ĐANG chạy."""
    ws = create_ws(client, auth_header, "Expired WS")
    sub = make_beta_sub(client, auth_header, username="expired", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "old@example.com", subscription_months=1)
    assert r.status_code == 201, r.text
    past = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    _set_period(client, auth_header, ws["id"], r.json()["id"], {"subscription_end_at": past})

    br = _bulk(client, sub["token"], ws["id"], ["old@example.com"], subscription_months=1)
    assert br.status_code == 202, br.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - 2 * FEE
    assert len(_invite_fees(client, sub["token"])) == 2


def test_vo_thoi_han_van_tinh_phi_nhu_cu(client: TestClient, auth_header: dict) -> None:
    """Ranh giới thứ hai: KHÔNG có mốc hết hạn ⇒ không phải "còn hạn" ⇒ vẫn tính phí
    + reset cửa sổ như cũ (xem `_is_paid_period_active`)."""
    ws = create_ws(client, auth_header, "Unlimited WS")
    sub = make_beta_sub(client, auth_header, username="unlimited", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "forever@example.com", subscription_months=1)
    assert r.status_code == 201, r.text
    # Tất cả None = VÔ THỜI HẠN (xoá hạn) — xem MemberUpdateSubscriptionIn.
    _set_period(client, auth_header, ws["id"], r.json()["id"], {})

    br = _bulk(client, sub["token"], ws["id"], ["forever@example.com"], subscription_months=1)
    assert br.status_code == 202, br.text
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - 2 * FEE
    assert len(_invite_fees(client, sub["token"])) == 2
