"""Bất biến TIỀN (mặt ĐỐI XỨNG): KHÔNG HOÀN ĐỒNG NÀO ⇒ TUYỆT ĐỐI KHÔNG ĐƯỢC VOID KỲ.

`test_refund_voids_period.py` khoá chiều thuận (hoàn phí ⇒ phải huỷ hạn, kẻo mời lại
miễn phí oan). File này khoá chiều NGƯỢC LẠI — chiều mà bản vá 21/7 đã làm quá tay.

Ca thật trên production 23/8/2026 (khách mất trắng 330k) — chi tiết định danh
nằm ở `app/routers/queue/completion.md` §5, không ghi ở đây vì repo là PUBLIC:

  22/8 02:29:24  mời → trừ 330.000đ, task COMPLETED + verify OK, hạn tới 21/9
  23/8 02:49:29  admin bấm "Mời lại" → CÒN HẠN nên MIỄN PHÍ (không tạo invite_fee nào)
  23/8 02:49:34  task FAILED `FAILED_UI_CHANGED` (bộ đếm suất 150 ≠ dòng tỉ lệ 151,
                 lỗi xảy ra TRƯỚC lúc bấm Gửi → đi reconcile_failed_invite)
                 → `refund_invite` hoàn 0đ (đúng: task này chưa từng bị tính phí)
                 → nhưng `void_refunded_invite_periods` vẫn chạy theo payload task
                 ⇒ `subscription_end_at` = NGAY LÚC ĐÓ, xoá chu kỳ, cờ `unpaid`
  23/8 02:50:19  job auto-expire thấy "hết hạn" → enqueue REVOKE_INVITES
  23/8 02:50:55  extension gỡ khách khỏi workspace
  ⇒ 86 giây sau một cú "Mời lại" hỏng: khách mất ghế + mất 29 ngày đã trả, ví hoàn 0đ.

Gốc rễ: void nhận danh sách email TỪ PAYLOAD TASK thay vì từ KẾT QUẢ HOÀN PHÍ. Kỳ
hạn bị cắt ở đây do MỘT TASK KHÁC trả tiền, task hỏng này không liên quan. Bản vá:
`refund_invite` trả `InviteRefund(total_vnd, emails)`, mọi call site void đúng
`refunded.emails`.
"""

import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import assign, bearer, create_ws, make_beta_sub, set_settings, wallet_of

FEE = 100_000
EMAIL = "reinvite-free@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _member_row(ws_id: str, email: str):
    """Đọc thẳng DB: (id, status, hạn, cờ thanh toán, số kỳ 'paid')."""
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
            "id": str(m.id),
            "status": m.status,
            "end_at": m.subscription_end_at,
            "payment_status": m.payment_status,
            "paid_cycles": sum(
                1 for c in m.subscription_cycles if c.payment_status == "paid"
            ),
        }


def test_free_reinvite_failing_must_not_void_paid_period(
    client: TestClient, auth_header: dict
) -> None:
    """Mời lại MIỄN PHÍ mà hỏng → kỳ đã trả bằng lần mời TRƯỚC phải nguyên vẹn.

    Đây là ca thật 23/8/2026. Nếu hạn bị đẩy về hiện tại, job auto-expire sẽ gỡ khách
    khỏi workspace ngay lượt quét kế tiếp — mất ghế lẫn tiền, không có tín hiệu nào.
    """
    ws = create_ws(client, auth_header, "Reinvite WS")
    sub = make_beta_sub(client, auth_header, username="reinvsub", balance=FEE)
    assign(client, auth_header, ws["id"], sub["id"])

    # 1. Mời lần đầu → TRỪ phí, member pending + hạn dùng 1 tháng.
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"emails": [EMAIL], "role": "member"},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 202, r.text
    first_item = r.json()["queue_item_id"]
    assert wallet_of(client, sub["token"])["balance"] == 0, "mời lần đầu phải trừ phí"

    # 2. Lời mời lần đầu THÀNH CÔNG (đúng ca thật: 22/8 verify OK) → kỳ này đã trả tiền.
    ok = client.patch(
        f"/api/v1/queue/{first_item}",
        json={
            "status": "COMPLETED",
            "result": {
                "verified_count": 1,
                "verified_emails": [EMAIL],
                "unverified_count": 0,
                "unverified_emails": [],
                "verify_scrape_failed": False,
            },
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert ok.status_code == 200, ok.text

    paid = _member_row(ws["id"], EMAIL)
    assert paid is not None and paid["end_at"] is not None, (
        "mời tính phí phải tạo hạn dùng — không có thì test không chứng minh được gì"
    )
    end_before = paid["end_at"]
    assert end_before > datetime.now(timezone.utc), "hạn phải nằm ở TƯƠNG LAI"

    # 3. "Mời lại" khi CÒN HẠN → MIỄN PHÍ: không trừ ví, không sinh invite_fee nào.
    re_r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/{paid['id']}/re-invite",
        headers=bearer(sub["token"]),
    )
    assert re_r.status_code == 201, re_r.text
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "mời lại khi còn hạn là MIỄN PHÍ — không được trừ thêm"
    )

    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        second_item = str(
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws["id"]),
                QueueItem.type == "INVITE_MEMBER",
                QueueItem.id != uuid.UUID(first_item),
            )
            .order_by(QueueItem.created_at.desc())
            .first()
            .id
        )

    # 4. Task mời lại HỎNG TRƯỚC lúc bấm Gửi (không `submit_clicked` → KHÔNG hoãn
    #    phán xử, đi thẳng reconcile_failed_invite như ca thật).
    upd = client.patch(
        f"/api/v1/queue/{second_item}",
        json={
            "status": "FAILED",
            "error_code": "FAILED_UI_CHANGED",
            "error_message": (
                "Không đọc được số suất còn trống: bộ đếm 150 nhưng dòng tỉ lệ nói 151."
            ),
        },
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert upd.status_code == 200, upd.text

    # ── Bất biến 1: không hoàn đồng nào (đúng — task này chưa từng bị tính phí) ──
    assert wallet_of(client, sub["token"])["balance"] == 0, (
        "task mời lại miễn phí không có phí để hoàn — ví không được tự dôi tiền"
    )

    # ── Bất biến 2: kỳ ĐÃ TRẢ phải NGUYÊN VẸN ────────────────────────────────
    after = _member_row(ws["id"], EMAIL)
    assert after is not None, (
        "member đã tham gia thật (joined_at != NULL) — mời lại hỏng không được xoá"
    )
    assert after["end_at"] == end_before, (
        f"CƯỚP HẠN: hạn dùng bị đổi {end_before} → {after['end_at']} sau một cú mời "
        "lại HỎNG mà ví không hoàn đồng nào. Job auto-expire sẽ gỡ khách khỏi "
        "workspace trong vòng 1 phút (đúng ca thật 23/8/2026)."
    )
    assert after["end_at"] > datetime.now(timezone.utc), (
        "hạn phải còn ở tương lai — bị đẩy về hiện tại là auto-expire gỡ ngay"
    )
    assert after["payment_status"] != "unpaid", (
        "khách đã trả tiền kỳ này — mời lại hỏng không được lật cờ sang 'chưa thanh toán'"
    )
    assert after["paid_cycles"] >= 1, (
        "chu kỳ 'đã thanh toán' của lần mời TRƯỚC bị xoá — mất dấu vết tiền đã thu"
    )
