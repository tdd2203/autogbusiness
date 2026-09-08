"""Thông báo hệ thống ép đọc — khung ngày của đợt + ghi nhận đã đọc theo tài khoản.

Hai tầng tách bạch:
  - `app/announcement.py` là hàm thuần, test bằng ngày giả (không cần đồng hồ thật).
  - Router chỉ lo ai đọc ngày nào và ai được sửa cấu hình.
"""

from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.announcement import campaign_state, vn_day
from tests.wallet_helpers import bearer, create_user, login


def _state(**kw):
    base = dict(
        enabled=True,
        guide_id="cycle-billing",
        start_day=date(2026, 9, 8),
        days=5,
        lock_seconds=15,
        today=date(2026, 9, 8),
    )
    base.update(kw)
    return campaign_state(**base)


def test_window_covers_start_day_through_last_day() -> None:
    """5 ngày kể từ 8/9 = 8..12/9, hết ngày 13 là thôi."""
    assert _state(today=date(2026, 9, 8)).day_index == 1
    assert _state(today=date(2026, 9, 12)).day_index == 5
    assert _state(today=date(2026, 9, 12)).active is True
    assert _state(today=date(2026, 9, 13)).active is False
    assert _state(today=date(2026, 9, 7)).active is False


def test_campaign_token_changes_with_guide_or_start_day() -> None:
    """Đổi bài hay dời ngày = đợt khác ⇒ ai đọc đợt cũ vẫn phải đọc đợt mới."""
    a = _state().campaign
    assert a == "cycle-billing:2026-09-08"
    assert _state(guide_id="chatgpt-reset-limit").campaign != a
    assert _state(start_day=date(2026, 9, 9)).campaign != a


def test_inactive_without_guide_or_start_day_or_switch_off() -> None:
    assert _state(enabled=False).active is False
    assert _state(guide_id=None).active is False
    assert _state(guide_id="   ").active is False
    assert _state(start_day=None).active is False
    assert _state(start_day=None).campaign is None


def test_values_clamped_to_sane_range() -> None:
    """Gõ nhầm 5000 giây / 900 ngày không được khoá dashboard tới sang năm."""
    assert _state(days=900).days == 60
    assert _state(days=0).days == 1
    assert _state(lock_seconds=5000).lock_seconds == 120
    assert _state(lock_seconds=-3).lock_seconds == 0


def test_default_is_off(client: TestClient, auth_header: dict) -> None:
    """Deploy xong không tự nhiên ép ai đọc gì — phải có người vào bật đợt."""
    r = client.get("/api/v1/announcement", headers=auth_header)
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False
    assert r.json()["guide_id"] is None

    r = client.get("/api/v1/admin/announcement", headers=auth_header)
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is False
    assert r.json()["days"] == 5
    assert r.json()["lock_seconds"] == 15


def test_only_super_admin_touches_settings(client: TestClient, auth_header: dict) -> None:
    create_user(client, auth_header, "annouser", ["MEMBER_VIEW"])
    h = bearer(login(client, "annouser"))
    assert client.get("/api/v1/admin/announcement", headers=h).status_code == 403
    assert (
        client.put(
            "/api/v1/admin/announcement", json={"enabled": True}, headers=h
        ).status_code
        == 403
    )
    # Nhưng endpoint đọc thông báo thì mọi người phải gọi được.
    assert client.get("/api/v1/announcement", headers=h).status_code == 200


def test_enable_without_start_day_runs_from_today(
    client: TestClient, auth_header: dict
) -> None:
    r = client.put(
        "/api/v1/admin/announcement",
        json={"enabled": True, "guide_id": "cycle-billing", "days": 5, "lock_seconds": 15},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    today = vn_day()
    assert body["start_day"] == today.isoformat()
    assert body["end_day"] == (today + timedelta(days=4)).isoformat()
    assert body["active"] is True
    assert body["day_index"] == 1


def test_seen_is_per_account_and_per_day(client: TestClient, auth_header: dict) -> None:
    client.put(
        "/api/v1/admin/announcement",
        json={"enabled": True, "guide_id": "cycle-billing", "days": 5, "lock_seconds": 15},
        headers=auth_header,
    )
    create_user(client, auth_header, "annoseen", ["MEMBER_VIEW"])
    h = bearer(login(client, "annoseen"))

    first = client.get("/api/v1/announcement", headers=h).json()
    assert first["active"] is True
    assert first["guide_id"] == "cycle-billing"
    assert first["lock_seconds"] == 15
    assert first["seen_today"] is False

    assert client.post("/api/v1/announcement/seen", headers=h).status_code == 200
    assert client.get("/api/v1/announcement", headers=h).json()["seen_today"] is True
    # Gọi lại vô hại: khoá duy nhất user+đợt+ngày, đụng thì bỏ qua.
    assert client.post("/api/v1/announcement/seen", headers=h).status_code == 200

    # Người khác chưa đọc thì vẫn phải đọc — trạng thái theo TÀI KHOẢN.
    other = client.get("/api/v1/announcement", headers=auth_header).json()
    assert other["seen_today"] is False

    admin = client.get("/api/v1/admin/announcement", headers=auth_header).json()
    assert admin["seen_today_count"] == 1
    assert admin["seen_total_count"] == 1


def test_new_campaign_makes_everyone_read_again(
    client: TestClient, auth_header: dict
) -> None:
    today = vn_day()
    client.put(
        "/api/v1/admin/announcement",
        json={
            "enabled": True,
            "guide_id": "cycle-billing",
            "start_day": today.isoformat(),
            "days": 5,
        },
        headers=auth_header,
    )
    create_user(client, auth_header, "annoagain", ["MEMBER_VIEW"])
    h = bearer(login(client, "annoagain"))
    client.post("/api/v1/announcement/seen", headers=h)
    assert client.get("/api/v1/announcement", headers=h).json()["seen_today"] is True

    # Đổi sang bài khác = đợt khác.
    client.put(
        "/api/v1/admin/announcement",
        json={
            "enabled": True,
            "guide_id": "chatgpt-reset-limit",
            "start_day": today.isoformat(),
            "days": 5,
        },
        headers=auth_header,
    )
    again = client.get("/api/v1/announcement", headers=h).json()
    assert again["guide_id"] == "chatgpt-reset-limit"
    assert again["seen_today"] is False


def test_seen_does_nothing_when_campaign_off(
    client: TestClient, auth_header: dict
) -> None:
    """Đợt tắt mà web lỡ gọi thì không ghi dòng nào, cũng không lỗi."""
    r = client.post("/api/v1/announcement/seen", headers=auth_header)
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False
    assert r.json()["seen_today"] is False
    admin = client.get("/api/v1/admin/announcement", headers=auth_header).json()
    assert admin["seen_total_count"] == 0


def test_past_campaign_stops_by_itself(client: TestClient, auth_header: dict) -> None:
    """Hết 5 ngày là tự thôi, không cần ai vào tắt."""
    start = vn_day() - timedelta(days=9)
    r = client.put(
        "/api/v1/admin/announcement",
        json={
            "enabled": True,
            "guide_id": "cycle-billing",
            "start_day": start.isoformat(),
            "days": 5,
        },
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False
    assert r.json()["day_index"] is None
    assert client.get("/api/v1/announcement", headers=auth_header).json()["active"] is False
