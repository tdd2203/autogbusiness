"""Email KHÔNG vào được ô mời → chốt hỏng + hoàn phí NGAY (bug user 30/8/2026).

Extension nhập từng email vào từng dòng riêng trong hộp mời. Hai chỗ `break` (hộp
thoại đóng giữa chừng / không thêm được dòng) khiến nó bấm Gửi với số email nhập
được, phần còn lại bị bỏ im lặng. Trước bản này backend không hay biết: verify không
thấy các email đó nên xếp chung vào diện "chưa xác minh", màn hình báo "đã gửi, đang
xác nhận" cho lời mời CHƯA HỀ ĐƯỢC GỬI, tiền treo tới khi resolver chốt.

Ranh giới phải giữ: `skipped_emails` là bằng chứng DƯƠNG (chưa gửi) ⇒ hoàn ngay;
"unverified" bình thường vẫn là CHƯA BIẾT ⇒ vẫn hoãn như cũ.
"""

import pytest
from fastapi.testclient import TestClient

from tests.wallet_helpers import assign, bearer, create_ws, make_beta_sub, set_settings, wallet_of

FEE = 100_000


@pytest.fixture(autouse=True)
def _pin_fee(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=FEE)


def _bulk(client: TestClient, token: str, ws_id: str, emails: list[str]) -> dict:
    r = client.post(
        f"/api/v1/workspaces/{ws_id}/members/bulk-invite",
        json={"emails": emails, "role": "member"},
        headers=bearer(token),
    )
    assert r.status_code == 202, r.text
    return r.json()


def _complete(client: TestClient, api_key: str, item_id: str, result: dict):
    return client.patch(
        f"/api/v1/queue/{item_id}",
        json={"status": "COMPLETED", "result": result},
        headers={"X-API-KEY": api_key},
    )


def _outcome(item_id: str) -> dict:
    """Đọc thẳng DB: queue KHÔNG có endpoint GET một task lẻ (chỉ có list)."""
    import uuid

    from app.db import SessionLocal
    from app.models import QueueItem

    with SessionLocal() as db:
        row = db.get(QueueItem, uuid.UUID(item_id))
        assert row is not None
        return (row.result or {}).get("invite_outcome") or {}


def test_skipped_email_refunded_ngay_du_moi_con_tuoi(
    client: TestClient, auth_header: dict
) -> None:
    """KHÔNG backdate member: guard 10′ vẫn còn hiệu lực mà vẫn phải hoàn phí."""
    ws = create_ws(client, auth_header, "Skipped WS")
    sub = make_beta_sub(client, auth_header, username="skipped1", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    emails = ["s1@example.com", "s2@example.com", "s3@example.com"]
    res = _bulk(client, sub["token"], ws["id"], emails)
    assert wallet_of(client, sub["token"])["balance"] == 0

    # s1 vào được và verify thấy; s2 nhập được nhưng ChatGPT chưa hiện (hoãn);
    # s3 KHÔNG nhập được vào ô mời.
    r = _complete(
        client,
        ws["extension_api_key"],
        res["queue_item_id"],
        {
            "verified_emails": ["s1@example.com"],
            "unverified_emails": ["s2@example.com", "s3@example.com"],
            "skipped_emails": ["s3@example.com"],
        },
    )
    assert r.status_code == 200, r.text

    # Chỉ s3 được hoàn. s2 vẫn treo chờ đối chiếu (tiền chưa về).
    assert wallet_of(client, sub["token"])["balance"] == FEE
    txns = client.get(
        "/api/v1/wallet/transactions", headers=bearer(sub["token"])
    ).json()["items"]
    refunds = [t for t in txns if t["kind"] == "invite_refund"]
    assert [t["meta"]["email"] for t in refunds] == ["s3@example.com"]


def test_outcome_tach_dung_ba_nhom(client: TestClient, auth_header: dict) -> None:
    ws = create_ws(client, auth_header, "Skipped Outcome WS")
    sub = make_beta_sub(client, auth_header, username="skipped2", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(
        client,
        sub["token"],
        ws["id"],
        ["o1@example.com", "o2@example.com", "o3@example.com"],
    )
    _complete(
        client,
        ws["extension_api_key"],
        res["queue_item_id"],
        {
            "verified_emails": ["o1@example.com"],
            "unverified_emails": ["o2@example.com", "o3@example.com"],
            "skipped_emails": ["o3@example.com"],
        },
    )

    out = _outcome(res["queue_item_id"])
    assert out["invited"] == ["o1@example.com"]
    assert out["pending_verify"] == ["o2@example.com"]
    assert out["failed"] == ["o3@example.com"]
    assert out["refunded"] == ["o3@example.com"]
    # Câu giải thích đi kèm, lấy từ services/task_errors.py — dashboard không tự dịch.
    assert out["reason_code"] == "INVITE_NOT_TYPED"
    assert "chưa gửi" in (out["reason_text"] or "")


def test_khong_scrape_duoc_van_chot_email_chua_nhap(
    client: TestClient, auth_header: dict
) -> None:
    """`verify_scrape_failed` che mất thông tin verify, KHÔNG che được bằng chứng
    "chưa nhập vào ô mời" — email đó vẫn phải hoàn phí ngay."""
    ws = create_ws(client, auth_header, "Skipped ScrapeFail WS")
    sub = make_beta_sub(client, auth_header, username="skipped3", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["f1@example.com", "f2@example.com"])
    _complete(
        client,
        ws["extension_api_key"],
        res["queue_item_id"],
        {"verify_scrape_failed": True, "skipped_emails": ["f2@example.com"]},
    )

    # 300k − 2×100k = 100k, hoàn phí f2 → 200k.
    assert wallet_of(client, sub["token"])["balance"] == 200_000
    out = _outcome(res["queue_item_id"])
    assert out["failed"] == ["f2@example.com"]
    # f1 đã bấm gửi nhưng không soi lại được ⇒ vẫn là "chưa biết", không được chốt.
    assert out["pending_verify"] == ["f1@example.com"]
    assert out["invited"] == []


def test_unverified_thuong_van_duoc_hoan_phan_xu(
    client: TestClient, auth_header: dict
) -> None:
    """Chốt chặn: luật hoãn 10′ cho unverified THƯỜNG không được đụng tới."""
    ws = create_ws(client, auth_header, "Defer Intact WS")
    sub = make_beta_sub(client, auth_header, username="skipped4", balance=300_000)
    assign(client, auth_header, ws["id"], sub["id"])

    res = _bulk(client, sub["token"], ws["id"], ["d1@example.com"])
    _complete(
        client,
        ws["extension_api_key"],
        res["queue_item_id"],
        {"verified_emails": [], "unverified_emails": ["d1@example.com"]},
    )

    # Mời tươi < 10′ ⇒ hoãn phán xử: KHÔNG hoàn phí, KHÔNG chốt hỏng.
    # Ví: 300k − 1×100k = 200k và KHÔNG có giao dịch hoàn nào.
    assert wallet_of(client, sub["token"])["balance"] == 200_000
    txns = client.get(
        "/api/v1/wallet/transactions", headers=bearer(sub["token"])
    ).json()["items"]
    assert [t for t in txns if t["kind"] == "invite_refund"] == []
    out = _outcome(res["queue_item_id"])
    assert out["failed"] == []
    assert out["pending_verify"] == ["d1@example.com"]
