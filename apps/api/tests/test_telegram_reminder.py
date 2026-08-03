"""Nhắc gia hạn qua Telegram (feature 004) — quét, chống trùng, gộp tin, chỉ định.

Nghiệp vụ đầy đủ: docs/Notifications/Renewal_Reminder_Telegram.md.
Trọng tâm kiểm:
  (a) mỗi email chỉ nhắc ĐÚNG 1 lần cho mỗi mốc (dedupe_key) dù job chạy lại;
  (b) nhiều email cùng người nhận ⇒ MỘT tin gộp;
  (c) chỉ định theo email thay thế đại lý, và fallback về đại lý khi chưa khớp được;
  (d) lỗi vĩnh viễn (bị chặn) không retry, lỗi tạm thì có;
  (e) email đã gia hạn trước khi gửi ⇒ bỏ (không gửi thông tin sai).
"""

import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    AuditLog,
    Member,
    TelegramContact,
    TelegramNotification,
    TelegramSettings,
    TelegramSubscription,
    User,
)
from app.services import renewal_reminder, telegram

BOT_TOKEN = "test-token:do-not-use"
WEBHOOK_SECRET = "test-webhook-secret"
OWNER_CHAT = 555001
ASSIGNEE_CHAT = 555002
ADMIN_CHAT = -1009999


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def sent(monkeypatch) -> list[tuple[int, str]]:
    """Bắt mọi lời gọi sendMessage thay vì gọi Telegram thật."""
    captured: list[tuple[int, str]] = []

    def fake_send(chat_id: int, html_text: str) -> telegram.SentMessage:
        captured.append((chat_id, html_text))
        return telegram.SentMessage(chat_id=chat_id, message_id=len(captured))

    monkeypatch.setattr(telegram, "send_message", fake_send)
    return captured


@pytest.fixture(autouse=True)
def _reset_runtime_config():
    """Cấu hình bot được cache trong process → xoá trước/sau MỖI test, nếu không
    test sau ăn phải token/nhóm digest của test trước (DB đã bị truncate)."""
    telegram.refresh_config()
    yield
    telegram.refresh_config()


@pytest.fixture
def bot_on(monkeypatch):
    """Bật bot + secret webhook + tắt group admin (mặc định) cho từng test."""
    settings = get_settings()
    monkeypatch.setattr(settings, "telegram_bot_token", BOT_TOKEN)
    monkeypatch.setattr(settings, "telegram_webhook_secret", WEBHOOK_SECRET)
    monkeypatch.setattr(settings, "telegram_admin_chat_id", "")
    monkeypatch.setattr(settings, "renewal_reminder_days", "3,1")
    telegram.refresh_config()
    return settings


def _webhook(client: TestClient, update: dict, secret: str = WEBHOOK_SECRET):
    """POST update như Telegram thật: luôn kèm header secret đã đăng ký."""
    return client.post(
        "/webhook/telegram",
        json=update,
        headers={"X-Telegram-Bot-Api-Secret-Token": secret},
    )


def _make_ws(client: TestClient, auth_header: dict, name: str = "WS tele") -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": 25},
        headers=auth_header,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def _link_owner(chat_id: int = OWNER_CHAT, username: str = "dai_ly") -> str:
    """Gán chat Telegram cho super-admin (đóng vai đại lý sở hữu email)."""
    with SessionLocal() as db:
        user = db.query(User).filter(User.username == "superadmin").one()
        user.telegram_chat_id = chat_id
        user.telegram_username = username
        user.telegram_linked_at = _now()
        db.commit()
        return str(user.id)


def _add_member(
    client: TestClient,
    ws: dict,
    email: str,
    *,
    days_left: float,
    owner_id: str | None = None,
    **fields,
) -> str:
    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": email, "status": "active"}], "is_full_sync": False},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code in (200, 201), resp.text
    with SessionLocal() as db:
        member = db.query(Member).filter(Member.email == email).one()
        member.subscription_end_at = _now() + timedelta(days=days_left)
        member.subscription_months = 1
        member.invited_by_user_id = owner_id
        for key, value in fields.items():
            setattr(member, key, value)
        db.commit()
        return str(member.id)


def _run(force: bool = True) -> dict:
    with SessionLocal() as db:
        return renewal_reminder.run_tick(db, force_scan=force)


def _statuses() -> list[tuple[str, int, str]]:
    with SessionLocal() as db:
        return [
            (n.status, n.days_bucket, n.recipient_kind)
            for n in db.query(TelegramNotification).all()
        ]


# ── Logic thuần (không cần DB) ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("@Khach_VIP", ("@khach_vip", None)),
        ("khach_vip", ("@khach_vip", None)),
        ("https://t.me/khach_vip", ("@khach_vip", None)),
        ("t.me/khach_vip", ("@khach_vip", None)),
        ("123456789", ("123456789", 123456789)),
        ("-1001234567890", ("-1001234567890", -1001234567890)),
        ("", (None, None)),
        (None, (None, None)),
    ],
)
def test_normalize_target(raw, expected) -> None:
    assert renewal_reminder.normalize_target(raw) == expected


@pytest.mark.parametrize("raw", ["abc", "a" * 33, "khach vip", "@@x"])
def test_normalize_target_rejects_invalid(raw) -> None:
    with pytest.raises(ValueError):
        renewal_reminder.normalize_target(raw)


def test_bucket_picks_smallest_applicable() -> None:
    """Còn 2.4 ngày → mốc 3; còn 0.8 ngày → mốc 1; còn 5 ngày → chưa tới mốc nào."""
    buckets = [3, 1]
    assert renewal_reminder._bucket_for(2.4, buckets) == 3
    assert renewal_reminder._bucket_for(0.8, buckets) == 1
    assert renewal_reminder._bucket_for(5, buckets) is None


def test_escape_html_protects_underscore_emails() -> None:
    """Email khách hay chứa '_' và '&' — dùng HTML nên chỉ cần thoát 3 ký tự."""
    assert telegram.escape_html("a_b&c<d>") == "a_b&amp;c&lt;d&gt;"


def test_split_html_lines_chunks_long_lists() -> None:
    lines = [f"• email{i}@example.com" for i in range(400)]
    chunks = telegram.split_html_lines("HEAD", lines, "FOOT")
    assert len(chunks) > 1
    assert all(len(c) <= telegram.MAX_MESSAGE_CHARS + len("HEAD (tiếp)FOOT") for c in chunks)
    assert chunks[1].startswith("HEAD (tiếp)")


# ── Quét + chống trùng ────────────────────────────────────────────────────────


def test_reminder_sent_once_per_bucket(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """GUARD chính: chạy job 3 lần chỉ ra ĐÚNG 1 tin cho mốc đó (dedupe_key)."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach1@example.com", days_left=2, owner_id=owner_id)

    _run()
    _run()
    _run()

    assert len(sent) == 1, sent
    chat_id, text = sent[0]
    assert chat_id == OWNER_CHAT
    assert "khach1@example.com" in text
    assert _statuses() == [("sent", 3, "owner")]


def test_multiple_members_grouped_into_one_message(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Đại lý có 3 email cùng đến hạn → nhận 1 tin gộp, không phải 3 tin."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    for i in range(3):
        _add_member(client, ws, f"khach{i}@example.com", days_left=2, owner_id=owner_id)

    _run()

    assert len(sent) == 1, sent
    text = sent[0][1]
    for i in range(3):
        assert f"khach{i}@example.com" in text


def test_second_bucket_fires_when_closer_to_expiry(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Mốc 3 đã nhắc; khi còn <1 ngày thì mốc 1 nhắc thêm ĐÚNG 1 lần nữa."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)
    _run()
    assert len(sent) == 1

    with SessionLocal() as db:
        member = db.get(Member, member_id)
        member.subscription_end_at = _now() + timedelta(hours=10)
        db.commit()

    _run()
    _run()

    assert len(sent) == 2, sent
    assert sorted(s[1] for s in _statuses()) == [1, 3]


def test_unlimited_and_far_members_not_notified(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Vô thời hạn (end NULL) và còn xa hạn → không nhắc."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "xa@example.com", days_left=20, owner_id=owner_id)
    _add_member(
        client, ws, "vohan@example.com", days_left=2, owner_id=owner_id,
        subscription_end_at=None, subscription_months=None,
    )

    _run()

    assert sent == []


def test_expired_member_not_notified(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Đã hết hạn thuộc luồng auto-remove, không nhắc gia hạn nữa."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "hethan@example.com", days_left=-1, owner_id=owner_id)

    _run()

    assert sent == []


def test_owner_without_link_gets_nothing(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Đại lý chưa liên kết Telegram → không có ai để gửi (không lỗi, không tin)."""
    ws = _make_ws(client, auth_header)
    with SessionLocal() as db:
        owner_id = str(db.query(User).filter(User.username == "superadmin").one().id)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    _run()

    assert sent == []


def test_notify_disabled_stops_reminders(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    owner_id = _link_owner()
    with SessionLocal() as db:
        user = db.get(User, owner_id)
        user.telegram_notify_enabled = False
        db.commit()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    _run()

    assert sent == []


# ── Chỉ định người nhận theo email ────────────────────────────────────────────


def test_assignee_replaces_owner(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Chỉ định bằng ID số đã resolve → tin về khách, KHÔNG về đại lý."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(
        client, ws, "khach@example.com", days_left=2, owner_id=owner_id,
        notify_telegram_target=str(ASSIGNEE_CHAT),
        notify_telegram_chat_id=ASSIGNEE_CHAT,
    )

    _run()

    assert [c for c, _ in sent] == [ASSIGNEE_CHAT]


def test_unresolved_username_falls_back_to_owner_then_resolves(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """@username chưa bấm /start → nhắc tạm về đại lý (KHÔNG mất tin); sau khi họ
    /start thì mốc kế tiếp đi đúng địa chỉ khách."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    member_id = _add_member(
        client, ws, "khach@example.com", days_left=2, owner_id=owner_id,
        notify_telegram_target="@khach_vip",
    )

    _run()
    assert [c for c, _ in sent] == [OWNER_CHAT]

    # Khách bấm /start → webhook ghi sổ liên hệ và khớp ngược chỉ định.
    resp = _webhook(
        client,
        {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": ASSIGNEE_CHAT, "type": "private"},
                "from": {"id": ASSIGNEE_CHAT, "username": "Khach_VIP", "first_name": "Khach"},
                "text": "/start",
            },
        },
    )
    assert resp.status_code == 200, resp.text
    with SessionLocal() as db:
        assert db.get(Member, member_id).notify_telegram_chat_id == ASSIGNEE_CHAT
        member = db.get(Member, member_id)
        member.subscription_end_at = _now() + timedelta(hours=10)  # sang mốc 1
        db.commit()

    sent.clear()
    _run()

    assert [c for c, _ in sent] == [ASSIGNEE_CHAT]


def test_notify_target_endpoint(client: TestClient, auth_header: dict, bot_on) -> None:
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "khach@example.com", days_left=2)
    url = f"/api/v1/workspaces/{ws['id']}/members/{member_id}/notify-target"

    resp = client.patch(url, json={"target": "@Khach_VIP"}, headers=auth_header)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "member_id": member_id,
        "target": "@khach_vip",
        "chat_id": None,
        "resolved": False,
    }

    # Người đó đã từng /start → khớp được ngay khi đặt chỉ định.
    with SessionLocal() as db:
        db.add(TelegramContact(chat_id=ASSIGNEE_CHAT, username="khach_vip"))
        db.commit()
    resp = client.patch(url, json={"target": "khach_vip"}, headers=auth_header)
    assert resp.json()["resolved"] is True
    assert resp.json()["chat_id"] == ASSIGNEE_CHAT

    # Xoá chỉ định → về lại đại lý.
    resp = client.patch(url, json={"target": None}, headers=auth_header)
    assert resp.json() == {
        "member_id": member_id,
        "target": None,
        "chat_id": None,
        "resolved": False,
    }

    assert client.patch(url, json={"target": "abc"}, headers=auth_header).status_code == 400


# ── Nhóm admin ────────────────────────────────────────────────────────────────


def test_admin_group_gets_digest(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    monkeypatch.setattr(bot_on, "telegram_admin_chat_id", str(ADMIN_CHAT))
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    _run()

    chats = sorted(c for c, _ in sent)
    assert chats == sorted([ADMIN_CHAT, OWNER_CHAT])
    digest = next(text for chat, text in sent if chat == ADMIN_CHAT)
    assert "superadmin" in digest  # digest nêu rõ email thuộc đại lý nào


# ── Lỗi gửi ───────────────────────────────────────────────────────────────────


def test_blocked_recipient_not_retried(
    client: TestClient, auth_header: dict, bot_on, monkeypatch
) -> None:
    """Bot bị chặn = lỗi VĨNH VIỄN → đánh dấu blocked, tick sau không gửi lại."""
    calls: list[int] = []

    def fake_send(chat_id: int, html_text: str):
        calls.append(chat_id)
        raise telegram.TelegramError("blocked", "Forbidden: bot was blocked by the user")

    monkeypatch.setattr(telegram, "send_message", fake_send)
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    _run()
    _run()

    assert len(calls) == 1
    assert _statuses() == [("blocked", 3, "owner")]
    with SessionLocal() as db:
        contact = db.get(TelegramContact, OWNER_CHAT)
        assert contact is not None and contact.blocked_at is not None

    # Sang MỐC KẾ TIẾP cũng không thử nữa: đã chặn thì mọi lượt quét sau bỏ qua chat đó.
    with SessionLocal() as db:
        member = db.get(Member, member_id)
        member.subscription_end_at = _now() + timedelta(hours=10)
        db.commit()
    _run()

    assert len(calls) == 1
    assert _statuses() == [("blocked", 3, "owner")]


def test_temporary_error_is_retried(
    client: TestClient, auth_header: dict, bot_on, monkeypatch
) -> None:
    """Lỗi mạng → 'failed' rồi tick sau gửi lại thành công."""
    attempts: list[int] = []

    def flaky(chat_id: int, html_text: str):
        attempts.append(chat_id)
        if len(attempts) == 1:
            raise telegram.TelegramError("network", "Không kết nối được Telegram")
        return telegram.SentMessage(chat_id=chat_id, message_id=7)

    monkeypatch.setattr(telegram, "send_message", flaky)
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    _run()
    assert _statuses() == [("failed", 3, "owner")]

    _run()
    assert len(attempts) == 2
    assert _statuses() == [("sent", 3, "owner")]


def test_renewed_before_send_is_skipped(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Gia hạn xong TRƯỚC khi tin kịp gửi → bỏ tin, không nhắn thông tin đã sai."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    with SessionLocal() as db:
        renewal_reminder.scan_and_claim(db)
        member = db.get(Member, member_id)
        member.subscription_end_at = _now() + timedelta(days=32)
        db.commit()
        renewal_reminder.flush_pending(db)

    assert sent == []
    assert _statuses() == [("skipped", 3, "owner")]


# ── Liên kết tài khoản qua bot ────────────────────────────────────────────────


def test_link_flow_via_deep_link(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")

    resp = client.post("/api/v1/telegram/link", headers=auth_header)
    assert resp.status_code == 200, resp.text
    token = resp.json()["token"]
    assert resp.json()["deep_link"] == f"https://t.me/my_test_bot?start={token}"

    resp = _webhook(
        client,
        {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": OWNER_CHAT, "type": "private"},
                "from": {"id": OWNER_CHAT, "username": "dai_ly", "first_name": "Dai"},
                "text": f"/start {token}",
            },
        },
    )
    assert resp.status_code == 200, resp.text

    status = client.get("/api/v1/telegram/status", headers=auth_header).json()
    assert status["linked"] is True
    assert status["telegram_chat_id"] == OWNER_CHAT
    assert status["telegram_username"] == "dai_ly"

    # Token dùng-một-lần: dùng lại không liên kết được nữa.
    client.delete("/api/v1/telegram/link", headers=auth_header)
    _webhook(
        client,
        {
            "update_id": 2,
            "message": {
                "message_id": 2,
                "chat": {"id": 777, "type": "private"},
                "from": {"id": 777, "username": "ke_gian", "first_name": "X"},
                "text": f"/start {token}",
            },
        },
    )
    status = client.get("/api/v1/telegram/status", headers=auth_header).json()
    assert status["linked"] is False


def test_webhook_rejects_wrong_secret(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    payload = {
        "update_id": 1,
        "message": {
            "message_id": 1,
            "chat": {"id": OWNER_CHAT, "type": "private"},
            "from": {"id": OWNER_CHAT, "username": "ai_do", "first_name": "X"},
            "text": "/start",
        },
    }

    resp = _webhook(client, payload, secret="sai-secret")
    assert resp.status_code == 200  # luôn 200 để Telegram khỏi retry vô hạn
    assert resp.json() == {"ok": False}
    with SessionLocal() as db:
        assert db.get(TelegramContact, OWNER_CHAT) is None

    resp = _webhook(client, payload)
    assert resp.json() == {"ok": True}
    with SessionLocal() as db:
        assert db.get(TelegramContact, OWNER_CHAT) is not None


def test_webhook_fail_closed_without_secret(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """CHƯA đặt secret ⇒ TỪ CHỐI mọi update.

    Nếu chấp nhận update không xác thực, bất kỳ ai biết '@username' khách đang được
    chỉ định đều POST được một '/start' giả mạo để GÁN username đó vào chat_id của
    mình → chiếm kênh nhận nhắc và đọc được email khách hàng. Đây là guard chống ca đó.
    """
    ws = _make_ws(client, auth_header)
    member_id = _add_member(
        client, ws, "khach@example.com", days_left=2, notify_telegram_target="@khach_vip"
    )
    monkeypatch.setattr(bot_on, "telegram_webhook_secret", "")

    resp = client.post(
        "/webhook/telegram",
        json={
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": 424242, "type": "private"},
                "from": {"id": 424242, "username": "khach_vip", "first_name": "Ke gian"},
                "text": "/start",
            },
        },
    )

    assert resp.json() == {"ok": False}
    with SessionLocal() as db:
        assert db.get(TelegramContact, 424242) is None
        # Quan trọng nhất: chỉ định của email KHÔNG bị gán sang chat lạ.
        assert db.get(Member, member_id).notify_telegram_chat_id is None


def test_setup_webhook_registers_secret_in_use(
    client: TestClient, auth_header: dict, bot_off, monkeypatch
) -> None:
    """Đăng ký webhook phải dùng secret ĐANG HIỆU LỰC (ở đây là secret sinh trong DB
    khi lưu token qua giao diện).

    Bug thật 2026-08-03: chỗ này lấy secret từ .env (rỗng khi cấu hình bằng UI) nên
    Telegram gửi update không kèm secret → handler fail-closed chặn hết → bot im lặng
    hoàn toàn, không có lỗi nào nhìn thấy được.
    """
    monkeypatch.setattr(telegram, "verify_token", lambda tok: {"username": "my_shop_bot"})
    client.put(
        "/api/v1/telegram/admin/token",
        json={"bot_token": "123456789:AAF-fake-token-for-test"},
        headers=auth_header,
    )
    with SessionLocal() as db:
        db_secret = db.get(TelegramSettings, 1).webhook_secret
    assert db_secret

    captured: dict = {}
    monkeypatch.setattr(
        telegram, "set_webhook", lambda url, secret: captured.update(url=url, secret=secret) or {}
    )

    resp = client.post(
        "/api/v1/telegram/admin/webhook",
        json={"public_url": "https://gpt.example.org"},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert captured["url"] == "https://gpt.example.org/webhook/telegram"
    assert captured["secret"] == db_secret

    # Và update mang đúng secret đó phải được xử lý (không bị chặn oan).
    resp = client.post(
        "/webhook/telegram",
        json={
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": 515151, "type": "private"},
                "from": {"id": 515151, "username": "ai_do", "first_name": "X"},
                "text": "/start",
            },
        },
        headers={"X-Telegram-Bot-Api-Secret-Token": db_secret},
    )
    assert resp.json() == {"ok": True}


def test_setup_webhook_requires_secret(
    client: TestClient, auth_header: dict, bot_on, monkeypatch
) -> None:
    """Đăng ký webhook khi chưa có secret ⇒ 400 (đăng ký xong cũng từ chối hết)."""
    monkeypatch.setattr(bot_on, "telegram_webhook_secret", "")
    resp = client.post("/api/v1/telegram/admin/webhook", json={}, headers=auth_header)
    assert resp.status_code == 400
    assert "TELEGRAM_WEBHOOK_SECRET" in str(resp.json()["detail"])


def test_endpoints_503_when_bot_not_configured(
    client: TestClient, auth_header: dict, monkeypatch
) -> None:
    """Chưa cấu hình token → tính năng tắt hẳn, KHÔNG làm hỏng nghiệp vụ khác."""
    monkeypatch.setattr(get_settings(), "telegram_bot_token", "")
    telegram.refresh_config()
    assert client.post("/api/v1/telegram/link", headers=auth_header).status_code == 503
    assert client.post("/api/v1/telegram/admin/run-now", headers=auth_header).status_code == 503
    assert client.get("/api/v1/telegram/status", headers=auth_header).json()["bot_configured"] is False


# ── Nhập token bot từ giao diện (không cần SSH sửa .env) ──────────────────────


@pytest.fixture
def bot_off(monkeypatch):
    """Không có cấu hình .env → mọi thứ đọc từ bảng telegram_settings."""
    settings = get_settings()
    monkeypatch.setattr(settings, "telegram_bot_token", "")
    monkeypatch.setattr(settings, "telegram_bot_username", "")
    monkeypatch.setattr(settings, "telegram_webhook_secret", "")
    monkeypatch.setattr(settings, "telegram_admin_chat_id", "")
    telegram.refresh_config()
    yield settings
    telegram.refresh_config()


def test_admin_saves_bot_token_from_ui(
    client: TestClient, auth_header: dict, bot_off, monkeypatch
) -> None:
    """Super-admin dán token → getMe xác thực → mã hoá lưu DB → bot dùng được ngay.

    Token KHÔNG được lưu thô và KHÔNG bao giờ trả ngược ra API/audit.
    """
    monkeypatch.setattr(telegram, "verify_token", lambda tok: {"username": "my_shop_bot"})
    assert client.get("/api/v1/telegram/status", headers=auth_header).json()["bot_configured"] is False

    resp = client.put(
        "/api/v1/telegram/admin/token",
        json={"bot_token": "123456789:AAF-fake-token-for-test"},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["bot_username"] == "my_shop_bot"

    status = client.get("/api/v1/telegram/status", headers=auth_header).json()
    assert status["bot_configured"] is True
    assert status["bot_username"] == "my_shop_bot"

    admin = client.get("/api/v1/telegram/admin/status", headers=auth_header).json()
    assert admin["config_source"] == "db"

    with SessionLocal() as db:
        row = db.get(TelegramSettings, 1)
        assert row.bot_token_encrypted and "123456789" not in row.bot_token_encrypted
        assert telegram.decrypt_secret(row.bot_token_encrypted) == "123456789:AAF-fake-token-for-test"
        # Secret webhook sinh tự động → webhook dùng được ngay, admin khỏi tự nghĩ.
        assert row.webhook_secret
        audits = db.query(AuditLog).filter(AuditLog.action == "TELEGRAM_BOT_TOKEN_SET").all()
        assert len(audits) == 1
        assert "123456789" not in json.dumps(audits[0].data or {})

    # Gỡ token → tắt lại.
    assert client.delete("/api/v1/telegram/admin/token", headers=auth_header).status_code == 204
    assert client.get("/api/v1/telegram/status", headers=auth_header).json()["bot_configured"] is False


def test_admin_token_rejected_when_invalid(
    client: TestClient, auth_header: dict, bot_off, monkeypatch
) -> None:
    def boom(tok: str):
        raise telegram.TelegramError("unauthorized", "Unauthorized")

    monkeypatch.setattr(telegram, "verify_token", boom)
    resp = client.put(
        "/api/v1/telegram/admin/token",
        json={"bot_token": "123456789:sai-token-hoan-toan"},
        headers=auth_header,
    )
    assert resp.status_code == 400
    with SessionLocal() as db:
        assert db.get(TelegramSettings, 1) is None


def test_env_token_wins_over_ui(client: TestClient, auth_header: dict, bot_on) -> None:
    """Đã đặt .env thì UI không được ghi đè (tránh hai nguồn sự thật)."""
    resp = client.put(
        "/api/v1/telegram/admin/token",
        json={"bot_token": "123456789:AAF-token-khac"},
        headers=auth_header,
    )
    assert resp.status_code == 409


def test_admin_chat_saved_from_ui_reaches_digest(
    client: TestClient, auth_header: dict, bot_off, sent, monkeypatch
) -> None:
    """Nhóm digest đặt ở giao diện được job nhắc dùng thật."""
    monkeypatch.setattr(telegram, "verify_token", lambda tok: {"username": "my_shop_bot"})
    resp = client.put(
        "/api/v1/telegram/admin/token",
        json={"bot_token": "123456789:AAF-fake-token-for-test"},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    resp = client.put(
        "/api/v1/telegram/admin/admin-chat",
        json={"admin_chat_id": str(ADMIN_CHAT)},
        headers=auth_header,
    )
    assert resp.json()["admin_chat_ids"] == [ADMIN_CHAT]

    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)
    _run()

    assert sorted(c for c, _ in sent) == sorted([ADMIN_CHAT, OWNER_CHAT])


# ── Khách TỰ đăng ký nhận nhắc bằng lệnh /email ───────────────────────────────


def _start_bot(client: TestClient, chat_id: int, username: str | None = None):
    return _webhook(
        client,
        {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": chat_id, "type": "private"},
                "from": {"id": chat_id, "username": username, "first_name": "Khach"},
                "text": "/start",
            },
        },
    )


def _send_cmd(client: TestClient, chat_id: int, text: str, username: str | None = None):
    return _webhook(
        client,
        {
            "update_id": 2,
            "message": {
                "message_id": 2,
                "chat": {"id": chat_id, "type": "private"},
                "from": {"id": chat_id, "username": username, "first_name": "Khach"},
                "text": text,
            },
        },
    )


def test_email_command_subscribes_and_receives(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Đường 2: khách bấm Start rồi gõ '/email <địa chỉ>' → nhận nhắc cho ĐÚNG email đó
    (thay cho đại lý), không cần admin thao tác gì."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    _start_bot(client, ASSIGNEE_CHAT, "khach_vip")
    _send_cmd(client, ASSIGNEE_CHAT, "/email Khach@Example.com", "khach_vip")

    with SessionLocal() as db:
        member = db.get(Member, member_id)
        assert member.notify_telegram_chat_id == ASSIGNEE_CHAT
        assert member.notify_telegram_target == "@khach_vip"

    sent.clear()
    _run()
    assert [c for c, _ in sent] == [ASSIGNEE_CHAT]


def test_email_command_rejects_email_taken_by_another_chat(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Không cho người lạ CHIẾM kênh nhận nhắc của email đã có người đăng ký."""
    ws = _make_ws(client, auth_header)
    member_id = _add_member(
        client, ws, "khach@example.com", days_left=2,
        notify_telegram_target=str(ASSIGNEE_CHAT), notify_telegram_chat_id=ASSIGNEE_CHAT,
    )

    _start_bot(client, 909090, "ke_gian")
    _send_cmd(client, 909090, "/email khach@example.com", "ke_gian")

    with SessionLocal() as db:
        assert db.get(Member, member_id).notify_telegram_chat_id == ASSIGNEE_CHAT
    assert "đã được đăng ký" in sent[-1][1]


def test_start_greets_with_count_and_points_to_huongdan(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """/start chỉ chào + cho biết đang nhận thông báo cho bao nhiêu email.

    Bảng lệnh đầy đủ là việc của /huongdan; đổ vào đây thì lời chào dài gấp đôi.
    """
    ws = _make_ws(client, auth_header)
    _add_member(
        client, ws, "khach@example.com", days_left=30, **_assigned_to(ASSIGNEE_CHAT)
    )

    _start_bot(client, ASSIGNEE_CHAT, "khach_vip")
    reply = sent[-1][1]
    assert "Email bạn sẽ nhận thông báo (1)" in reply
    assert "Xem hướng dẫn các lệnh tại : /huongdan" in reply
    assert "/tat —" not in reply, "lời chào không được đổ nguyên bảng lệnh"


def test_huongdan_lists_commands_and_wrong_syntax_points_to_it(
    client: TestClient, bot_on, sent
) -> None:
    """Chỉ lệnh đúng mới có phản hồi thật; gõ sai chỉ được nhắc /huongdan."""
    _start_bot(client, ASSIGNEE_CHAT, "khach_vip")

    _send_cmd(client, ASSIGNEE_CHAT, "/huongdan", "khach_vip")
    assert "/danhsach" in sent[-1][1] and "/handung" in sent[-1][1]
    # Bảng lệnh do chính /huongdan trả về thì không liệt kê lại /huongdan nữa.
    assert "/huongdan —" not in sent[-1][1]

    for text in ("/khongcolenh", "chào bot", "/email"):
        _send_cmd(client, ASSIGNEE_CHAT, text, "khach_vip")
        if text == "/email":  # lệnh đúng nhưng thiếu tham số → nhắc cú pháp riêng
            assert "/email ex1@example.com" in sent[-1][1]
        else:
            assert sent[-1][1] == "Sai cú pháp : /huongdan để xem hướng dẫn"


def test_email_command_unknown_and_unsubscribe(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "khach@example.com", days_left=2)

    _start_bot(client, ASSIGNEE_CHAT, "khach_vip")
    _send_cmd(client, ASSIGNEE_CHAT, "/email khong-ton-tai@example.com", "khach_vip")
    assert "Không tìm thấy" in sent[-1][1]

    _send_cmd(client, ASSIGNEE_CHAT, "/email khach@example.com", "khach_vip")
    _send_cmd(client, ASSIGNEE_CHAT, "/huyemail khach@example.com", "khach_vip")
    with SessionLocal() as db:
        member = db.get(Member, member_id)
        assert member.notify_telegram_chat_id is None
        assert member.notify_telegram_target is None


def _assigned_to(chat_id: int) -> dict:
    """Email được CHỈ ĐỊNH gửi nhắc thẳng tới một chat (không qua link mời)."""
    return {"notify_telegram_chat_id": chat_id, "notify_telegram_target": str(chat_id)}


def test_danhsach_lists_all_watched_emails_and_handung_filters_7_days(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """`/danhsach` = TOÀN BỘ email đang theo dõi; `/handung` = còn dưới 7 ngày.

    GUARD cho bug đã sửa: lệnh cũ chỉ trả email hết hạn trong 30 ngày tới, nên khách
    vừa bấm link Thông báo cho một email còn hạn dài gõ /danhsach lại ra danh sách
    rỗng — tưởng link hỏng.
    """
    ws = _make_ws(client, auth_header)
    assigned = _assigned_to(ASSIGNEE_CHAT)
    _add_member(client, ws, "con-lau@example.com", days_left=300, **assigned)
    _add_member(client, ws, "sap-het@example.com", days_left=3, **assigned)
    _add_member(client, ws, "da-het@example.com", days_left=-5, **assigned)
    _add_member(
        client, ws, "vo-han@example.com", days_left=1, subscription_end_at=None, **assigned
    )

    _send_cmd(client, ASSIGNEE_CHAT, "/danhsach", "khach_vip")
    reply = sent[-1][1]
    assert "Email bạn sở hữu (4)" in reply
    for email in ("con-lau@", "sap-het@", "da-het@", "vo-han@"):
        assert email in reply, f"/danhsach thiếu {email}"
    assert "không giới hạn thời hạn" in reply
    # Sắp hết hạn xếp trước, email vô thời hạn xuống cuối.
    assert reply.index("da-het@") < reply.index("con-lau@") < reply.index("vo-han@")

    sent.clear()
    _send_cmd(client, ASSIGNEE_CHAT, "/handung", "khach_vip")
    reply = sent[-1][1]
    # Đã hết hạn cũng tính là "còn dưới 7 ngày" — đó là suất cần gia hạn gấp nhất.
    assert "còn dưới 7 ngày sử dụng (2)" in reply
    assert "sap-het@example.com" in reply and "da-het@example.com" in reply
    assert "con-lau@example.com" not in reply and "vo-han@example.com" not in reply


def test_handung_empty_does_not_hide_the_email_from_danhsach(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Email còn hạn dài: /handung rỗng là ĐÚNG, nhưng /danhsach vẫn phải thấy nó."""
    ws = _make_ws(client, auth_header)
    _add_member(
        client, ws, "con-lau@example.com", days_left=300, **_assigned_to(ASSIGNEE_CHAT)
    )

    _send_cmd(client, ASSIGNEE_CHAT, "/handung", "khach_vip")
    assert "Không có email nào còn dưới 7 ngày" in sent[-1][1]

    _send_cmd(client, ASSIGNEE_CHAT, "/danhsach", "khach_vip")
    assert "con-lau@example.com" in sent[-1][1]


def test_danhsach_empty_guides_a_chat_watching_nothing(
    client: TestClient, bot_on, sent
) -> None:
    _send_cmd(client, 909091, "/danhsach", "nguoi_la")
    assert "chưa sở hữu email nào" in sent[-1][1]
    assert "/email ex1@example.com" in sent[-1][1]


# ── Danh sách người nhận thông báo của một tài khoản (link chia sẻ) ───────────


SUBSCRIBER_CHAT = 606001
SUBSCRIBER2_CHAT = 606002


def _invite_and_join(
    client: TestClient, auth_header: dict, chat_id: int, username: str
) -> str:
    """Chủ tài khoản tạo link mời → người kia bấm Start → thành người nhận."""
    resp = client.post("/api/v1/telegram/subscriptions/invite", headers=auth_header)
    assert resp.status_code == 200, resp.text
    token = resp.json()["token"]
    _webhook(
        client,
        {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": chat_id, "type": "private"},
                "from": {"id": chat_id, "username": username, "first_name": "NV"},
                "text": f"/start {token}",
            },
        },
    )
    return token


def test_invite_link_grants_all_notifications(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Bấm link mời ⇒ nhận TOÀN BỘ thông báo của tài khoản đó, kể cả email thêm SAU."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach1@example.com", days_left=2, owner_id=owner_id)

    _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")

    subs = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
    assert len(subs) == 1
    assert subs[0]["scope"] == "all"
    assert subs[0]["display_name"] == "@nhan_vien"

    # Email thêm SAU khi mời vẫn phải tới người nhận (đúng nghĩa "toàn bộ").
    _add_member(client, ws, "khach2@example.com", days_left=2, owner_id=owner_id)
    sent.clear()
    _run()

    chats = sorted(c for c, _ in sent)
    assert chats == sorted([OWNER_CHAT, SUBSCRIBER_CHAT])
    sub_msg = next(text for chat, text in sent if chat == SUBSCRIBER_CHAT)
    assert "khach1@example.com" in sub_msg and "khach2@example.com" in sub_msg
    assert "superadmin" in sub_msg  # nêu rõ thông báo của tài khoản nào


def test_subscription_scope_selected(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Thu hẹp phạm vi: người nhận chỉ nhận đúng email được chọn."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    m1 = _add_member(client, ws, "chon@example.com", days_left=2, owner_id=owner_id)
    _add_member(client, ws, "khongchon@example.com", days_left=2, owner_id=owner_id)

    _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")
    sub_id = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()[0]["id"]

    resp = client.patch(
        f"/api/v1/telegram/subscriptions/{sub_id}",
        json={"scope": "selected", "member_ids": [m1]},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["member_ids"] == [m1]

    sent.clear()
    _run()

    sub_msg = next(text for chat, text in sent if chat == SUBSCRIBER_CHAT)
    assert "chon@example.com" in sub_msg
    assert "khongchon@example.com" not in sub_msg
    # Chủ tài khoản vẫn nhận đủ cả hai.
    owner_msg = next(text for chat, text in sent if chat == OWNER_CHAT)
    assert "khongchon@example.com" in owner_msg


def test_subscription_pause_and_remove(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)
    _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")
    sub_id = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()[0]["id"]

    client.patch(
        f"/api/v1/telegram/subscriptions/{sub_id}",
        json={"enabled": False},
        headers=auth_header,
    )
    sent.clear()
    _run()
    assert SUBSCRIBER_CHAT not in [c for c, _ in sent]

    assert (
        client.delete(f"/api/v1/telegram/subscriptions/{sub_id}", headers=auth_header).status_code
        == 204
    )
    assert client.get("/api/v1/telegram/subscriptions", headers=auth_header).json() == []


def test_subscription_scope_rejects_foreign_emails(
    client: TestClient, auth_header: dict, bot_on, monkeypatch
) -> None:
    """Không cho trỏ người nhận sang email KHÔNG thuộc tài khoản mình."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    ws = _make_ws(client, auth_header)
    # Email không có chủ (invited_by_user_id = None) → không thuộc super-admin.
    foreign = _add_member(client, ws, "cuanguoikhac@example.com", days_left=2)
    _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")
    sub_id = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()[0]["id"]

    resp = client.patch(
        f"/api/v1/telegram/subscriptions/{sub_id}",
        json={"scope": "selected", "member_ids": [foreign]},
        headers=auth_header,
    )
    # Lọc sạch email lạ → không còn email nào hợp lệ → từ chối, giữ nguyên cấu hình cũ.
    assert resp.status_code == 400
    with SessionLocal() as db:
        assert db.get(TelegramSubscription, UUID(sub_id)).scope == "all"


def test_invite_link_reusable_and_self_link_untouched(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Link MỜI dùng được nhiều lần (nhiều người cùng nhận); tạo link kết nối chính
    chủ KHÔNG được xoá mất link mời đang phát cho nhân viên."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    token = _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien_1")

    # Người thứ hai dùng LẠI đúng link đó.
    _webhook(
        client,
        {
            "update_id": 2,
            "message": {
                "message_id": 2,
                "chat": {"id": SUBSCRIBER2_CHAT, "type": "private"},
                "from": {"id": SUBSCRIBER2_CHAT, "username": "nhan_vien_2", "first_name": "NV2"},
                "text": f"/start {token}",
            },
        },
    )
    subs = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
    assert sorted(s["chat_id"] for s in subs) == sorted([SUBSCRIBER_CHAT, SUBSCRIBER2_CHAT])

    # Tạo link kết nối chính chủ rồi dùng lại link MỜI → vẫn còn hiệu lực.
    client.post("/api/v1/telegram/link", headers=auth_header)
    _webhook(
        client,
        {
            "update_id": 3,
            "message": {
                "message_id": 3,
                "chat": {"id": 606003, "type": "private"},
                "from": {"id": 606003, "username": "nhan_vien_3", "first_name": "NV3"},
                "text": f"/start {token}",
            },
        },
    )
    subs = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
    assert len(subs) == 3


def test_invite_link_start_replies_with_watched_emails(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Bấm link nhận thông báo + Start ⇒ bot trả LUÔN danh sách email sẽ nhận nhắc.

    Người nhận cần biết ngay mình vừa theo dõi những email nào (bấm nhầm link của
    người khác thì nhận ra liền), thay vì phải mò gõ thêm /danhsach.
    """
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "sap-het@example.com", days_left=2, owner_id=owner_id)
    _add_member(client, ws, "con-lau@example.com", days_left=120, owner_id=owner_id)

    _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")

    reply = sent[-1][1]
    assert "Email bạn sẽ nhận thông báo (2)" in reply
    assert "sap-het@example.com" in reply and "con-lau@example.com" in reply
    # Sắp hết hạn đứng trước — đúng thứ tự người nhận quan tâm.
    assert reply.index("sap-het@example.com") < reply.index("con-lau@example.com")

    # Bấm /start trơn sau đó (link cũ hết hạn / mở lại chat) vẫn ra đúng danh sách.
    sent.clear()
    _start_bot(client, SUBSCRIBER_CHAT, "nhan_vien")
    assert "sap-het@example.com" in sent[-1][1]


def test_invite_link_start_reply_follows_scope(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Danh sách trả về phải theo ĐÚNG phạm vi chủ tài khoản đã thu hẹp, không lộ
    email nằm ngoài phạm vi."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    m1 = _add_member(client, ws, "chon@example.com", days_left=2, owner_id=owner_id)
    _add_member(client, ws, "khongchon@example.com", days_left=2, owner_id=owner_id)

    token = _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")
    sub_id = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()[0]["id"]
    client.patch(
        f"/api/v1/telegram/subscriptions/{sub_id}",
        json={"scope": "selected", "member_ids": [m1]},
        headers=auth_header,
    )

    sent.clear()
    _webhook(
        client,
        {
            "update_id": 9,
            "message": {
                "message_id": 9,
                "chat": {"id": SUBSCRIBER_CHAT, "type": "private"},
                "from": {"id": SUBSCRIBER_CHAT, "username": "nhan_vien", "first_name": "NV"},
                "text": f"/start {token}",
            },
        },
    )
    reply = sent[-1][1]
    assert "Email bạn sẽ nhận thông báo (1)" in reply
    assert "chon@example.com" in reply
    assert "khongchon@example.com" not in reply


def test_invite_link_start_reply_when_account_has_no_email(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Tài khoản chưa có email nào → nói rõ là chưa có, không im lặng bỏ trống."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    _link_owner()
    _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")

    reply = sent[-1][1]
    assert "chưa có email nào" in reply
    assert "Email bạn sẽ nhận thông báo" not in reply


# ── Link mời GẮN SẴN phạm vi email (chọn ngay lúc tạo link) ───────────────────


def _create_invite(client: TestClient, auth_header: dict, **body) -> dict:
    resp = client.post(
        "/api/v1/telegram/subscriptions/invite", json=body or None, headers=auth_header
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _join_with_token(client: TestClient, token: str, chat_id: int, username: str, upd: int = 7):
    return _webhook(
        client,
        {
            "update_id": upd,
            "message": {
                "message_id": upd,
                "chat": {"id": chat_id, "type": "private"},
                "from": {"id": chat_id, "username": username, "first_name": "NV"},
                "text": f"/start {token}",
            },
        },
    )


def test_invite_link_carries_selected_scope(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Chọn email NGAY LÚC TẠO LINK ⇒ người bấm link chỉ nhận đúng những email đó,
    không có khoảng thời gian 'lỡ nhận hết rồi mới thu hẹp'."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    m1 = _add_member(client, ws, "chon@example.com", days_left=2, owner_id=owner_id)
    _add_member(client, ws, "khongchon@example.com", days_left=2, owner_id=owner_id)

    invite = _create_invite(
        client, auth_header, label="Nhân viên A", scope="selected", member_ids=[m1]
    )
    assert invite["scope"] == "selected" and invite["member_ids"] == [m1]

    _join_with_token(client, invite["token"], SUBSCRIBER_CHAT, "nhan_vien")

    subs = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
    assert len(subs) == 1
    assert subs[0]["scope"] == "selected" and subs[0]["member_ids"] == [m1]
    assert subs[0]["invite_label"] == "Nhân viên A"
    # Lời chào chỉ nêu email trong phạm vi — không lộ email ngoài phạm vi.
    assert "khongchon@example.com" not in sent[-1][1]

    sent.clear()
    _run()
    sub_msg = next(text for chat, text in sent if chat == SUBSCRIBER_CHAT)
    assert "chon@example.com" in sub_msg and "khongchon@example.com" not in sub_msg


def test_invite_links_live_side_by_side(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Tạo link mới KHÔNG giết link cũ: mỗi người nhận một suất phạm vi khác nhau."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    m1 = _add_member(client, ws, "mot@example.com", days_left=2, owner_id=owner_id)
    _add_member(client, ws, "hai@example.com", days_left=2, owner_id=owner_id)

    full = _create_invite(client, auth_header, label="Nhân viên")
    limited = _create_invite(client, auth_header, label="Khách", scope="selected", member_ids=[m1])

    _join_with_token(client, full["token"], SUBSCRIBER_CHAT, "nhan_vien", upd=11)
    _join_with_token(client, limited["token"], SUBSCRIBER2_CHAT, "khach", upd=12)

    subs = {s["chat_id"]: s for s in client.get(
        "/api/v1/telegram/subscriptions", headers=auth_header
    ).json()}
    assert subs[SUBSCRIBER_CHAT]["scope"] == "all"
    assert subs[SUBSCRIBER2_CHAT]["scope"] == "selected"
    assert subs[SUBSCRIBER2_CHAT]["member_ids"] == [m1]

    invites = client.get("/api/v1/telegram/invites", headers=auth_header).json()
    assert {i["label"] for i in invites} == {"Nhân viên", "Khách"}
    assert all(i["recipients"] == 1 for i in invites)


def test_invite_link_reclick_keeps_tuned_scope_and_new_link_adds_on_top(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Bấm LẠI đúng link vừa dùng ⇒ giữ phạm vi chủ tài khoản đã tinh chỉnh; bấm link
    KHÁC ⇒ email của link mới CỘNG THÊM vào, email đang theo dõi không mất."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    m1 = _add_member(client, ws, "mot@example.com", days_left=2, owner_id=owner_id)
    m2 = _add_member(client, ws, "hai@example.com", days_left=2, owner_id=owner_id)

    first = _create_invite(client, auth_header, label="Lần 1")
    _join_with_token(client, first["token"], SUBSCRIBER_CHAT, "nhan_vien", upd=21)
    sub_id = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()[0]["id"]
    client.patch(
        f"/api/v1/telegram/subscriptions/{sub_id}",
        json={"scope": "selected", "member_ids": [m1]},
        headers=auth_header,
    )

    # Bấm lại ĐÚNG link cũ → không phá cấu hình vừa tinh chỉnh.
    _join_with_token(client, first["token"], SUBSCRIBER_CHAT, "nhan_vien", upd=22)
    sub = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()[0]
    assert sub["scope"] == "selected" and sub["member_ids"] == [m1]

    # Link MỚI (email khác) → nhận THÊM email đó, vẫn giữ email đang theo dõi.
    second = _create_invite(client, auth_header, label="Lần 2", scope="selected", member_ids=[m2])
    sent.clear()
    _join_with_token(client, second["token"], SUBSCRIBER_CHAT, "nhan_vien", upd=23)
    sub = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()[0]
    assert sub["member_ids"] == [m1, m2]
    assert sub["invite_label"] == "Lần 2"
    # Lời chào nêu cả hai email — người nhận thấy ngay là được thêm chứ không bị đổi.
    reply = sent[-1][1]
    assert "mot@example.com" in reply and "hai@example.com" in reply

    # Nhắc gia hạn thật cũng gửi đủ cả hai.
    sent.clear()
    _run()
    msg = next(text for chat, text in sent if chat == SUBSCRIBER_CHAT)
    assert "mot@example.com" in msg and "hai@example.com" in msg


def test_invite_link_never_narrows_existing_recipient(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """'all' là tập lớn nhất: đang nhận TOÀN BỘ mà bấm link chọn lẻ thì vẫn toàn bộ,
    còn đang nhận lẻ mà bấm link toàn bộ thì lên toàn bộ. Bấm link không bao giờ bớt."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    m1 = _add_member(client, ws, "mot@example.com", days_left=2, owner_id=owner_id)
    _add_member(client, ws, "hai@example.com", days_left=2, owner_id=owner_id)

    full = _create_invite(client, auth_header, label="Toàn bộ")
    limited = _create_invite(client, auth_header, label="Lẻ", scope="selected", member_ids=[m1])

    # Đang 'all' + bấm link lẻ → vẫn 'all'.
    _join_with_token(client, full["token"], SUBSCRIBER_CHAT, "nhan_vien", upd=41)
    _join_with_token(client, limited["token"], SUBSCRIBER_CHAT, "nhan_vien", upd=42)
    sub = next(
        s
        for s in client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
        if s["chat_id"] == SUBSCRIBER_CHAT
    )
    assert sub["scope"] == "all"

    # Đang 'selected' + bấm link toàn bộ → lên 'all'.
    _join_with_token(client, limited["token"], SUBSCRIBER2_CHAT, "khach", upd=43)
    _join_with_token(client, full["token"], SUBSCRIBER2_CHAT, "khach", upd=44)
    sub2 = next(
        s
        for s in client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
        if s["chat_id"] == SUBSCRIBER2_CHAT
    )
    assert sub2["scope"] == "all" and sub2["member_ids"] == []


def test_invite_link_rejects_foreign_or_empty_selection(
    client: TestClient, auth_header: dict, bot_on, monkeypatch
) -> None:
    """Không tạo được link trỏ sang email KHÔNG thuộc mình, cũng không tạo link
    'selected' rỗng (sẽ thành link chẳng theo dõi gì)."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    ws = _make_ws(client, auth_header)
    foreign = _add_member(client, ws, "cuanguoikhac@example.com", days_left=2)

    resp = client.post(
        "/api/v1/telegram/subscriptions/invite",
        json={"scope": "selected", "member_ids": [foreign]},
        headers=auth_header,
    )
    assert resp.status_code == 400

    resp = client.post(
        "/api/v1/telegram/subscriptions/invite",
        json={"scope": "selected", "member_ids": []},
        headers=auth_header,
    )
    assert resp.status_code == 400


def test_invite_link_revoke_keeps_existing_recipients(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Gỡ link = chặn người CHƯA bấm; người ĐÃ bấm vẫn nhận thông báo (muốn ngắt thì
    gỡ ở danh sách người nhận — hai việc khác nhau)."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    invite = _create_invite(client, auth_header, label="Nhân viên")
    _join_with_token(client, invite["token"], SUBSCRIBER_CHAT, "nhan_vien", upd=31)

    assert (
        client.delete(
            f"/api/v1/telegram/invites/{invite['token']}", headers=auth_header
        ).status_code
        == 204
    )
    assert client.get("/api/v1/telegram/invites", headers=auth_header).json() == []
    # Người đã bấm vẫn còn (chỉ mất tên link vì link không còn).
    subs = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
    assert len(subs) == 1 and subs[0]["invite_label"] is None

    # Người mới bấm link đã gỡ → không vào được.
    _join_with_token(client, invite["token"], SUBSCRIBER2_CHAT, "nguoi_la", upd=32)
    subs = client.get("/api/v1/telegram/subscriptions", headers=auth_header).json()
    assert [s["chat_id"] for s in subs] == [SUBSCRIBER_CHAT]

    sent.clear()
    _run()
    assert SUBSCRIBER_CHAT in [c for c, _ in sent]


def test_subscriber_and_assignee_both_receive(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Chỉ định theo email (khách cuối) và người nhận theo tài khoản (nhân viên) là
    HAI khái niệm khác nhau → cùng nhận, còn chủ tài khoản nhường cho khách."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(
        client, ws, "khach@example.com", days_left=2, owner_id=owner_id,
        notify_telegram_target=str(ASSIGNEE_CHAT), notify_telegram_chat_id=ASSIGNEE_CHAT,
    )
    _invite_and_join(client, auth_header, SUBSCRIBER_CHAT, "nhan_vien")

    sent.clear()
    _run()

    assert sorted(c for c, _ in sent) == sorted([ASSIGNEE_CHAT, SUBSCRIBER_CHAT])


# ── Nút "Thông báo": link theo TỪNG email ─────────────────────────────────────


def test_member_notify_link_binds_recipient(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Đại lý bấm 'Thông báo' trên email → gửi link cho khách → khách bấm Start là
    nhận nhắc cho ĐÚNG email đó (không phải gõ /email)."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    resp = client.post(
        "/api/v1/telegram/notify-link", json={"member_id": member_id}, headers=auth_header
    )
    assert resp.status_code == 200, resp.text
    token = resp.json()["token"]
    assert resp.json()["deep_link"] == f"https://t.me/my_test_bot?start={token}"

    _webhook(
        client,
        {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": ASSIGNEE_CHAT, "type": "private"},
                "from": {"id": ASSIGNEE_CHAT, "username": "khach_vip", "first_name": "Khach"},
                "text": f"/start {token}",
            },
        },
    )
    with SessionLocal() as db:
        member = db.get(Member, member_id)
        assert member.notify_telegram_chat_id == ASSIGNEE_CHAT
        assert member.notify_telegram_target == "@khach_vip"
    assert "khach@example.com" in sent[-1][1]

    sent.clear()
    _run()
    assert [c for c, _ in sent] == [ASSIGNEE_CHAT]


def test_member_notify_link_reply_lists_all_watched_emails(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    """Khách theo dõi nhiều email → lời chào liệt kê ĐỦ danh sách, không chỉ email
    vừa bấm (một người thường mua vài tài khoản)."""
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "email-cu@example.com", days_left=5, owner_id=owner_id)
    moi_id = _add_member(client, ws, "email-moi@example.com", days_left=2, owner_id=owner_id)

    _start_bot(client, ASSIGNEE_CHAT, "khach_vip")
    _send_cmd(client, ASSIGNEE_CHAT, "/email email-cu@example.com", "khach_vip")

    token = client.post(
        "/api/v1/telegram/notify-link", json={"member_id": moi_id}, headers=auth_header
    ).json()["token"]
    sent.clear()
    _webhook(
        client,
        {
            "update_id": 3,
            "message": {
                "message_id": 3,
                "chat": {"id": ASSIGNEE_CHAT, "type": "private"},
                "from": {"id": ASSIGNEE_CHAT, "username": "khach_vip", "first_name": "Khach"},
                "text": f"/start {token}",
            },
        },
    )
    reply = sent[-1][1]
    assert "Email bạn sẽ nhận thông báo (2)" in reply
    assert "email-cu@example.com" in reply and "email-moi@example.com" in reply


def test_member_notify_link_respects_existing_recipient(
    client: TestClient, auth_header: dict, bot_on, sent, monkeypatch
) -> None:
    monkeypatch.setattr(bot_on, "telegram_bot_username", "my_test_bot")
    ws = _make_ws(client, auth_header)
    member_id = _add_member(
        client, ws, "khach@example.com", days_left=2,
        notify_telegram_target=str(ASSIGNEE_CHAT), notify_telegram_chat_id=ASSIGNEE_CHAT,
    )
    token = client.post(
        "/api/v1/telegram/notify-link", json={"member_id": member_id}, headers=auth_header
    ).json()["token"]

    _webhook(
        client,
        {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "chat": {"id": 707070, "type": "private"},
                "from": {"id": 707070, "username": "ke_gian", "first_name": "X"},
                "text": f"/start {token}",
            },
        },
    )
    with SessionLocal() as db:
        assert db.get(Member, member_id).notify_telegram_chat_id == ASSIGNEE_CHAT
    assert "đã được đăng ký" in sent[-1][1]


# ── Mẫu nội dung tự soạn ──────────────────────────────────────────────────────


def test_custom_template_applied_to_messages(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Mẫu riêng của đại lý áp cho tin nhắc email của họ (kể cả tin gửi khách)."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)

    resp = client.put(
        "/api/v1/telegram/template",
        json={
            "body": "🔔 SHOP ABC — {count} tài khoản sắp hết hạn\n\n{items}\n\nZalo 0900 để gia hạn.",
            "item_line": "· {email} → {expiry}",
        },
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert "SHOP ABC" in resp.json()["preview"]

    _run()

    text = sent[0][1]
    assert text.startswith("🔔 SHOP ABC — 1 tài khoản sắp hết hạn")
    assert "· khach@example.com →" in text
    assert "Zalo 0900 để gia hạn." in text

    # Khôi phục mẫu gốc → tin quay về câu chữ hệ thống.
    client.put(
        "/api/v1/telegram/template", json={"body": None, "item_line": None}, headers=auth_header
    )
    tpl = client.get("/api/v1/telegram/template", headers=auth_header).json()
    assert tpl["body"] is None and "Nhắc gia hạn" in tpl["default_body"]


def test_template_rejects_unknown_placeholder(
    client: TestClient, auth_header: dict, bot_on
) -> None:
    resp = client.put(
        "/api/v1/telegram/template",
        json={"body": "Chào {ten_khach}, {items}"},
        headers=auth_header,
    )
    assert resp.status_code == 400
    assert "ten_khach" in str(resp.json()["detail"])


def test_template_without_items_still_lists_emails(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Quên {items} thì vẫn phải liệt kê email — tin thiếu danh sách là vô nghĩa."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)
    client.put(
        "/api/v1/telegram/template", json={"body": "Nhắc nhẹ nhé"}, headers=auth_header
    )

    _run()

    assert "khach@example.com" in sent[0][1]


def test_broken_html_template_falls_back_to_default(
    client: TestClient, auth_header: dict, bot_on, monkeypatch
) -> None:
    """HTML hỏng trong mẫu tự soạn → gửi lại bằng mẫu gốc, KHÔNG mất thông báo."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    _add_member(client, ws, "khach@example.com", days_left=2, owner_id=owner_id)
    client.put(
        "/api/v1/telegram/template",
        json={"body": "<b>Chưa đóng thẻ {items}"},
        headers=auth_header,
    )

    delivered: list[str] = []

    def picky_send(chat_id: int, html_text: str):
        if "<b>Chưa đóng thẻ" in html_text:
            raise telegram.TelegramError(
                "unknown", "Bad Request: can't parse entities: Unclosed start tag"
            )
        delivered.append(html_text)
        return telegram.SentMessage(chat_id=chat_id, message_id=1)

    monkeypatch.setattr(telegram, "send_message", picky_send)

    _run()

    assert len(delivered) == 1
    assert "Nhắc gia hạn" in delivered[0]
    assert "khach@example.com" in delivered[0]
    assert _statuses() == [("sent", 3, "owner")]


def test_email_command_rate_limited(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Chống DÒ email: quá nhiều lần thử trong cửa sổ ngắn thì chặn."""
    from app.routers import telegram as tele_router

    tele_router._email_cmd_hits.clear()
    _start_bot(client, 818181, "ai_do")
    for i in range(tele_router._EMAIL_CMD_MAX + 2):
        _send_cmd(client, 818181, f"/email thu{i}@example.com", "ai_do")

    assert "quá nhiều lần" in sent[-1][1]


# ── Mẫu theo PHẠM VI: tất cả / một người nhận / một email ─────────────────────


def test_template_scope_member_beats_chat_beats_all(
    client: TestClient, auth_header: dict, bot_on, sent
) -> None:
    """Cụ thể hơn thì thắng: mẫu theo email > mẫu theo người nhận > mẫu chung."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    riêng = _add_member(
        client, ws, "rieng@example.com", days_left=2, owner_id=owner_id,
        notify_telegram_chat_id=ASSIGNEE_CHAT, notify_telegram_target="@khach",
    )
    _add_member(
        client, ws, "chung@example.com", days_left=2, owner_id=owner_id,
        notify_telegram_chat_id=ASSIGNEE_CHAT, notify_telegram_target="@khach",
    )

    for payload in (
        {"scope": "all", "body": "CHUNG {items}", "item_line": "· {email}"},
        {
            "scope": "chat",
            "chat_id": ASSIGNEE_CHAT,
            "body": "THEO NGƯỜI NHẬN {items}",
            "item_line": "· {email}",
        },
        {
            "scope": "member",
            "member_id": riêng,
            "body": "THEO EMAIL {items}",
            "item_line": "· {email}",
        },
    ):
        resp = client.put("/api/v1/telegram/template", json=payload, headers=auth_header)
        assert resp.status_code == 200, resp.text

    # Tin về ĐÚNG email có mẫu riêng → mẫu theo email.
    with SessionLocal() as db:
        db.query(Member).filter(Member.email == "chung@example.com").update(
            {"subscription_end_at": _now() + timedelta(days=60)}
        )
        db.commit()
    _run()
    assert sent[-1][1].startswith("THEO EMAIL")

    # Tin gộp cả hai email của cùng người nhận → rơi xuống mẫu theo người nhận.
    with SessionLocal() as db:
        db.query(TelegramNotification).delete()
        db.query(Member).filter(Member.email == "chung@example.com").update(
            {"subscription_end_at": _now() + timedelta(days=2)}
        )
        db.commit()
    _run()
    assert sent[-1][1].startswith("THEO NGƯỜI NHẬN")

    # Không còn mẫu theo người nhận → mẫu chung.
    client.put(
        "/api/v1/telegram/template",
        json={"scope": "chat", "chat_id": ASSIGNEE_CHAT, "body": None, "item_line": None},
        headers=auth_header,
    )
    with SessionLocal() as db:
        db.query(TelegramNotification).delete()
        db.commit()
    _run()
    assert sent[-1][1].startswith("CHUNG")


def test_template_scope_isolated_and_listed(
    client: TestClient, auth_header: dict, bot_on
) -> None:
    """Xoá mẫu của một phạm vi không đụng phạm vi khác; `overrides` liệt kê đủ."""
    owner_id = _link_owner()
    ws = _make_ws(client, auth_header)
    member_id = _add_member(client, ws, "a@example.com", days_left=30, owner_id=owner_id)

    client.put(
        "/api/v1/telegram/template", json={"scope": "all", "body": "CHUNG {items}"},
        headers=auth_header,
    )
    client.put(
        "/api/v1/telegram/template",
        json={"scope": "member", "member_id": member_id, "body": "RIÊNG {items}"},
        headers=auth_header,
    )

    out = client.get(
        f"/api/v1/telegram/template?scope=member&member_id={member_id}", headers=auth_header
    ).json()
    assert out["body"] == "RIÊNG {items}"
    # Chưa đặt mẫu riêng thì khởi điểm là mẫu chung, không phải mẫu gốc hệ thống.
    assert out["base_body"] == "CHUNG {items}"
    assert {(o["scope"], o["label"]) for o in out["overrides"]} == {
        ("all", None),
        ("member", "a@example.com"),
    }

    client.put(
        "/api/v1/telegram/template",
        json={"scope": "member", "member_id": member_id, "body": None, "item_line": None},
        headers=auth_header,
    )
    still = client.get("/api/v1/telegram/template?scope=all", headers=auth_header).json()
    assert still["body"] == "CHUNG {items}"
    assert [o["scope"] for o in still["overrides"]] == ["all"]


def test_template_scope_rejects_foreign_target(
    client: TestClient, auth_header: dict, bot_on
) -> None:
    """Không soạn được mẫu cho chat/email không phải của mình."""
    _link_owner()
    assert (
        client.put(
            "/api/v1/telegram/template",
            json={"scope": "chat", "chat_id": 999999, "body": "x {items}"},
            headers=auth_header,
        ).status_code
        == 404
    )
    assert (
        client.put(
            "/api/v1/telegram/template",
            json={"scope": "member", "member_id": str(uuid4()), "body": "x {items}"},
            headers=auth_header,
        ).status_code
        == 404
    )
    assert (
        client.put(
            "/api/v1/telegram/template",
            json={"scope": "chat", "body": "thiếu chat_id {items}"},
            headers=auth_header,
        ).status_code
        == 400
    )
