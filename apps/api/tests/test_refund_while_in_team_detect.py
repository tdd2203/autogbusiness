"""DÒ "ĐÃ HOÀN PHÍ MÀ EMAIL VẪN Ở TRONG TEAM" (ca sonvvng@gmail.com 15/8/2026).

Lời mời đi được THẬT (ChatGPT hiện toast thành công) nhưng vòng F5 không đọc kịp
danh sách → hệ thống chốt hỏng: hoàn phí về ví đại lý VÀ xoá luôn bản ghi member.
Đợt đồng bộ kế tiếp thấy email đang thật sự ở trong workspace nên dựng lại một dòng
member MỚI — dòng do sync đẻ ra không mang theo ký ức nào về tiền. Kết quả: email
dùng trọn 30 ngày mà cửa hàng không thu được đồng nào, và không một dòng nhật ký nào
nói ra điều đó (ba ca trước đều phải dò tay mới thấy, phát hiện 26/8/2026).

Lần sync dựng lại member CHÍNH LÀ lúc kết luận "mời hỏng" bị chứng minh là sai. File
này khoá `_flag_refunded_while_in_team` (members/reconcile.py) biến khoảnh khắc đó
thành 1 dòng nhật ký `MEMBER_REFUND_WHILE_IN_TEAM` đích danh kèm số tiền + ví.

Hệ thống KHÔNG tự trừ tiền: truy thu đẩy ví đại lý xuống âm và khoản âm sẽ nuốt lần
nạp kế tiếp — quyết định đó thuộc về chủ cửa hàng, không phải một callback đồng bộ.
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
EMAIL = "refunded-but-inside@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _invite(client: TestClient, token: str, ws_id: str) -> str:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member"},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()["queue_item_id"]


def _fail_invite(client: TestClient, ws: dict, item_id: str) -> None:
    """Extension báo hỏng KHÔNG kèm bằng chứng đã submit → chốt hỏng NGAY:
    ghi MEMBER_INVITE_FAILED + xoá phantom member + hoàn phí."""
    r = client.patch(
        f"/api/v1/queue/{item_id}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": "Không xác minh được",
            "result": {},
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code == 200, r.text


def _sync_sees_email(client: TestClient, ws: dict, status: str = "active") -> dict:
    """Đồng bộ: ChatGPT VẪN trả về email — bằng chứng lời mời đã đi được."""
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": EMAIL, "status": status}], "is_full_sync": False},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


def _alerts():
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        return (
            db.query(AuditLog)
            .filter(
                AuditLog.action == "MEMBER_REFUND_WHILE_IN_TEAM",
                AuditLog.data["email"].astext == EMAIL,
            )
            .all()
        )


def _refund_txn():
    from app.db import SessionLocal
    from app.models import WalletTransaction

    with SessionLocal() as db:
        return (
            db.query(WalletTransaction)
            .filter(
                WalletTransaction.kind == "invite_refund",
                WalletTransaction.meta["email"].astext == EMAIL,
            )
            .one()
        )


def _refunded_invite(client: TestClient, auth_header: dict, ws: dict, sub: dict) -> None:
    """Dựng đúng hiện trường: mời → thu phí → chốt hỏng → hoàn phí → member bị xoá."""
    item_id = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0
    _fail_invite(client, ws, item_id)
    assert wallet_of(client, sub["token"])["balance"] == FEE


def test_sync_thay_email_da_hoan_phi_thi_bao_no_can_truy_thu(
    client: TestClient, auth_header: dict
) -> None:
    """GUARD chính: hoàn phí xong mà ChatGPT vẫn giữ email ⇒ ghi cảnh báo đích danh
    kèm số tiền + ví, và trả email trong `refund_debt_emails` để dashboard nói ra."""
    ws = create_ws(client, auth_header, "WS hoàn oan")
    sub = make_beta_sub(client, auth_header, username="refunddebt1", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    _refunded_invite(client, auth_header, ws, sub)
    txn = _refund_txn()

    body = _sync_sees_email(client, ws)

    assert body["refund_debt_emails"] == [EMAIL], body
    alerts = _alerts()
    assert len(alerts) == 1, [a.data for a in alerts]
    alert = alerts[0]
    assert alert.result == "ERROR"
    assert alert.actor_type == "SYSTEM"
    assert alert.data["amount"] == FEE
    assert alert.data["refund_txn_id"] == str(txn.id)
    assert alert.data["user_id"] == sub["id"]
    assert alert.data["error_code"] == "VERIFY_FAILED"
    # Cảnh báo phải neo vào ĐÚNG member vừa được sync dựng lại, để timeline trong
    # modal chi tiết thành viên hiện nó ra.
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        member = (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws["id"]), Member.email == EMAIL
            )
            .one()
        )
    assert alert.target_id == str(member.id)
    # Tuyệt đối KHÔNG tự trừ tiền: ví đại lý phải còn nguyên khoản vừa hoàn.
    assert wallet_of(client, sub["token"])["balance"] == FEE


def test_khong_bao_trung_o_cac_lan_sync_sau(
    client: TestClient, auth_header: dict
) -> None:
    """Đồng bộ chạy hàng ngày; mỗi lần hoàn oan chỉ được đúng 1 dòng cảnh báo, kẻo
    nhật ký ngập báo động lặp và người đọc bỏ qua luôn cái thật."""
    ws = create_ws(client, auth_header, "WS lặp")
    sub = make_beta_sub(client, auth_header, username="refunddebt2", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    _refunded_invite(client, auth_header, ws, sub)

    _sync_sees_email(client, ws)
    body2 = _sync_sees_email(client, ws)

    assert body2["refund_debt_emails"] == []
    assert len(_alerts()) == 1


def test_khong_bao_khi_da_truy_thu_bang_but_toan_adjust(
    client: TestClient, auth_header: dict
) -> None:
    """Đã truy thu rồi thì món nợ đã xong — nhắc lại là báo động giả.

    Nhận diện theo HÌNH DẠNG bút toán (`adjust` âm đúng số đã hoàn, cùng email, sau
    lần hoàn) chứ không theo một khoá `meta` cố định: ba lần truy thu tay trên
    production mỗi lần đánh dấu một kiểu (`recollect_of`, `member_id` +
    `manual_invite_at`…) nên bắt theo khoá là bỏ sót."""
    from app.db import SessionLocal
    from app.models import Wallet, WalletTransaction

    ws = create_ws(client, auth_header, "WS đã truy thu")
    sub = make_beta_sub(client, auth_header, username="refunddebt3", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    _refunded_invite(client, auth_header, ws, sub)
    txn = _refund_txn()
    with SessionLocal() as db:
        wallet = db.get(Wallet, txn.wallet_id)
        wallet.balance -= FEE
        db.add(
            WalletTransaction(
                wallet_id=txn.wallet_id,
                user_id=txn.user_id,
                kind="adjust",
                amount=-FEE,
                balance_after=wallet.balance,
                meta={
                    "email": EMAIL,
                    "reason": "Truy thu phí mời đã hoàn oan",
                    "recollect_of": "invite_refund",
                },
            )
        )
        db.commit()

    body = _sync_sees_email(client, ws)

    assert body["refund_debt_emails"] == []
    assert _alerts() == []


def test_khong_bao_khi_moi_hong_ma_khong_he_hoan_phi(
    client: TestClient, auth_header: dict
) -> None:
    """Super-admin mời (không qua ví) → chốt hỏng không sinh bút toán hoàn nào.
    Không có tiền nào đi ra thì chẳng ai nợ ai — không được ghi cảnh báo."""
    ws = create_ws(client, auth_header, "WS không ví")
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member"},
        headers=auth_header,
    )
    assert r.status_code == 202, r.text
    _fail_invite(client, ws, r.json()["queue_item_id"])

    body = _sync_sees_email(client, ws)

    assert body["refund_debt_emails"] == []
    assert _alerts() == []


def test_me_nhieu_email_thi_ghep_dung_tien_cua_tung_email(
    client: TestClient, auth_header: dict
) -> None:
    """Mẻ mời nhiều email hỏng cả mẻ → mỗi email một bút toán hoàn riêng. Cảnh báo
    phải ghép ĐÚNG tiền của từng email, không lẫn sang nhau.

    Mọi test trên đều chỉ có 1 email nên đường nhiều email chưa được che — mà đó
    chính là hình dạng thật của các mẻ mời ngoài đời (5 email/mẻ)."""
    email_a = "batch-a@example.com"
    email_b = "batch-b@example.com"
    ws = create_ws(client, auth_header, "WS mẻ nhiều email")
    sub = make_beta_sub(client, auth_header, username="refunddebt4", balance=FEE * 2)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": [email_a, email_b], "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 202, r.text
    assert wallet_of(client, sub["token"])["balance"] == 0
    _fail_invite(client, ws, r.json()["queue_item_id"])
    assert wallet_of(client, sub["token"])["balance"] == FEE * 2

    resp = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={
            "members": [
                {"email": email_a, "status": "active"},
                {"email": email_b, "status": "pending"},
            ],
            "is_full_sync": False,
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code in (200, 201), resp.text

    assert sorted(resp.json()["refund_debt_emails"]) == [email_a, email_b]
    from app.db import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as db:
        alerts = (
            db.query(AuditLog)
            .filter(
                AuditLog.action == "MEMBER_REFUND_WHILE_IN_TEAM",
                AuditLog.data["email"].astext.in_([email_a, email_b]),
            )
            .all()
        )
    assert len(alerts) == 2, [a.data for a in alerts]
    # Mỗi cảnh báo neo vào bút toán hoàn CỦA CHÍNH email đó, không dùng chung.
    by_email = {a.data["email"]: a.data for a in alerts}
    assert by_email[email_a]["amount"] == FEE
    assert by_email[email_b]["amount"] == FEE
    assert (
        by_email[email_a]["refund_txn_id"] != by_email[email_b]["refund_txn_id"]
    ), "hai email dùng chung một bút toán hoàn ⇒ ghép sai tiền"
