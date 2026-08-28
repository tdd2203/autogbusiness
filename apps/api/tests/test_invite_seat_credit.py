"""Mời hỏng vì HẾT SUẤT ⇒ GIỮ TIỀN, mời lại email đó MIỄN PHÍ.

Luật tiền do user chốt 28/8/2026: *"mời mà còn seat thì hoàn tiền, mời mà phải mua
seat thì add lại miễn phí đối với email đó"*.

Vì sao không hoàn tiền cho ca này: hoàn về VÍ thì khoản đó lập tức bị lượt mời sau
tiêu mất, nên người dùng vẫn phải nạp lại đúng số tiền để mời lại chính email vừa
hỏng. Chiều 28/8/2026 workspace GPT1 đi đúng vòng đó 5 lần liền (`tranbanien123`,
`ngocvu14.3.2001`, `lphg2509`): trừ → hoàn → trừ → hoàn, không ai được thêm vào đội,
ví về 0 và người dùng vẫn phải chuyển khoản tiếp.

BẤT BIẾN của file này: **giữ tiền ⇔ giữ được phiếu gắn với email**. Phiếu = bản ghi
`removed` còn `subscription_end_at` ở tương lai — thứ khiến luật "mời lại còn hạn thì
miễn phí" (14/7/2026) tự cho qua. Không dựng được phiếu thì phải hoàn tiền, bằng
không tiền giữ lại thành tiền nuốt không.
"""

import uuid
from datetime import datetime, timezone

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


def _member_row(ws_id: str, email: str):
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
            "removed_reason": m.removed_reason,
            "end_at": m.subscription_end_at,
        }


def _fail_task(client: TestClient, ws: dict, item_id: str, error_code: str) -> None:
    upd = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": error_code,
            "error_message": f"test {error_code}",
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text


def _invite(client: TestClient, ws: dict, token: str, email: str) -> dict:
    body = {"emails": [email], "role": "member"}
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json=body,
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()


def test_het_suat_thi_giu_tien_va_moi_lai_mien_phi(
    client: TestClient, auth_header: dict
) -> None:
    """NOT_ENOUGH_SEATS: không hoàn tiền, giữ phiếu, lần mời sau KHÔNG trừ đồng nào."""
    email = "seatcredit@example.com"
    ws = create_ws(client, auth_header, "Seat Credit WS")
    sub = make_beta_sub(client, auth_header, username="seatcredit", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, ws, sub["token"], email)["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == 0, "mời phải trừ phí"
    end_before = _member_row(ws["id"], email)["end_at"]
    assert end_before is not None

    _fail_task(client, ws, item_id, "NOT_ENOUGH_SEATS")

    # ── Bất biến 1: KHÔNG hoàn tiền ───────────────────────────────────────
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "hết suất thì tiền ở lại với email, không quay về ví"
    )

    # ── Bất biến 2: phiếu còn nguyên (bản ghi không bị xoá, hạn giữ nguyên) ─
    row = _member_row(ws["id"], email)
    assert row is not None, "xoá bản ghi = tiền đã trừ biến mất không dấu vết"
    assert row["status"] == "removed"
    assert row["removed_reason"] == "invite_seat_credit"
    assert row["end_at"] == end_before, "hạn đã trả không được cắt"

    # ── Bất biến 3: mời lại email đó MIỄN PHÍ, giữ nguyên hạn ─────────────
    _invite(client, ws, sub["token"], email)
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "ví đang 0đ mà mời lại vẫn đi được ⇒ đúng là miễn phí"
    )
    again = _member_row(ws["id"], email)
    assert again["status"] == "pending"
    assert again["end_at"] == end_before, "mời lại chỉ tiếp tục kỳ đã trả"


def test_loi_khac_van_hoan_tien_nhu_cu(client: TestClient, auth_header: dict) -> None:
    """Chỉ NOT_ENOUGH_SEATS mới giữ tiền — lỗi khác vẫn hoàn như trước."""
    email = "normalfail@example.com"
    ws = create_ws(client, auth_header, "Seat Credit WS 2")
    sub = make_beta_sub(client, auth_header, username="normalfail", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _invite(client, ws, sub["token"], email)["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == 0

    _fail_task(client, ws, item_id, "UI_ELEMENT_NOT_FOUND")

    assert wallet_of(client, sub["token"])["balance"] == FEE, "phải hoàn phí như cũ"
    row = _member_row(ws["id"], email)
    if row is not None:
        # Hoàn tiền ⇒ không được còn hạn (bất biến của test_refund_voids_period).
        assert row["end_at"] is None or row["end_at"] <= datetime.now(timezone.utc)


def test_moi_vo_thoi_han_khong_dung_phieu_duoc_thi_phai_hoan_tien(
    client: TestClient, auth_header: dict
) -> None:
    """Mời KHÔNG đặt hạn: phí vẫn thu 1 tháng nhưng `subscription_end_at` NULL.

    Không có mốc hạn thì không có phiếu nào để mời lại miễn phí — giữ tiền lúc này
    là nuốt tiền. Ca này PHẢI rơi về đường hoàn tiền cũ.
    """
    email = "noexpiry@example.com"
    ws = create_ws(client, auth_header, "Seat Credit WS 3")
    sub = make_beta_sub(client, auth_header, username="noexpiry", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={
            "invites": [{"email": email, "subscription_months": None}],
            "role": "member",
        },
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 202, r.text
    item_id = r.json()["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert _member_row(ws["id"], email)["end_at"] is None, (
        "test này chỉ có nghĩa khi mời vô thời hạn thật sự không sinh mốc hạn"
    )

    _fail_task(client, ws, item_id, "NOT_ENOUGH_SEATS")

    assert wallet_of(client, sub["token"])["balance"] == FEE, (
        "không dựng được phiếu ⇒ bắt buộc hoàn tiền, không được giữ"
    )


def test_khoan_phi_treo_cua_lan_moi_truoc_cung_o_lai_voi_email(
    client: TestClient, auth_header: dict
) -> None:
    """Ca thật 22/8/2026, đọc lại theo luật mới.

    Task A trả tiền rồi hỏng-nhưng-đã-bấm-Gửi ⇒ hoãn phán xử (phí giữ nguyên). Admin
    "Mời lại" ⇒ task B miễn phí, hỏng vì HẾT SUẤT. Luật cũ hoàn khoản treo của task A
    về ví; luật mới giữ nó lại cùng email — nhưng BẮT BUỘC phải để lại phiếu dùng
    được, bằng không lại đúng thất thoát 22/8 (thu tiền, khách không có ghế).

    Đường hoàn phí mồ côi vẫn còn nguyên cho các mã lỗi khác — xem
    `test_stranded_fee_after_failed_reinvite.py`.
    """
    email = "strandedseat@example.com"
    ws = create_ws(client, auth_header, "Seat Credit WS 4")
    sub = make_beta_sub(client, auth_header, username="strandedseat", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    key = {"X-API-KEY": ws["extension_api_key"]}

    item_a = _invite(client, ws, sub["token"], email)["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == 0
    end_before = _member_row(ws["id"], email)["end_at"]

    # Task A: đã bấm Gửi nhưng không xác minh được → hoãn phán xử, phí giữ nguyên.
    r = client.patch(
        f"/api/v1/queue/{item_a}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": "đã submit, chưa xác minh được",
            "result": {"submit_clicked": True},
        },
        headers=key,
    )
    assert r.status_code == 200, r.text
    assert wallet_of(client, sub["token"])["balance"] == 0

    # Task B: mời lại (miễn phí vì còn hạn) rồi hỏng vì hết suất.
    item_b = _invite(client, ws, sub["token"], email)["queue_item_id"]
    assert item_b != item_a
    _fail_task(client, ws, item_b, "NOT_ENOUGH_SEATS")

    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "hết suất ⇒ khoản treo ở lại với email, không quay về ví"
    )
    row = _member_row(ws["id"], email)
    assert row is not None and row["end_at"] == end_before, (
        "THẤT THOÁT kiểu 22/8: giữ tiền mà xoá mất phiếu thì khách không còn đường "
        "nào lấy lại chỗ đã trả"
    )

    # Và phiếu đó phải dùng được thật.
    _invite(client, ws, sub["token"], email)
    assert wallet_of(client, sub["token"])["balance"] == 0
    assert _member_row(ws["id"], email)["status"] == "pending"
