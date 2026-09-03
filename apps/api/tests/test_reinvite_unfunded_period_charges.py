"""HẠN SUÔNG KHÔNG PHẢI ĐÃ TRẢ TIỀN (ca `uochenchieudong` 3/9/2026, task e29569d3).

Chuỗi hôm đó: mời lúc 14:44 (thu 330.000đ) → 14:55 vòng verify đọc không ra email
nên chốt hỏng, HOÀN phí và xoá bản ghi → 15:23 đồng bộ thấy lời mời vẫn nằm trong
tab "Lời mời" nên DỰNG LẠI member, và dòng do sync đẻ ra được cấp luôn gói mặc định
30 ngày (`EXPIRY_RULES.md` §3.5) → 15:48 admin gỡ tay → 15:54 mời lại: hệ thống thấy
"còn hạn" nên MIỄN PHÍ. Email dùng trọn 30 ngày, cửa hàng thực thu 0đ.

`void_refunded_invite_periods` không cứu được: nó void đúng lúc hoàn phí, nhưng hạn
được dựng lại từ BÊN NGOÀI sau đó. Chốt chặn phải nằm ở chỗ QUYẾT ĐỊNH PHÍ —
`_is_paid_period_active` từ nay đòi kỳ đang chạy phải CÓ TIỀN phía sau
(`_period_is_funded`), không chỉ có mốc hạn.

Nhãn "đã trả" đọc từ nghiệp vụ (`payment_status` / chu kỳ `paid`), KHÔNG đọc sổ ví:
tài khoản được miễn phí (super-admin, đại lý chưa bật Ví) không có bút toán nào mà
vẫn phải được mời lại miễn phí — rà DB 3/9/2026: 721 member còn hạn thì 49 thuộc
nhóm này, bắt theo bút toán là cắt nhầm cả 49.
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
EMAIL = "sync-rebuilt@example.com"


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _bulk_invite(client: TestClient, token: str, ws_id: str, email: str) -> str:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": [email], "role": "member", "subscription_months": 1},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()["queue_item_id"]


def _fail_invite(client: TestClient, ws: dict, item_id: str) -> None:
    """Extension báo hỏng không kèm bằng chứng đã submit → chốt hỏng NGAY: hoàn phí
    + xoá bản ghi phantom (đúng cái đã xảy ra lúc 14:55)."""
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


def _sync_sees(client: TestClient, ws: dict, email: str, status: str = "pending") -> None:
    """Đồng bộ vẫn thấy email trên ChatGPT → dựng lại member kèm gói mặc định 30 ngày."""
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [{"email": email, "status": status}], "is_full_sync": False},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert r.status_code in (200, 201), r.text


def _member_row(email: str) -> dict:
    """Ảnh chụp các cột cần kiểm — đọc TRONG session, trả dict để test không chạm vào
    instance đã detach (`subscription_cycles` là relationship, lazy load ngoài session
    là nổ `DetachedInstanceError`)."""
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        m = db.query(Member).filter(Member.email == email).one()
        return {
            "id": str(m.id),
            "status": m.status,
            "payment_status": m.payment_status,
            "subscription_end_at": m.subscription_end_at,
            "cycles": len(m.subscription_cycles),
        }


def _invite_fees(client: TestClient, token: str) -> list[dict]:
    txns = client.get("/api/v1/wallet/transactions", headers=bearer(token)).json()["items"]
    return [t for t in txns if t["kind"] == "invite_fee"]


def test_han_do_dong_bo_dung_lai_thi_moi_lai_van_tru_tien(
    client: TestClient, auth_header: dict
) -> None:
    """GUARD CHÍNH: hoàn phí → sync dựng lại hạn → mời lại PHẢI trừ phí lần nữa.

    Trước 3/9/2026 lần mời lại này đi vào nhánh "còn hạn ⇒ miễn phí" và email dùng
    hết tháng mà không đồng nào vào sổ."""
    ws = create_ws(client, auth_header, "Sync Rebuilt WS")
    sub = make_beta_sub(client, auth_header, username="syncrebuilt", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _bulk_invite(client, sub["token"], ws["id"], EMAIL)
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE

    _fail_invite(client, ws, item_id)
    assert wallet_of(client, sub["token"])["balance"] == 300_000, "hoàn phí xong"

    # Đồng bộ dựng lại member — đây là chỗ "hạn ma" ra đời: có hạn tương lai, chưa
    # có kỳ nào, nhãn thanh toán mặc định `unpaid`.
    _sync_sees(client, ws, EMAIL)
    rebuilt = _member_row(EMAIL)
    assert rebuilt["subscription_end_at"] > datetime.now(timezone.utc)
    assert rebuilt["payment_status"] == "unpaid"
    assert rebuilt["cycles"] == 0

    _bulk_invite(client, sub["token"], ws["id"], EMAIL)
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE, (
        "kỳ chưa ai trả thì mời lại phải tính phí, không được ăn theo hạn do sync cấp"
    )
    assert len(_invite_fees(client, sub["token"])) == 2
    # Trả phí xong thì kỳ mới thành 'đã thanh toán' thật, không còn nợ treo.
    assert _member_row(EMAIL)["payment_status"] == "paid"


def test_moi_lai_van_mien_phi_khi_ky_da_co_tien(
    client: TestClient, auth_header: dict
) -> None:
    """Ranh giới ngược: email ĐÃ trả tiền, đi qua đúng vòng đồng bộ đó, vẫn phải
    được mời lại MIỄN PHÍ. Siết vế "có tiền" mà siết lố thì thành trừ phí hai lần
    cho một kỳ — đúng ca `phiastraliz123` 26/8 đã sửa."""
    email = "already-paid@example.com"
    ws = create_ws(client, auth_header, "Paid Reinvite WS")
    sub = make_beta_sub(client, auth_header, username="paidreinviter", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    _bulk_invite(client, sub["token"], ws["id"], email)
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE
    _sync_sees(client, ws, email, status="active")

    # Sync đẩy member lên `active` → mời lại đi đường gia hạn, không phải mời mới.
    # Hạ về `pending` bằng chính đường đồng bộ (quét tab Lời mời) rồi mới mời lại.
    from app.db import SessionLocal
    from app.models import Member

    with SessionLocal() as db:
        row = db.query(Member).filter(Member.email == email).one()
        row.status = "pending"
        db.commit()

    _bulk_invite(client, sub["token"], ws["id"], email)
    assert wallet_of(client, sub["token"])["balance"] == 300_000 - FEE, (
        "kỳ đã trả tiền → mời lại vẫn 0đ"
    )
    assert len(_invite_fees(client, sub["token"])) == 1


def test_moi_lai_hang_loat_bo_qua_ky_chua_co_tien(
    client: TestClient, auth_header: dict
) -> None:
    """Lối mời lại HÀNG LOẠT bỏ luôn `chargeable` (không bao giờ trừ ví giữa chừng),
    nên kỳ chưa có tiền phải bị CHẶN NGAY tại bộ lọc. Thả cho core thì nó
    `_apply_invite_paid_cycle` → dán nhãn "Đã thanh toán" lên kỳ chưa ai trả, đổi lỗ
    thủng từ mất tiền sang mất dấu vết nợ."""
    email = "batch-unfunded@example.com"
    ws = create_ws(client, auth_header, "Batch Unfunded WS")
    sub = make_beta_sub(client, auth_header, username="batchunfunded", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    item_id = _bulk_invite(client, sub["token"], ws["id"], email)
    _fail_invite(client, ws, item_id)
    _sync_sees(client, ws, email)
    member_id = _member_row(email)["id"]

    # Gọi bằng super-admin: dòng do sync dựng lại KHÔNG mang `invited_by_user_id` nên
    # bộ lọc hiển thị của sub-admin sẽ loại nó ra trước khi tới bộ lọc cần kiểm.
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/re-invite-batch",
        json={"member_ids": [member_id]},
        headers=auth_header,
    )
    assert r.status_code == 202, r.text
    assert r.json()["count"] == 0
    assert r.json()["skipped_expired"] == 1
    assert _member_row(email)["payment_status"] == "unpaid", (
        "không được biến nợ thành 'đã thanh toán' bằng một lệnh miễn phí"
    )


def test_chuyen_workspace_khong_mien_phi_khi_ky_chua_co_tien(
    client: TestClient, auth_header: dict
) -> None:
    """Đường CHUYỂN WORKSPACE miễn phí (`find_movable_paid_members`) dùng chung luật:
    gói còn hạn ở ws khác chỉ được dời sang miễn phí khi kỳ đó CÓ TIỀN.

    Hiện trường có thật trong DB 3/9/2026: `haiquynh.hcfarm` — dòng `removed` ở GPT1,
    hạn tới 30/9, chưa từng có bút toán lẫn chu kỳ nào (do đồng bộ cấp). Không siết
    thì mời email đó sang workspace khác cũng miễn phí."""
    from app.db import SessionLocal
    from app.models import Member
    from app.routers.members._shared import find_movable_paid_members

    ws_from = create_ws(client, auth_header, "Movable Source WS")
    ws_to = create_ws(client, auth_header, "Movable Target WS")
    sub = make_beta_sub(client, auth_header, username="movableowner", balance=300_000)
    assign(client, auth_header, ws_from["id"], sub["id"])
    assign(client, auth_header, ws_to["id"], sub["id"])

    now = datetime.now(timezone.utc)
    funded = "moved-funded@example.com"
    unfunded = "moved-unfunded@example.com"
    with SessionLocal() as db:
        for email, payment_status in ((funded, "paid"), (unfunded, "unpaid")):
            db.add(
                Member(
                    workspace_id=uuid.UUID(ws_from["id"]),
                    email=email,
                    chatgpt_role="member",
                    status="removed",
                    invited_by_user_id=uuid.UUID(sub["id"]),
                    payment_status=payment_status,
                    subscription_months=1,
                    subscription_purchased_at=now,
                    subscription_end_at=now + timedelta(days=30),
                )
            )
        db.commit()

    with SessionLocal() as db:
        movable = find_movable_paid_members(
            db,
            emails=[funded, unfunded],
            exclude_workspace_id=uuid.UUID(ws_to["id"]),
            owner_id=uuid.UUID(sub["id"]),
            now=now,
        )
    assert funded in movable
    assert unfunded not in movable, "hạn do đồng bộ cấp không được dời miễn phí sang ws khác"
