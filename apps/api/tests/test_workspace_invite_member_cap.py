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
CAP_MSG = "Tạm ngưng add, liên hệ admin để biết thêm chi tiết."


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _set_cap(client: TestClient, auth_header: dict, ws_id: str, cap: int | None):
    r = client.patch(
        f"/api/v1/workspaces/{ws_id}",
        json={"invite_member_cap": cap},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    return r.json()


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
    assert blocked.json()["detail"] == CAP_MSG
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
    assert r.json()["detail"] == CAP_MSG
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
    assert stopped.json()["detail"] == CAP_MSG

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
    assert r.json()["detail"] == CAP_MSG


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
