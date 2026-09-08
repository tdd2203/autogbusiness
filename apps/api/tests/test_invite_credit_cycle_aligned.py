"""MỜI HỎNG Ở CHẾ ĐỘ `cycle_aligned` ⇒ GIỮ TIỀN với email, không hoàn về ví.

Luật gốc 28/8/2026 chỉ giữ tiền khi mời hỏng vì HẾT SUẤT (`test_invite_seat_credit.py`).
Từ 7/9/2026 workspace đã gạt sang `cycle_aligned` giữ tiền với MỌI lý do hỏng.

VÌ SAO CHỈ ÁP CHO `cycle_aligned`: vấn đề sinh ra từ giá tính theo NGÀY. Mỗi ngày một
con số khác nhau (219.000, 213.000, 102.000…) nên tiền hoàn về ví gần như không bao giờ
khớp giá của lượt mời kế tiếp — đại lý phải nạp thêm mấy chục nghìn lẻ mới mời lại được
đúng email vừa hỏng. Workspace còn ở `legacy_30d` có giá cố định theo tháng, hoàn phí về
ví khớp đúng giá lượt sau, nên KHÔNG đổi gì: `test_wallet_refund.py` và
`test_invite_submitted_defer.py` vẫn khoá hành vi hoàn phí cũ.

Rào theo `billing_mode` chứ không phải một cờ riêng: cầu dao đã có sẵn từ migration
0067, và sửa ở đúng chỗ gây ra vấn đề thì không sinh thêm khái niệm nào.

BẤT BIẾN: giữ tiền ⇔ giữ được PHIẾU gắn với email (bản ghi còn `pending`, chưa từng vào
nhóm, hạn còn ở tương lai). Không có phiếu thì phải hoàn, bằng không tiền giữ lại thành
tiền nuốt không — xem `test_invite_seat_credit.py`.
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


def _switch_to_cycle_aligned(ws_id: str) -> None:
    """Gạt workspace sang chế độ neo-theo-chu-kỳ (cầu dao của migration 0067)."""
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        ws = db.get(Workspace, uuid.UUID(ws_id))
        ws.billing_mode = "cycle_aligned"
        ws.cycle_anchor_day = 25
        db.commit()


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
            "credit": m.invite_credit_vnd,
            "credit_at": m.invite_credit_at,
        }


def _invite(client: TestClient, ws: dict, token: str, email: str) -> dict:
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": [email], "role": "member"},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()


def _fail_task(client: TestClient, ws: dict, item_id: str, error_code: str) -> None:
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": error_code,
            "error_message": f"test {error_code}",
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def _setup(client: TestClient, auth_header: dict, name: str, user: str, *, aligned: bool):
    ws = create_ws(client, auth_header, name)
    sub = make_beta_sub(client, auth_header, username=user, balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    if aligned:
        _switch_to_cycle_aligned(ws["id"])
    return ws, sub


# ── Luật mới, chỉ ở workspace đã gạt chế độ ─────────────────────────────────


@pytest.mark.parametrize(
    "error_code", ["UI_ELEMENT_NOT_FOUND", "NOT_LOGGED_IN_CHATGPT", "TIMEOUT"]
)
def test_cycle_aligned_giu_tien_voi_moi_ly_do_hong(
    client: TestClient, auth_header: dict, error_code: str
) -> None:
    """Không riêng hết suất — lý do nào cũng giữ tiền, vì giá đã tính theo ngày."""
    email = f"ca-{error_code.lower()}@example.com"
    ws, sub = _setup(
        client, auth_header, f"CA {error_code}", f"ca{abs(hash(error_code)) % 10**5}",
        aligned=True,
    )

    item_id = _invite(client, ws, sub["token"], email)["queue_item_id"]
    # Giá ở chế độ này tính THEO NGÀY nên phí phụ thuộc hôm nay là ngày thứ mấy của
    # chu kỳ — đo phí thật chứ đừng đoán bằng FEE, kẻo test đổi màu theo ngày chạy.
    con_lai = wallet_of(client, sub["token"])["balance"]
    da_thu = FEE - con_lai
    assert 0 < da_thu <= FEE, "phải thu phần lẻ tới mốc chốt, không thu quá một tháng"
    end_before = _member_row(ws["id"], email)["end_at"]
    assert end_before is not None

    _fail_task(client, ws, item_id, error_code)

    assert wallet_of(client, sub["token"])["balance"] == con_lai, (
        "tiền ở lại với email — hoàn về ví là bắt đại lý nạp lẻ mới mời lại được"
    )
    row = _member_row(ws["id"], email)
    assert row is not None, "xoá bản ghi = mất phiếu ⇒ lượt mời lại bị tính phí lần nữa"
    assert row["status"] == "removed"
    assert row["removed_reason"] == "invite_seat_credit"
    assert row["end_at"] == end_before, "hạn đã trả không được cắt"
    assert row["credit"] == da_thu, (
        "khoản giữ phải bằng ĐÚNG số đã thu — không có nó thì tiền đã thu mà chưa "
        "giao dịch vụ lẫn vào doanh thu, đối soát không ai biết đang nợ bao nhiêu lượt"
    )
    assert row["credit_at"] is not None

    # Mời lại: ví đang 0đ mà lệnh vẫn đi ⇒ đúng là miễn phí, và hạn giữ nguyên.
    _invite(client, ws, sub["token"], email)
    assert wallet_of(client, sub["token"])["balance"] == con_lai, "mời lại không trừ thêm"
    again = _member_row(ws["id"], email)
    assert again["status"] == "pending"
    assert again["end_at"] == end_before, "mời lại chỉ tiếp tục kỳ đã trả"


def test_legacy_van_hoan_phi_nhu_cu(client: TestClient, auth_header: dict) -> None:
    """Chốt chặn cầu dao: workspace CHƯA gạt chế độ thì không thấy gì đổi.

    Giá cố định theo tháng nên tiền hoàn về ví khớp đúng giá lượt sau — không có lý
    do gì đổi, và đổi là 9 đại lý đang chạy thật bị đổi luật tiền cùng lúc.
    """
    email = "legacyfail@example.com"
    ws, sub = _setup(client, auth_header, "Legacy WS", "legacyfail", aligned=False)

    item_id = _invite(client, ws, sub["token"], email)["queue_item_id"]
    _fail_task(client, ws, item_id, "UI_ELEMENT_NOT_FOUND")

    assert wallet_of(client, sub["token"])["balance"] == FEE, "legacy vẫn hoàn về ví"
    row = _member_row(ws["id"], email)
    assert row is None or not row["credit"], "legacy không ghi khoản giữ nào"


def test_het_suat_van_giu_tien_o_ca_hai_che_do(
    client: TestClient, auth_header: dict
) -> None:
    """Luật gốc 28/8 (hết suất ⇒ giữ tiền) KHÔNG bị cái rào mới cắt mất."""
    email = "seatlegacy@example.com"
    ws, sub = _setup(client, auth_header, "Legacy Seat WS", "seatlegacy", aligned=False)

    item_id = _invite(client, ws, sub["token"], email)["queue_item_id"]
    _fail_task(client, ws, item_id, "NOT_ENOUGH_SEATS")

    assert wallet_of(client, sub["token"])["balance"] == 0, "hết suất thì vẫn giữ tiền"
    assert _member_row(ws["id"], email)["removed_reason"] == "invite_seat_credit"


def test_vao_nhom_that_thi_thoi_treo_khoan_giu(
    client: TestClient, auth_header: dict
) -> None:
    """Email vào nhóm ⇒ khoản đang giữ đã đổi được lấy dịch vụ, phải hết treo.

    Không xoá thì con số "đang giữ" cứ phình mãi và báo cáo đối soát thành vô nghĩa.
    """
    email = "settled@example.com"
    ws, sub = _setup(client, auth_header, "Settle WS", "settleuser", aligned=True)

    item_id = _invite(client, ws, sub["token"], email)["queue_item_id"]
    da_thu = FEE - wallet_of(client, sub["token"])["balance"]
    _fail_task(client, ws, item_id, "TIMEOUT")
    assert _member_row(ws["id"], email)["credit"] == da_thu

    # Mời lại (miễn phí) rồi báo verify thành công → email vào nhóm thật.
    again = _invite(client, ws, sub["token"], email)
    r = client.patch(
        f"/api/v1/queue/{again['queue_item_id']}",
        json={
            "status": "COMPLETED",
            "result": {"verified_emails": [email], "verify_scrape_failed": False},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text

    row = _member_row(ws["id"], email)
    assert not row["credit"], "vào nhóm rồi thì thôi treo khoản giữ"
    assert row["credit_at"] is None
