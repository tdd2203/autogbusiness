"""Bất biến TIỀN: PHÍ ĐI THEO TASK, KẾT LUẬN "HỎNG" ĐI THEO EMAIL — chốt hỏng cho
email nào thì phải đóng luôn khoản phí còn treo của email đó.

Ca thật production 22/8/2026 (mất 330k, chủ hệ thống phải cộng tay bù cho đại lý);
chi tiết định danh nằm ở `app/routers/queue/completion.md` §5, không ghi ở đây vì
repo là PUBLIC:

  18:20  mời email X → trừ 330.000đ → task A FAILED `VERIFY_FAILED` NHƯNG đã bấm Gửi
         ⇒ `defer_unverified_invite` hoãn phán xử (ĐÚNG): phí giữ lại, member còn
         'pending', chờ resolver 20′ chốt bằng bằng chứng.
  18:28  admin bấm "Mời lại" X → task B MIỄN PHÍ, cũng FAILED (`NOT_ENOUGH_SEATS`,
         lỗi TRƯỚC lúc bấm Gửi) ⇒ `reconcile_failed_invite`: ghi MEMBER_INVITE_FAILED,
         xoá member pending, hoàn phí CỦA CHÍNH NÓ = 0đ.
  ⇒ 330k của task A mồ côi: resolver 20′ bỏ qua vĩnh viễn vì member đã bị xoá VÀ đã
    có audit `MEMBER_INVITE_FAILED` sau mốc defer — đúng 2 điều kiện SKIP của nó.
    Hệ thống thu 330k, khách không có ghế, không một tín hiệu nào.

Mặt còn lại phải giữ nguyên: phí của lời mời ĐÃ ĐI ĐƯỢC (email được verify / member
đang `active`) TUYỆT ĐỐI không được hoàn ké theo — xem test cuối file.

⚠️ CẬP NHẬT 28/8/2026 — ca thật dùng mã `NOT_ENOUGH_SEATS`, nhưng mã đó nay đi
đường riêng: hết suất thì GIỮ tiền và để lại phiếu dùng được cho chính email đó
(`test_invite_seat_credit.py`). Bất biến của file này không đổi và cũng không hề
phụ thuộc mã lỗi — nó nói: **chốt hỏng cho một email thì không được vừa giữ tiền
vừa xoá sạch dấu vết của email đó**. Nên ở đây dùng một mã lỗi trước-lúc-bấm-Gửi
khác (`UI_ELEMENT_NOT_FOUND`) để tiếp tục khoá đúng đường hoàn phí mồ côi.
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
EMAIL = "stranded@example.com"


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


def _member_id(ws_id: str) -> str | None:
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(
                Member.workspace_id == uuid.UUID(ws_id),
                Member.email == EMAIL,
            )
            .one_or_none()
        )
        return None if m is None else str(m.id)


def _reinvite_item(client: TestClient, token: str, ws_id: str, member_id: str) -> str:
    """Bấm "Mời lại" (còn hạn ⇒ MIỄN PHÍ) → trả id của task mời mới sinh ra."""
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/{member_id}/re-invite",
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text

    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        row = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws_id),
                QueueItem.type == "INVITE_MEMBER",
            )
            .order_by(QueueItem.created_at.desc())
            .first()
        )
        return str(row.id)


def _fail(client: TestClient, api_key: str, item_id: str, **result) -> None:
    body: dict = {"status": "FAILED", "error_code": result.pop("error_code", "UI_ELEMENT_NOT_FOUND")}
    if result:
        body["result"] = result
    r = client.patch(
        f"/api/v1/queue/{item_id}", json=body, headers={"X-API-KEY": api_key}
    )
    assert r.status_code == 200, r.text


def test_failed_reinvite_also_refunds_stranded_deferred_fee(
    client: TestClient, auth_header: dict
) -> None:
    """Task B (mời lại, miễn phí) chốt hỏng ⇒ phí 330k còn treo của task A về ví."""
    ws = create_ws(client, auth_header, "Stranded WS")
    sub = make_beta_sub(client, auth_header, username="strandedsub", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    key = ws["extension_api_key"]

    # 1. Mời lần đầu → trừ phí.
    item_a = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0

    # 2. Task A hỏng SAU khi đã bấm Gửi → hoãn phán xử: phí GIỮ NGUYÊN (đúng).
    _fail(client, key, item_a, error_code="VERIFY_FAILED", submit_clicked=True)
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "đã bấm Gửi mà chưa có bằng chứng hỏng thì chưa được hoàn — xem "
        "test_invite_submitted_defer.py"
    )

    member_id = _member_id(ws["id"])
    assert member_id is not None, "đường hoãn phải GIỮ member để còn đối chiếu"

    # 3. "Mời lại" (miễn phí) rồi task đó cũng hỏng TRƯỚC lúc bấm Gửi.
    item_b = _reinvite_item(client, sub["token"], ws["id"], member_id)
    assert item_b != item_a
    assert wallet_of(client, sub["token"])["balance"] == 0, "mời lại còn hạn = miễn phí"
    _fail(client, key, item_b, error_code="UI_ELEMENT_NOT_FOUND")

    # 4. Chốt hỏng cho EMAIL đó ⇒ khoản treo của task A phải quay về ví.
    assert wallet_of(client, sub["token"])["balance"] == FEE, (
        "THẤT THOÁT: task mời-lại-miễn-phí chốt hỏng nhưng chỉ hoàn phí của chính nó "
        "(0đ), bỏ mồ côi phí của lần mời TRẢ TIỀN trước đó — ca thật 22/8/2026"
    )
    txns = client.get(
        "/api/v1/wallet/transactions", headers=bearer(sub["token"])
    ).json()["items"]
    refunds = [t for t in txns if t["kind"] == "invite_refund"]
    assert len(refunds) == 1, "hoàn đúng MỘT lần cho khoản treo"
    assert refunds[0]["ref_id"] == item_a, "phải hoàn đúng khoản của task A"

    # 5. Idempotent: chốt lại lần nữa không được hoàn thêm đồng nào.
    _fail(client, key, item_b, error_code="UI_ELEMENT_NOT_FOUND")
    assert wallet_of(client, sub["token"])["balance"] == FEE


def test_verified_invite_fee_is_never_swept_by_a_later_failure(
    client: TestClient, auth_header: dict
) -> None:
    """Mặt đối xứng: lời mời ĐÃ ĐI ĐƯỢC (member `active`) thì phí là thu đúng — cú
    mời-lại hỏng sau đó KHÔNG được kéo nó về ví."""
    ws = create_ws(client, auth_header, "Stranded WS 2")
    sub = make_beta_sub(client, auth_header, username="strandedsub2", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])
    key = ws["extension_api_key"]

    item_a = _invite(client, sub["token"], ws["id"])
    assert wallet_of(client, sub["token"])["balance"] == 0

    # Task A hỏng-nhưng-đã-submit → hoãn phán xử, member giữ 'pending'.
    _fail(client, key, item_a, error_code="VERIFY_FAILED", submit_clicked=True)
    member_id = _member_id(ws["id"])
    assert member_id is not None

    # Admin bấm "Mời lại", RỒI đồng bộ mới thấy email đã ở trong team (lời mời lần
    # đầu tới nơi thật, chỉ là extension không xác minh kịp) → member 'active'.
    item_b = _reinvite_item(client, sub["token"], ws["id"], member_id)

    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.query(Member).filter(Member.id == uuid.UUID(member_id)).one()
        m.status = "active"
        db.commit()

    _fail(client, key, item_b, error_code="NOT_ENOUGH_SEATS")

    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "member đang `active` = ghế dùng thật ⇒ phí thu đúng, không được hoàn ké"
    )
