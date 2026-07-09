"""Scheduler tự xoá email hết hạn — kiểm tra ÂN HẠN 1 GIỜ.

Chỉ enqueue REMOVE_MEMBER khi đã quá hạn >= 1 giờ (subscription_end_at <= now - 1h).
Member vừa hết hạn (trong vòng 1 giờ) chưa bị xoá — cho khách thời gian gia hạn.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import _cleanup_expired_subscriptions_once
from app.models import Member, QueueItem


def _ws(client: TestClient, auth_header: dict, name: str) -> dict:
    return client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()


def _invite(client: TestClient, auth_header: dict, ws_id: str, email: str) -> dict:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_cleanup_respects_one_hour_grace(
    client: TestClient, auth_header: dict
) -> None:
    ws = _ws(client, auth_header, "WS cleanup")
    m_recent = _invite(client, auth_header, ws["id"], "recent@example.com")
    m_old = _invite(client, auth_header, ws["id"], "old@example.com")

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        # Vừa hết hạn 30 phút trước → trong ân hạn 1 giờ → GIỮ.
        db.get(Member, uuid.UUID(m_recent["id"])).subscription_end_at = (
            now - timedelta(minutes=30)
        )
        # Hết hạn 2 giờ trước → quá ân hạn → XOÁ.
        db.get(Member, uuid.UUID(m_old["id"])).subscription_end_at = (
            now - timedelta(hours=2)
        )
        db.commit()

    _cleanup_expired_subscriptions_once()

    with SessionLocal() as db:
        removed = {
            qi.payload.get("member_id")
            for qi in db.execute(
                select(QueueItem).where(QueueItem.type == "REMOVE_MEMBER")
            ).scalars()
        }
    assert m_old["id"] in removed, "email quá hạn >1h phải bị enqueue xoá"
    assert m_recent["id"] not in removed, "email mới hết hạn <1h chưa được xoá (ân hạn)"


def test_synced_email_expiry_is_anchor_plus_30(
    client: TestClient, auth_header: dict
) -> None:
    """Email SCRAPE/SYNC lần đầu → mốc neo "Ngày gia hạn" = giờ ghi nhận
    (subscription_purchased_at), hạn = mốc + 30 ngày CHÍNH XÁC tới giây (yêu cầu
    user: hết hạn = gia hạn + 30, KHÔNG còn chốt cuối ngày 23:59:59)."""
    ws = client.post(
        "/api/v1/workspaces",
        json={"name": "WS sync exp", "plan": "business", "seat_total": 25},
        headers=auth_header,
    ).json()
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [{"email": "synced@example.com", "status": "active"}],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code in (200, 201), resp.text

    rows = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    m = next(r for r in rows if r["email"] == "synced@example.com")
    assert m["subscription_purchased_at"] is not None, m
    purchased = datetime.fromisoformat(m["subscription_purchased_at"])
    end = datetime.fromisoformat(m["subscription_end_at"])
    assert end == purchased + timedelta(days=30), (purchased, end)
