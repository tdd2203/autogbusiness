"""Bất biến TIỀN: CHƯA AI ĐI XEM THÌ KHÔNG ĐƯỢC HOÀN PHÍ.

Ca thật 28-29/8/2026 (GPT1 + CHATGPT PRO, 12 email, 3.960.000đ hoàn oan):

  28/8 15:08  mời mẻ 8 email → trừ 8×330k
  28/8 15:16  extension timeout 300s ở Phase A' (mời ngoài tên miền) rồi salvage:
              quét tab "Lời mời" chỉ ra 1/8 → 7 email vào diện `unverified_emails`
              kèm `needs_reload_retry: true` (HẾT NGÂN SÁCH, chưa kết luận xong)
  28/8 15:16  nhánh COMPLETED-defer giữ lại 7 bản ghi, ghi PENDING_VERIFY…
              …nhưng KHÔNG cử ai đi đối chiếu (khác hẳn nhánh FAILED-defer)
  28/8 16:18  resolver 20′ không thấy dấu vết đồng bộ nào → chốt hỏng, hoàn 7×330k,
              void kỳ, XOÁ 7 bản ghi
  29/8 10:34  auto-sync (1 lần/ngày) quét ChatGPT: cả 7 email ĐANG Ở TRONG TEAM

Hai mắt xích đứt, test này giữ cả hai:
  1. Nhánh COMPLETED-defer không xếp `SYNC_MEMBERS_BATCH` ⇒ bằng chứng không bao giờ
     tới ⇒ nhánh "đồng bộ đã thấy" của resolver là code chết.
  2. Resolver coi "hết 20′ mà không có bằng chứng" ngang với "có bằng chứng hỏng".
     Không có ai đi xem thì đó là ĐOÁN, không phải kết luận.

Giả định tự lành ghi ở `STALE_PENDING_INVITE_WINDOW` ("chốt oan thì sync kế tiếp thấy
rogue pending → extension auto-revoke") cũng sai: email đã ACTIVE không còn là rogue
pending, không ai thu hồi — khách dùng tiếp miễn phí, im lặng.
"""

import uuid
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
EMAIL = "blindrefund@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _invite(client: TestClient, token: str, ws_id: str) -> str:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member", "subscription_months": 1},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()["queue_item_id"]


def _complete_unverified(client: TestClient, ws: dict, item_id: str) -> None:
    """Kết thúc task y như ca thật: COMPLETED nhưng email lọt `unverified_emails`
    (vòng verify hết ngân sách F5, chưa kết luận được gì)."""
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "COMPLETED",
            "result": {
                "unverified_emails": [EMAIL],
                "needs_reload_retry": True,
                "verify_scrape_failed": False,
            },
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def _member(ws_id: str):
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        return (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws_id), Member.email == EMAIL)
            .one_or_none()
        )


def _actions(member_id: str) -> list[str]:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        return [
            r.action
            for r in db.query(AuditLog)
            .filter(AuditLog.target_type == "MEMBER", AuditLog.target_id == member_id)
            .all()
        ]


def _sync_batches(ws_id: str) -> list:
    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        return (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws_id),
                QueueItem.type == "SYNC_MEMBERS_BATCH",
            )
            .all()
        )


def _age_defer_event(member_id: str, minutes: int = 30) -> datetime:
    from app.db import SessionLocal
    from app.models import AuditLog, Member

    past = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    with SessionLocal() as db:
        for row in (
            db.query(AuditLog)
            .filter(
                AuditLog.target_id == member_id,
                AuditLog.action == "MEMBER_INVITE_PENDING_VERIFY",
            )
            .all()
        ):
            row.timestamp = past
        m = db.get(Member, uuid.UUID(member_id))
        m.last_invited_at = past
        m.created_at = past
        db.commit()
    return past


def _setup_limbo(client: TestClient, auth_header: dict, name: str, user: str):
    """Mời 1 email → task COMPLETED-unverified → member kẹt 'chờ xác minh'."""
    ws = create_ws(client, auth_header, name)
    sub = make_beta_sub(client, auth_header, username=user, balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    item_id = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0, "mời phải trừ phí"
    _complete_unverified(client, ws, item_id)
    m = _member(ws["id"])
    assert m is not None and m.status == "pending"
    return ws, sub, str(m.id)


def test_completed_defer_enqueues_sync_probe(
    client: TestClient, auth_header: dict
) -> None:
    """Mắt xích 1: hoãn phán xử PHẢI cử người đi đối chiếu.

    Nhánh FAILED-defer vốn đã xếp `SYNC_MEMBERS_BATCH`; nhánh COMPLETED-defer thì
    không — nên bằng chứng cứu lời mời không bao giờ tới kịp resolver."""
    ws, _sub, member_id = _setup_limbo(client, auth_header, "Probe WS", "probe1")

    assert "MEMBER_INVITE_PENDING_VERIFY" in _actions(member_id)
    batches = _sync_batches(ws["id"])
    assert len(batches) == 1, (
        "hoãn xong phải xếp MỘT mẻ đồng bộ đi xem email có trong ChatGPT không — "
        "hoãn mà không ai đi đối chiếu thì 20′ sau resolver hoàn phí trong mù"
    )
    assert EMAIL in (batches[0].payload or {}).get("emails", []), (
        "mẻ đồng bộ phải nhắm đúng email đang treo"
    )


def test_resolver_does_not_refund_without_sync_evidence(
    client: TestClient, auth_header: dict
) -> None:
    """CỐT LÕI: quá 20′ mà CHƯA lượt đồng bộ nào đi xem ⇒ GIỮ NGUYÊN tiền + bản ghi.

    Đây đúng là ca 28/8: không có `last_synced_at` lẫn `sync_missing_at` mới hơn mốc
    hoãn, tức chưa ai nhìn vào ChatGPT lần nào kể từ lúc hoãn."""
    from app.main import _resolve_stale_pending_invites_once

    ws, sub, member_id = _setup_limbo(client, auth_header, "Blind WS", "blind1")
    _age_defer_event(member_id)

    _resolve_stale_pending_invites_once()

    assert _member(ws["id"]) is not None, (
        "chưa ai đi xem mà đã xoá bản ghi — lời mời có thể đã đi thật, xoá xong là "
        "mất luôn dấu vết để truy thu"
    )
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "HOÀN PHÍ MÙ: hết 20′ không phải bằng chứng lời mời hỏng"
    )
    assert "MEMBER_INVITE_FAILED" not in _actions(member_id), (
        "chưa có bằng chứng thì không được chấm 'Thất bại'"
    )


def test_blind_resolver_reprobes_instead_of_refunding(
    client: TestClient, auth_header: dict
) -> None:
    """Không chốt thì phải ĐI XEM: resolver xếp lại mẻ đồng bộ, không ngồi im.

    Nếu chỉ bỏ qua, lời mời treo vĩnh viễn cho tới lượt auto-sync (1 lần/ngày)."""
    from app.db import SessionLocal
    from app.main import _resolve_stale_pending_invites_once
    from app.models import QueueItem

    ws, _sub, member_id = _setup_limbo(client, auth_header, "Reprobe WS", "reprobe1")
    _age_defer_event(member_id)

    # Mẻ của lượt hoãn đã chạy xong (không thấy gì để lại) → resolver phải xếp mẻ mới.
    with SessionLocal() as db:
        for row in (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws["id"]),
                QueueItem.type == "SYNC_MEMBERS_BATCH",
            )
            .all()
        ):
            row.status = "COMPLETED"
        db.commit()

    _resolve_stale_pending_invites_once()

    pending = [b for b in _sync_batches(ws["id"]) if b.status == "PENDING"]
    assert pending, "phải xếp mẻ đồng bộ mới đi kiểm chứng thay vì hoàn phí mù"


def test_reprobe_names_every_blind_email_of_the_workspace(
    client: TestClient, auth_header: dict
) -> None:
    """Mẻ đi xem phải gọi tên ĐỦ email đang mù của workspace.

    `enqueue_sync_probe` dedup theo workspace: xếp mẻ ngay trong vòng lặp thì email
    đầu chiếm mất mẻ, các email còn lại của CÙNG mẻ mời không có tên trong payload —
    lại bỏ sót đúng kiểu đã gây ra ca 28/8 (mẻ 8 email, 7 cái rơi rụng)."""
    from app.db import SessionLocal
    from app.main import _resolve_stale_pending_invites_once
    from app.models import Member, QueueItem

    emails = ["blind-a@example.com", "blind-b@example.com", "blind-c@example.com"]
    ws = create_ws(client, auth_header, "MultiBlind WS")
    sub = make_beta_sub(client, auth_header, username="mblind1", balance=3 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": emails, "role": "member", "subscription_months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 202, r.text
    r = client.patch(
        f"/api/v1/queue/{r.json()['queue_item_id']}",
        json={"status": "COMPLETED", "result": {"unverified_emails": emails}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text

    with SessionLocal() as db:
        for m in (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws["id"]))
            .all()
        ):
            _age_defer_event(str(m.id))
        # Mẻ của lượt hoãn đã chạy xong → resolver phải xếp mẻ mới.
        for row in (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws["id"]),
                QueueItem.type == "SYNC_MEMBERS_BATCH",
            )
            .all()
        ):
            row.status = "COMPLETED"
        db.commit()

    _resolve_stale_pending_invites_once()

    pending = [b for b in _sync_batches(ws["id"]) if b.status == "PENDING"]
    assert len(pending) == 1, "một mẻ cho cả workspace là đủ"
    assert set((pending[0].payload or {}).get("emails", [])) == set(emails), (
        "mẻ đi xem phải gọi tên đủ email đang mù, không chỉ email đầu tiên"
    )
    assert wallet_of(client, sub["token"])["balance"] == 0, "vẫn không hoàn phí"


def test_blind_too_long_escalates_but_still_does_not_refund(
    client: TestClient, auth_header: dict
) -> None:
    """Mù quá lâu (extension tắt hẳn) → kêu lên Nhật ký cho người xử tay, VẪN không
    tự hoàn phí. Rút tiền/xoá bản ghi dựa trên một cái đồng hồ là chuyện đã mất
    3.960.000đ một lần rồi."""
    from app.main import _resolve_stale_pending_invites_once

    ws, sub, member_id = _setup_limbo(client, auth_header, "Escalate WS", "escal1")
    _age_defer_event(member_id, minutes=60 * 24)

    _resolve_stale_pending_invites_once()

    actions = _actions(member_id)
    assert "MEMBER_INVITE_UNVERIFIABLE" in actions, (
        "treo quá lâu không kiểm chứng được thì phải báo cho admin, đừng im lặng"
    )
    assert "MEMBER_INVITE_FAILED" not in actions
    assert wallet_of(client, sub["token"])["balance"] == 0, "vẫn KHÔNG tự hoàn phí"
    assert _member(ws["id"]) is not None

    # Kêu MỘT lần thôi — tick 10′ nào cũng ghi thì Nhật ký thành bãi rác.
    _resolve_stale_pending_invites_once()
    assert _actions(member_id).count("MEMBER_INVITE_UNVERIFIABLE") == 1
