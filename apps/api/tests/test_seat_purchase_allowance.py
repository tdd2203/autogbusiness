"""GIẤY PHÉP MUA SUẤT gửi kèm lệnh mời — chốt chặn "tự trừ tiền thẻ".

Ca thật GPT1 7/9/2026 (task `b7ced59e`): trần thành viên đang đặt 387, lệnh mời
`tnguyen281187` thấy ChatGPT hết chỗ nên nâng suất lên 388 và bị trừ ₫41.452 ngay
lập tức. Trần lúc đó chỉ gác ở cửa TẠO lệnh (`assert_under_cap`, đếm người trong
DB) nên nó cho qua — 386 người + 1 email mới = 387, đúng bằng trần. Khâu MUA nằm
bên extension và không biết trần là gì.

Luật user chốt cùng ngày: chỉ được mua khi ĐỦ CẢ HAI — mọi email của lệnh đã từng
tham gia workspace này, VÀ tổng suất sau khi mua không vượt trần. File này khoá
phần backend (`seats.purchase_allowance` + field `seat_purchase` trong payload);
phần bên kia — so trần với số suất ĐỌC TẬN NƠI trên ChatGPT — khoá ở
`apps/extension/src/content/actions/invite/purchase-policy.test.ts`.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from tests.wallet_helpers import create_ws


def _ext(ws: dict) -> dict:
    return {"X-API-KEY": ws["extension_api_key"]}


def _invite_payload(client: TestClient, headers: dict, ws_id: str, email: str) -> dict:
    """Mời 1 email rồi trả về payload của task INVITE_MEMBER vừa tạo."""
    from app.db import SessionLocal
    from app.models import QueueItem

    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    with SessionLocal() as db:
        item = (
            db.query(QueueItem)
            .filter(
                QueueItem.workspace_id == uuid.UUID(ws_id),
                QueueItem.type == "INVITE_MEMBER",
            )
            .order_by(QueueItem.created_at.desc())
            .first()
        )
        assert item is not None
        return item.payload or {}


def _allowance(ws_id: str, emails: list[str]) -> dict:
    from app.db import SessionLocal
    from app.models import Workspace
    from app.services import seats

    with SessionLocal() as db:
        ws = db.get(Workspace, uuid.UUID(ws_id))
        assert ws is not None
        return seats.purchase_allowance(db, ws, emails)


def _mark_joined_then_removed(ws_id: str, email: str) -> None:
    """Dựng KHÁCH CŨ: đã vào đội thật (có `joined_at`) rồi rời đi."""
    from app.db import SessionLocal
    from app.models import Member

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        m = (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws_id), Member.email == email)
            .one()
        )
        m.joined_at = now - timedelta(days=40)
        m.status = "removed"
        m.removed_at = now - timedelta(days=1)
        db.commit()


def _set_cap(client: TestClient, auth_header: dict, ws_id: str, cap: int | None) -> None:
    r = client.patch(
        f"/api/v1/workspaces/{ws_id}",
        json={"invite_member_cap": cap},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text


def test_email_moi_toanh_thi_cam_mua(client: TestClient, auth_header: dict):
    """Chưa từng tham gia ⇒ `allowed=False` kèm câu nói rõ email nào."""
    ws = create_ws(client, auth_header, "Allow New WS", plan="business", seat_total=60)

    got = _allowance(ws["id"], ["nguoi-la@example.com"])

    assert got["allowed"] is False
    assert "nguoi-la@example.com" in (got["reason"] or "")


def test_khach_cu_quay_lai_thi_duoc_mua(client: TestClient, auth_header: dict):
    """Đã từng vào đội (có `joined_at`) rồi rời đi ⇒ mời lại được phép mua bù."""
    ws = create_ws(client, auth_header, "Allow Old WS", plan="business", seat_total=60)
    _invite_payload(client, auth_header, ws["id"], "khach-cu@example.com")
    _mark_joined_then_removed(ws["id"], "khach-cu@example.com")

    got = _allowance(ws["id"], ["khach-cu@example.com"])

    assert got["allowed"] is True
    assert got["reason"] is None


def test_loi_moi_cho_chua_nhan_khong_tinh_la_khach_cu(
    client: TestClient, auth_header: dict
):
    """`pending` + `joined_at` NULL = người CHƯA vào đội bao giờ ⇒ vẫn cấm mua.

    Đây là chỗ dễ nới oan nhất: bản ghi có sẵn trong bảng `members` trông như
    "khách cũ", nhưng lời mời chưa ai bấm nhận thì họ chưa từng tốn một suất nào.
    """
    ws = create_ws(client, auth_header, "Allow Pending WS", plan="business", seat_total=60)
    _invite_payload(client, auth_header, ws["id"], "dang-cho@example.com")

    assert _allowance(ws["id"], ["dang-cho@example.com"])["allowed"] is False


def test_mot_email_la_trong_me_lam_ca_me_khong_duoc_mua(
    client: TestClient, auth_header: dict
):
    """Mẻ trộn khách cũ với người mới ⇒ CẤM cả mẻ.

    Không chia nhỏ "mua cho phần khách cũ": số suất mua là một cú bấm chung, tách
    ra là mở đường cho người mới đi ké suất vừa mua.
    """
    ws = create_ws(client, auth_header, "Allow Mixed WS", plan="business", seat_total=60)
    _invite_payload(client, auth_header, ws["id"], "khach-cu@example.com")
    _mark_joined_then_removed(ws["id"], "khach-cu@example.com")

    got = _allowance(ws["id"], ["khach-cu@example.com", "nguoi-la@example.com"])

    assert got["allowed"] is False
    assert "nguoi-la@example.com" in (got["reason"] or "")


def test_payload_lenh_moi_mang_theo_tran_thanh_vien(
    client: TestClient, auth_header: dict
):
    """Ca GPT1 7/9/2026 thu nhỏ: trần 387 phải đi xuống extension qua payload."""
    ws = create_ws(client, auth_header, "Allow Cap WS", plan="business", seat_total=387)
    _set_cap(client, auth_header, ws["id"], 387)

    payload = _invite_payload(client, auth_header, ws["id"], "nguoi-moi@example.com")

    assert payload["seat_purchase"]["max_total"] == 387
    # Email mới toanh ⇒ đã cấm ngay từ điều kiện thứ nhất, chưa cần tới trần.
    assert payload["seat_purchase"]["allowed"] is False


def test_khong_dat_tran_thi_max_total_la_null(client: TestClient, auth_header: dict):
    """Không đặt trần ⇒ điều kiện trần không chặn gì (nhưng vẫn phải là khách cũ)."""
    ws = create_ws(client, auth_header, "Allow NoCap WS", plan="business", seat_total=60)
    _invite_payload(client, auth_header, ws["id"], "khach-cu@example.com")
    _mark_joined_then_removed(ws["id"], "khach-cu@example.com")

    got = _allowance(ws["id"], ["khach-cu@example.com"])

    assert got["max_total"] is None
    assert got["allowed"] is True


def test_moi_lenh_moi_deu_co_giay_phep(client: TestClient, auth_header: dict):
    """Thiếu field = extension CẤM mua (fail-closed) ⇒ đường mời thường phải luôn gắn."""
    ws = create_ws(client, auth_header, "Allow Field WS", plan="business", seat_total=60)

    payload = _invite_payload(client, auth_header, ws["id"], "ai-do@example.com")

    assert "seat_purchase" in payload
    assert set(payload["seat_purchase"]) == {"allowed", "max_total", "reason"}
