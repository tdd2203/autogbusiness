"""LỆNH MỜI XONG (COMPLETED) MÀ CÓ EMAIL KHÔNG SOI THẤY — hai bất biến.

Ca thật 3/9/2026 (CHATGPT PRO, task e29569d3, mẻ 2 email):

  14:44:45  mời 2 email → trừ 2×330k
  14:53–54  soi tab "Lời mời đang chờ" 4 lượt + tra tab "Người dùng" từng email:
            KHÔNG thấy email nào (danh sách 28 lời mời = 2 trang, lượt soi chỉ
            đọc trang đầu)
  14:55:13  `thanhtung...` mới mời <10′ nên được hoãn; `uochenchieudong` quá mốc
            ĐÚNG 28 GIÂY nên bị chốt hỏng NGAY: hoàn phí, xoá bản ghi, KHÔNG một
            dòng nhật ký nào mang tên email
  15:23     đồng bộ thấy email đó ĐANG Ở TRONG TEAM ⇒ phải gỡ tay rồi mời lại,
            khách trả phí lần hai

Hai chỗ phải sửa, mỗi chỗ một bất biến ở đây:

1. CHỐT HỎNG THÌ PHẢI GHI NHẬT KÝ. Nhánh task FAILED và nhánh resolver đều ghi
   `MEMBER_INVITE_FAILED`; riêng nhánh COMPLETED-unverified thì hoàn phí + xoá
   bản ghi trong im lặng, người đi tra không còn gì để đọc.
2. CẢ MẺ ĐI ĐƯỢC THÌ KHÔNG LỖI LẺ MỘT EMAIL. Mời một mẻ là MỘT cú bấm Gửi, nên
   còn anh em cùng mẻ đã xác minh (hoặc đang hoãn) ⇒ email này cũng được hoãn
   chờ bằng chứng thật, không chốt hỏng theo một lượt đọc.

NGOẠI LỆ giữ nguyên: email KHÔNG NHẬP ĐƯỢC vào ô mời (`skipped_emails`) chưa nằm
trong cú bấm Gửi nào cả — bằng chứng DƯƠNG rằng nó chưa đi, không được ăn theo mẻ.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID

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


def _bulk(client: TestClient, token: str, ws_id: str, emails: list[str]) -> str:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member", "subscription_months": 1},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()["queue_item_id"]


def _member(ws_id: str, email: str):
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        return (
            db.query(Member)
            .filter(Member.workspace_id == UUID(ws_id), Member.email == email)
            .one_or_none()
        )


def _events(member_id: str) -> list:
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        return list(
            db.query(AuditLog)
            .filter(AuditLog.target_type == "MEMBER", AuditLog.target_id == member_id)
            .all()
        )


def _actions(member_id: str) -> list[str]:
    return [e.action for e in _events(member_id)]


def _age(ws_id: str, emails: list[str], minutes: int = 20) -> None:
    """Đẩy mốc mời của các email ra ngoài hàng rào 10 phút của phantom-cleanup."""
    from app.db import SessionLocal
    from app.models import Member

    past = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    with SessionLocal() as db:
        for m in (
            db.query(Member)
            .filter(Member.workspace_id == UUID(ws_id), Member.email.in_(emails))
            .all()
        ):
            m.created_at = past
            m.last_invited_at = past
        db.commit()


def _complete(client: TestClient, ws: dict, item_id: str, result: dict) -> None:
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={"status": "COMPLETED", "result": result},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def test_chot_hong_email_le_thi_ghi_nhat_ky_truoc_khi_xoa(
    client: TestClient, auth_header: dict
) -> None:
    """Lời mời LẺ không soi thấy ⇒ vẫn hoàn phí + xoá bản ghi như cũ, NHƯNG phải
    để lại `MEMBER_INVITE_FAILED` mang tên email và mã lỗi đọc được."""
    ws = create_ws(client, auth_header, "AuditGap WS")
    sub = make_beta_sub(client, auth_header, username="auditgap1", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    email = "gap1@example.com"
    item_id = _bulk(client, sub["token"], ws["id"], [email])
    assert wallet_of(client, sub["token"])["balance"] == 0
    member_id = str(_member(ws["id"], email).id)
    _age(ws["id"], [email])

    _complete(client, ws, item_id, {"unverified_emails": [email]})

    assert _member(ws["id"], email) is None, "hỏng thật thì vẫn xoá bản ghi"
    assert wallet_of(client, sub["token"])["balance"] == FEE, "vẫn hoàn phí như cũ"
    events = _events(member_id)
    failed = [e for e in events if e.action == "MEMBER_INVITE_FAILED"]
    assert failed, "chốt hỏng mà không ghi nhật ký thì không ai tra được"
    data = failed[0].data or {}
    assert data.get("email") == email
    assert data.get("error_code") == "INVITE_NOT_FOUND_BY_SYNC"
    assert data.get("queue_item_id") == item_id


def test_email_khong_nhap_duoc_ghi_dung_ly_do(
    client: TestClient, auth_header: dict
) -> None:
    """`skipped_emails` = chưa hề gõ vào ô mời ⇒ nhật ký phải nói ĐÚNG lý do đó,
    không dùng chung câu 'không thấy trong danh sách chờ'."""
    ws = create_ws(client, auth_header, "Skipped WS")
    sub = make_beta_sub(client, auth_header, username="skipped1", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    email = "skip1@example.com"
    item_id = _bulk(client, sub["token"], ws["id"], [email])
    member_id = str(_member(ws["id"], email).id)

    _complete(
        client,
        ws,
        item_id,
        {"unverified_emails": [email], "skipped_emails": [email]},
    )

    failed = [e for e in _events(member_id) if e.action == "MEMBER_INVITE_FAILED"]
    assert failed, "email chưa nhập được cũng phải có dòng chốt hỏng"
    assert (failed[0].data or {}).get("error_code") == "INVITE_NOT_TYPED"


def test_cung_me_voi_email_xac_minh_thi_hoan_phan_xu_thay_vi_chot_hong(
    client: TestClient, auth_header: dict
) -> None:
    """Mẻ 2 email, một email xác minh xong: email còn lại (đã quá hàng rào 10′)
    KHÔNG được chốt hỏng — giữ bản ghi, giữ phí, chuyển sang chờ xác minh và cử
    đồng bộ đi xem. Đây chính là ca `uochenchieudong` ngày 3/9/2026."""
    from app.db import SessionLocal
    from app.models import QueueItem

    ws = create_ws(client, auth_header, "Solidarity Completed WS")
    sub = make_beta_sub(client, auth_header, username="solidc1", balance=2 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    ok_email, lost_email = "sc1@example.com", "sc2@example.com"
    item_id = _bulk(client, sub["token"], ws["id"], [ok_email, lost_email])
    assert wallet_of(client, sub["token"])["balance"] == 0
    lost_id = str(_member(ws["id"], lost_email).id)
    _age(ws["id"], [ok_email, lost_email])

    _complete(client, ws, item_id, {"unverified_emails": [lost_email]})

    assert _member(ws["id"], lost_email) is not None, (
        "cùng mẻ với email đã xác minh ⇒ KHÔNG được xoá bản ghi"
    )
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "không được hoàn phí khi cú bấm Gửi đã chứng minh là trót lọt"
    )
    actions = _actions(lost_id)
    assert "MEMBER_INVITE_PENDING_VERIFY" in actions, "phải chuyển sang chờ xác minh"
    assert "MEMBER_INVITE_FAILED" not in actions, "không được chốt hỏng"

    with SessionLocal() as db:
        probes = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == UUID(ws["id"]),
                QueueItem.type == "SYNC_MEMBERS_BATCH",
            )
            .all()
        )
    assert probes, "hoãn thì phải cử đồng bộ đi xem tận nơi"
    assert lost_email in (probes[0].payload or {}).get("emails", [])


def test_email_khong_nhap_duoc_khong_an_theo_me(
    client: TestClient, auth_header: dict
) -> None:
    """Anh em cùng mẻ xác minh KHÔNG cứu được email chưa gõ vào ô mời: đó là bằng
    chứng dương rằng lời mời chưa đi ⇒ vẫn chốt hỏng + hoàn phí."""
    ws = create_ws(client, auth_header, "Skipped Sibling WS")
    sub = make_beta_sub(client, auth_header, username="skipsib1", balance=2 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    ok_email, skipped = "ss1@example.com", "ss2@example.com"
    item_id = _bulk(client, sub["token"], ws["id"], [ok_email, skipped])
    skipped_id = str(_member(ws["id"], skipped).id)

    _complete(
        client,
        ws,
        item_id,
        {"unverified_emails": [skipped], "skipped_emails": [skipped]},
    )

    assert _member(ws["id"], skipped) is None, "chưa gõ được vào ô mời thì phải xoá"
    assert wallet_of(client, sub["token"])["balance"] == FEE, "và phải hoàn phí"
    assert "MEMBER_INVITE_FAILED" in _actions(skipped_id)


def test_dong_bo_khong_thay_nhung_anh_em_da_xac_minh_thi_giu_lai(
    client: TestClient, auth_header: dict
) -> None:
    """Lượt quét trả 'không thấy đâu cả' cho một email CÙNG MẺ với email đã xác
    minh ⇒ giữ tiền + giữ bản ghi, ghi `MEMBER_INVITE_BATCH_HOLD` cho admin xử
    tay. Một lượt đọc hụt không lật ngược được bằng chứng cú Gửi đã trót lọt."""
    from app.db import SessionLocal
    from app.models import QueueItem

    ws = create_ws(client, auth_header, "Hold On None WS")
    sub = make_beta_sub(client, auth_header, username="holdnone1", balance=2 * FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    ok_email, lost_email = "hn1@example.com", "hn2@example.com"
    item_id = _bulk(client, sub["token"], ws["id"], [ok_email, lost_email])
    lost_id = str(_member(ws["id"], lost_email).id)
    _age(ws["id"], [ok_email, lost_email])
    _complete(client, ws, item_id, {"unverified_emails": [lost_email]})

    with SessionLocal() as db:
        probe = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == UUID(ws["id"]),
                QueueItem.type == "SYNC_MEMBERS_BATCH",
            )
            .first()
        )
        probe_id = str(probe.id)

    r = client.patch(
        f"/api/v1/queue/{probe_id}",
        json={
            "status": "COMPLETED",
            "result": {"data": {"results": [{"email": lost_email, "found_in": "none"}]}},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text

    assert _member(ws["id"], lost_email) is not None, "không được xoá bản ghi"
    assert wallet_of(client, sub["token"])["balance"] == 0, "không được hoàn phí"
    actions = _actions(lost_id)
    assert "MEMBER_INVITE_BATCH_HOLD" in actions, "phải ghi lý do giữ lại"
    assert "MEMBER_INVITE_FAILED" not in actions
