"""Action "Mời lại" (re-invite) — POST /workspaces/{ws}/members/{id}/re-invite.

Yêu cầu user 2026-07-14: lời mời thỉnh thoảng lỗi → thêm action mời lại. Email CÒN
HẠN → mời lại MIỄN PHÍ (giữ nguyên cửa sổ hạn); HẾT HẠN → tính phí + chu kỳ mới như
mời thường. Cho phép admin + sub-admin (chủ sở hữu). Task vẫn type INVITE_MEMBER +
payload.reinvite=true (extension chạy tiền tố tìm-thu-hồi).
"""

from __future__ import annotations

import uuid as _uuid
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
    """Ghim phí mặc định = 100k + cấu hình ngân hàng (để nhánh QR dựng được mã)."""
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


def _member(client: TestClient, token: str, ws_id: str, member_id: str) -> dict:
    members = client.get(
        f"/api/v1/workspaces/{ws_id}/members?include_removed=true",
        headers=bearer(token),
    ).json()
    return next(m for m in members if m["id"] == member_id)


def _invite_task_with_reinvite(client: TestClient, auth_header: dict) -> dict | None:
    tasks = client.get("/api/v1/queue?limit=50", headers=auth_header).json()
    invites = [t for t in tasks if t["type"] == "INVITE_MEMBER"]
    return next((t for t in invites if (t["payload"] or {}).get("reinvite")), None)


def test_reinvite_still_valid_is_free_and_preserves_window(
    client: TestClient, auth_header: dict
) -> None:
    """Member pending CÒN HẠN → mời lại MIỄN PHÍ: số dư không đổi, giữ nguyên
    subscription_end_at + months, tạo task INVITE_MEMBER có payload.reinvite=true."""
    ws = create_ws(client, auth_header, "Reinvite Valid WS")
    sub = make_beta_sub(client, auth_header, username="rev1", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "valid@example.com", months=3)
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    orig_end = r.json()["subscription_end_at"]
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE * 3

    rr = _reinvite(client, sub["token"], ws["id"], member_id)
    assert rr.status_code == 201, rr.text
    # MIỄN PHÍ: số dư không đổi.
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE * 3
    # Giữ nguyên cửa sổ hạn.
    assert rr.json()["subscription_months"] == 3
    assert rr.json()["subscription_end_at"] == orig_end
    assert rr.json()["status"] == "pending"

    # Task mời-lại có cờ reinvite.
    task = _invite_task_with_reinvite(client, auth_header)
    assert task is not None
    assert task["payload"]["email"] == "valid@example.com"


def test_reinvite_expired_charges_and_resets_window(
    client: TestClient, auth_header: dict
) -> None:
    """Member pending HẾT HẠN → mời lại tính phí + chu kỳ mới (now + months×30)."""
    from app.db import SessionLocal
    from app.models import Member as _Member

    ws = create_ws(client, auth_header, "Reinvite Expired WS")
    sub = make_beta_sub(client, auth_header, username="rev2", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "expired@example.com", months=1)
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE

    # Ép hạn về quá khứ → hết hạn.
    with SessionLocal() as db:
        m = db.get(_Member, _uuid.UUID(member_id))
        m.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=5)
        db.commit()

    before = datetime.now(timezone.utc)
    rr = _reinvite(client, sub["token"], ws["id"], member_id)
    assert rr.status_code == 201, rr.text
    # Tính phí lần nữa (1 tháng).
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE * 2
    new_end = datetime.fromisoformat(rr.json()["subscription_end_at"])
    assert abs((new_end - (before + timedelta(days=30))).total_seconds()) < 5


def test_reinvite_expired_insufficient_creates_qr_order(
    client: TestClient, auth_header: dict
) -> None:
    """Hết hạn + ví thiếu → 402 PAYMENT_QR_REQUIRED, order payload có reinvite=true."""
    from app.db import SessionLocal
    from app.models import Member as _Member

    ws = create_ws(client, auth_header, "Reinvite QR WS")
    sub = make_beta_sub(client, auth_header, username="rev3", balance=FEE)  # đủ đúng 1 lần
    assign(client, auth_header, ws["id"], sub["id"])

    r = _invite(client, sub["token"], ws["id"], "qr@example.com", months=1)
    assert r.status_code == 201, r.text
    member_id = r.json()["id"]
    assert wallet_of(client, sub["token"])["balance"] == 0  # hết sạch

    with SessionLocal() as db:
        m = db.get(_Member, _uuid.UUID(member_id))
        m.subscription_end_at = datetime.now(timezone.utc) - timedelta(days=5)
        db.commit()

    rr = _reinvite(client, sub["token"], ws["id"], member_id)
    assert rr.status_code == 402, rr.text
    detail = rr.json()["detail"]
    assert detail["code"] == "PAYMENT_QR_REQUIRED"
    assert detail["order"]["kind"] == "invite"
    assert detail["order"]["amount_vnd"] == FEE
    # Số dư không đổi (chưa trừ), member vẫn pending.
    assert wallet_of(client, sub["token"])["balance"] == 0
    orders = client.get("/api/v1/wallet/orders", headers=bearer(sub["token"])).json()
    assert any(o["status"] == "pending" and o["amount_vnd"] == FEE for o in orders)


def test_reinvite_active_member_returns_409(
    client: TestClient, auth_header: dict
) -> None:
    """Member đang ACTIVE → 409 (không cần mời lại)."""
    ws = create_ws(client, auth_header, "Reinvite Active WS")
    rr = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "act@example.com", "role": "member", "subscription_months": 1},
        headers=auth_header,
    )
    assert rr.status_code == 201, rr.text
    member_id = rr.json()["id"]
    # Promote sang active qua bulk-upsert (như extension sync).
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {
                    "email": "act@example.com",
                    "name": "Act",
                    "chatgpt_role": "member",
                    "status": "active",
                    "joined_at": "2026-05-19T10:00:00+00:00",
                }
            ],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{member_id}/re-invite",
        headers=auth_header,
    )
    assert resp.status_code == 409, resp.text


def test_reinvite_requires_member_invite_permission(
    client: TestClient, auth_header: dict
) -> None:
    """Sub-admin thiếu MEMBER_INVITE → 403."""
    from tests.wallet_helpers import create_user, login

    ws = create_ws(client, auth_header, "Reinvite Perm WS")
    m = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "p@example.com", "role": "member", "subscription_months": 1},
        headers=auth_header,
    ).json()
    create_user(client, auth_header, "noinv", ["MEMBER_VIEW"])
    token = login(client, "noinv")
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{m['id']}/re-invite",
        headers=bearer(token),
    )
    assert resp.status_code == 403, resp.text


def test_reinvite_other_owner_sub_admin_404(
    client: TestClient, auth_header: dict
) -> None:
    """Sub-admin KHÔNG phải chủ sở hữu member → 404 (visibility filter)."""
    from tests.wallet_helpers import create_user, login

    ws = create_ws(client, auth_header, "Reinvite Owner WS")
    m = client.post(  # super-admin mời (super-admin sở hữu)
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "owned@example.com", "role": "member", "subscription_months": 1},
        headers=auth_header,
    ).json()
    other = create_user(client, auth_header, "other", ["MEMBER_VIEW", "MEMBER_INVITE"])
    assign(client, auth_header, ws["id"], other["id"])
    token = login(client, "other")
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{m['id']}/re-invite",
        headers=bearer(token),
    )
    assert resp.status_code == 404, resp.text
