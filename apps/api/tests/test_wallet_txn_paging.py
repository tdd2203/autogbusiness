"""Lịch sử ví KHÔNG được cụt ở 100 dòng gần nhất (GET /wallet/transactions).

Trước 26/8/2026 endpoint chỉ có `limit` và luôn trả `next_cursor=None`, FE thì xin cứng
100 dòng. Khi trang Ví thêm bộ lọc theo ngày, bấm sang ngày cũ ra RỖNG — trông như mất
sạch lịch sử, dù dữ liệu vẫn nguyên trong DB (user 2026-08-26).

Chốt 3 điều: (1) `next_cursor` chỉ ra khi CÒN dòng cũ hơn, (2) cuộn hết bằng con trỏ thì
lấy lại đủ mọi bút toán, không trùng không sót, (3) `date` lấy TRỌN ngày VN đó kể cả khi
ngày đó nằm ngoài trang đầu.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from tests.wallet_helpers import adjust, bearer, make_beta_sub

VN_TZ = timezone(timedelta(hours=7))


def _page(client: TestClient, token: str, **params) -> dict:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    r = client.get(f"/api/v1/wallet/transactions?{query}", headers=bearer(token))
    assert r.status_code == 200, r.text
    return r.json()


def test_cursor_walks_through_everything(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="pager1")
    for i in range(12):
        adjust(client, auth_header, sub["id"], 1_000, reason=f"nap {i}")

    seen: list[str] = []
    cursor: str | None = None
    for _ in range(10):  # trần vòng lặp, phòng con trỏ đứng im
        params = {"limit": 5}
        if cursor:
            params["before_seq"] = cursor
        page = _page(client, sub["token"], **params)
        seen.extend(t["id"] for t in page["items"])
        cursor = page["next_cursor"]
        if not cursor:
            break

    assert cursor is None, "phải cuộn hết, không còn con trỏ"
    assert len(seen) == 12
    assert len(set(seen)) == 12, "không được trả trùng dòng giữa các trang"


def test_next_cursor_absent_on_last_page(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="pager2")
    for i in range(3):
        adjust(client, auth_header, sub["id"], 1_000, reason=f"nap {i}")

    full = _page(client, sub["token"], limit=100)
    assert len(full["items"]) == 3
    assert full["next_cursor"] is None


def test_old_day_still_reachable_behind_a_wall_of_new_rows(
    client: TestClient, auth_header: dict
) -> None:
    """Bút toán CŨ nằm sau 100+ dòng mới vẫn lấy được nguyên vẹn bằng `date`."""
    from app.db import SessionLocal
    from app.models import WalletTransaction

    sub = make_beta_sub(client, auth_header, username="pager3")
    old_day = (datetime.now(VN_TZ).date() - timedelta(days=30))
    with SessionLocal() as db:
        from app.services import wallet_service

        wallet = wallet_service.get_or_create_wallet(db, uuid.UUID(sub["id"]))
        db.add(
            WalletTransaction(
                wallet_id=wallet.id,
                user_id=uuid.UUID(sub["id"]),
                kind="topup",
                amount=777_000,
                balance_after=777_000,
                held_after=0,
                ref_type="topup",
                created_at=datetime.combine(old_day, datetime.min.time(), tzinfo=VN_TZ)
                + timedelta(hours=10),
            )
        )
        db.commit()

    # Dựng bức tường 105 bút toán MỚI đè lên nó.
    for i in range(105):
        adjust(client, auth_header, sub["id"], 1_000, reason=f"tuong {i}")

    # Trang đầu (100 dòng) không còn dòng cũ — đúng như trước, nhưng CÒN con trỏ.
    first = _page(client, sub["token"], limit=100)
    assert first["next_cursor"] is not None
    assert all(t["amount"] != 777_000 for t in first["items"])

    # Lọc theo NGÀY thì thấy ngay, không cần cuộn.
    day = _page(client, sub["token"], date=old_day.isoformat())
    assert len(day["items"]) == 1
    assert day["items"][0]["amount"] == 777_000
    assert day["next_cursor"] is None
