"""Hai nhánh xem hai bộ dữ liệu — trang dùng chung phải lọc theo `?platform=`.

Thanh bên web tách hẳn ChatGPT và Canva (user 2026-09-01: "dữ liệu tách riêng ra
không chung với nhau"): mỗi nhánh có Tổng quan / Email đã thêm / Gia hạn / Thông
báo / Nhật ký riêng, đi vào cùng những endpoint này kèm tham số nhánh. Test canh
đúng chỗ dễ vỡ: bỏ tham số phải thấy CẢ HAI như trước (client cũ, và trang Ví),
có tham số thì không được lọt một dòng nào của nhánh kia.
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict[str, str], name: str, **extra) -> dict:
    resp = client.post(
        "/api/v1/workspaces", json={"name": name, **extra}, headers=auth_header
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _invite(client: TestClient, auth_header: dict[str, str], ws_id: str, email: str):
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/members/invite",
        json={"email": email, "role": "member"},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _two_branches(client: TestClient, auth_header: dict[str, str]):
    gpt = _ws(client, auth_header, "WS ChatGPT", seat_total=25)
    canva = _ws(client, auth_header, "Team Canva", platform="canva")
    _invite(client, auth_header, gpt["id"], "khach-gpt@example.com")
    _invite(client, auth_header, canva["id"], "khach-canva@example.com")
    return gpt, canva


def _emails(client: TestClient, auth_header: dict[str, str], query: str = "") -> set[str]:
    resp = client.get(f"/api/v1/added-members{query}", headers=auth_header)
    assert resp.status_code == 200, resp.text
    return {m["email"] for m in resp.json()}


def test_email_da_them_loc_theo_nhanh(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    _two_branches(client, auth_header)

    assert _emails(client, auth_header) == {
        "khach-gpt@example.com",
        "khach-canva@example.com",
    }
    assert _emails(client, auth_header, "?platform=gpt") == {"khach-gpt@example.com"}
    assert _emails(client, auth_header, "?platform=canva") == {
        "khach-canva@example.com"
    }


def test_nhanh_sai_ten_thi_bao_loi(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Gõ nhầm nhánh phải 400, không được lặng lẽ trả cả hai như khi bỏ trống."""
    for url in (
        "/api/v1/added-members?platform=notion",
        "/api/v1/audit-logs?platform=notion",
        "/api/v1/dashboard/overview?platform=notion",
    ):
        resp = client.get(url, headers=auth_header)
        assert resp.status_code == 400, (url, resp.text)


def test_nhat_ky_loc_theo_nhanh(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    gpt, canva = _two_branches(client, auth_header)

    def logs(query: str) -> list[dict]:
        resp = client.get(f"/api/v1/audit-logs?limit=200{query}", headers=auth_header)
        assert resp.status_code == 200, resp.text
        return resp.json()

    def workspace_ids(rows: list[dict]) -> set[str]:
        out = set()
        for r in rows:
            wid = (r.get("data") or {}).get("workspace_id")
            if not wid and r.get("target_type") == "WORKSPACE":
                wid = r.get("target_id")
            if wid:
                out.add(wid)
        return out

    assert workspace_ids(logs("&platform=gpt")) == {gpt["id"]}
    assert workspace_ids(logs("&platform=canva")) == {canva["id"]}
    # Không lọc thì vẫn kể cả hai — trang cũ và mọi nơi khác dựa vào điều này.
    assert workspace_ids(logs("")) == {gpt["id"], canva["id"]}

    # Dòng đăng nhập KHÔNG thuộc nhánh nào (việc của tài khoản) nên phải còn thấy
    # ở CẢ HAI nhánh: giấu đi là nhật ký kể thiếu chuyện đã xảy ra thật.
    def has_login(rows: list[dict]) -> bool:
        return any(r["action"] == "LOGIN_SUCCESS" for r in rows)

    assert has_login(logs("&platform=gpt"))
    assert has_login(logs("&platform=canva"))


def test_tong_quan_dem_rieng_tung_nhanh(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    _two_branches(client, auth_header)

    def serving(query: str = "") -> int:
        resp = client.get(f"/api/v1/dashboard/overview{query}", headers=auth_header)
        assert resp.status_code == 200, resp.text
        return resp.json()["serving"]["seats"]

    assert serving() == 2
    assert serving("?platform=gpt") == 1
    assert serving("?platform=canva") == 1


def test_nhat_ky_khong_lan_dong_hang_doi_cua_nhanh_kia(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Dòng cấp hàng đợi chỉ mang `queue_item_id` — phải quy được về nhánh của task.

    Không quy được thì mỗi lệnh mời của ChatGPT đẻ ra một cặp dòng "vô chủ" nằm
    trong nhật ký Canva (đo trên dữ liệu thật 2026-09-01: 140/200 dòng gần nhất).
    """
    gpt = _ws(client, auth_header, "WS ChatGPT", seat_total=25)
    _ws(client, auth_header, "Team Canva", platform="canva")
    _invite(client, auth_header, gpt["id"], "hangdoi-gpt@example.com")
    # Extension nhận task của nhánh ChatGPT → sinh QUEUE_PICKED (chỉ có queue_item_id).
    picked = client.get(
        "/api/v1/queue/next", headers={"X-API-KEY": gpt["extension_api_key"]}
    )
    assert picked.status_code == 200, picked.text

    def queue_actions(query: str) -> list[str]:
        resp = client.get(f"/api/v1/audit-logs?limit=200{query}", headers=auth_header)
        assert resp.status_code == 200, resp.text
        return [r["action"] for r in resp.json() if r["action"].startswith("QUEUE_")]

    assert queue_actions("&platform=gpt"), "nhánh ChatGPT phải thấy dòng hàng đợi của nó"
    assert queue_actions("&platform=canva") == []


def test_nhat_ky_tien_theo_nhanh_cua_hoa_don(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Dòng tiền chỉ mang id hoá đơn — quy nhánh theo `payment_orders.platform`.

    Không quy thì mỗi lần khách trả tiền cho ChatGPT lại hiện trong nhật ký Canva
    (đo trên dữ liệu thật 2026-09-01: 108/200 dòng gần nhất).
    """
    from uuid import uuid4

    from app.db import SessionLocal
    from app.models import AuditLog, PaymentOrder, User

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.is_super_admin.is_(True)).first()
        assert admin is not None
        orders = {}
        for plat in ("gpt", "canva"):
            o = PaymentOrder(
                user_id=admin.id,
                ref_code=f"TEST{plat.upper()}",
                platform=plat,
                kind="invite",
                amount_vnd=10_000,
                status="paid",
            )
            db.add(o)
            db.flush()
            orders[plat] = o.id
            db.add(
                AuditLog(
                    id=uuid4(),
                    actor_type="SYSTEM",
                    actor_label="test",
                    action="WALLET_ORDER_CREDITED",
                    result="SUCCESS",
                    data={"ref_type": "order", "ref_id": str(o.id)},
                )
            )
        db.commit()
    finally:
        db.close()

    def refs(query: str) -> set[str]:
        resp = client.get(f"/api/v1/audit-logs?limit=200{query}", headers=auth_header)
        assert resp.status_code == 200, resp.text
        return {
            (r.get("data") or {}).get("ref_id")
            for r in resp.json()
            if r["action"] == "WALLET_ORDER_CREDITED"
        }

    assert refs("&platform=gpt") == {str(orders["gpt"])}
    assert refs("&platform=canva") == {str(orders["canva"])}
