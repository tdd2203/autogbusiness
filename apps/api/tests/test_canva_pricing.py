"""Nhánh Canva — BẢNG GIÁ BẬC THANG (M2, user 2026-09-01).

ChatGPT bán `đơn giá/tháng × số tháng`; Canva bán theo gói, mua càng dài càng rẻ:
1 tháng 15.000 · 3 tháng 40.000 · 6 tháng 70.000 · 12 tháng 100.000.

Điều dễ vỡ nhất và cũng là điều test này canh: TIỀN THU PHẢI KHỚP BẢNG. Nếu chỗ nào
lỡ rơi về công thức nhân của ChatGPT, một đơn 12 tháng sẽ thu 180.000 thay vì 100.000
(hoặc ngược lại, 1 tháng thu 8.333 thay vì 15.000) mà không có gì báo.
"""

from fastapi.testclient import TestClient

from app.services import canva_price
from tests.wallet_helpers import (
    assign,
    bearer,
    create_ws,
    make_beta_sub,
    set_settings,
    wallet_of,
)


# ── Công thức thuần (không đụng DB) ──────────────────────────────────────────

def test_dung_bac_thi_lay_thang_gia_bac():
    tiers = [dict(t) for t in canva_price.DEFAULT_TIERS]
    assert canva_price.fee_for_months(tiers, 1) == 15_000
    assert canva_price.fee_for_months(tiers, 3) == 40_000
    assert canva_price.fee_for_months(tiers, 6) == 70_000
    assert canva_price.fee_for_months(tiers, 12) == 100_000


def test_khong_dat_hang_thang_len_ma_thanh_dat_hon_ca_goi():
    """Canh đúng cái bẫy: 12 tháng KHÔNG được thành 12 × 15.000."""
    tiers = [dict(t) for t in canva_price.DEFAULT_TIERS]
    assert canva_price.fee_for_months(tiers, 12) < 12 * canva_price.fee_for_months(tiers, 1)


def test_thang_le_lay_bac_duoi_cong_phan_du():
    tiers = [dict(t) for t in canva_price.DEFAULT_TIERS]
    # 8 tháng = bậc 6 (70.000) + 2 tháng × 11.667 = 93.334 → làm tròn lên 94.000
    assert canva_price.fee_for_months(tiers, 8) == 94_000
    # 2 tháng = bậc 1 (15.000) + 1 tháng × 15.000
    assert canva_price.fee_for_months(tiers, 2) == 30_000


def test_dai_hon_bac_lon_nhat_thi_cong_tiep_theo_don_gia_bac_do():
    tiers = [dict(t) for t in canva_price.DEFAULT_TIERS]
    # 24 tháng = 2 lần gói năm, không tự dưng đắt lên.
    assert canva_price.fee_for_months(tiers, 24) == 200_000


def test_khong_thang_hoac_am_van_tinh_mot_thang():
    tiers = [dict(t) for t in canva_price.DEFAULT_TIERS]
    assert canva_price.fee_for_months(tiers, None) == 15_000
    assert canva_price.fee_for_months(tiers, 0) == 15_000


def test_bang_gia_hong_thi_bo_qua_dong_hong_chu_khong_no():
    raw = [
        {"months": 1, "price_vnd": 15_000},
        {"months": "ba", "price_vnd": 40_000},   # số tháng không phải số
        {"months": 6},                            # thiếu giá
        {"months": -2, "price_vnd": 1_000},       # số tháng âm
        {"months": 12, "price_vnd": 100_000},
    ]
    assert canva_price.normalize_tiers(raw) == [
        {"months": 1, "price_vnd": 15_000},
        {"months": 12, "price_vnd": 100_000},
    ]
    assert canva_price.normalize_tiers("hỏng") == []


# ── Qua HTTP: bảng giá hiệu lực + đặt hàng loạt ──────────────────────────────

def test_bang_gia_mac_dinh_khi_chua_ai_cau_hinh(
    client: TestClient, auth_header: dict
) -> None:
    r = client.get("/api/v1/canva/price-tiers", headers=auth_header)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "builtin"
    assert body["sellable_months"] == [1, 3, 6, 12]
    assert body["tiers"][-1] == {"months": 12, "price_vnd": 100_000}


def test_dai_ly_co_bang_rieng_thi_bang_rieng_thang(
    client: TestClient, auth_header: dict
) -> None:
    sub = make_beta_sub(client, auth_header, username="agent1")
    client.put(
        "/api/v1/canva/price-tiers/default",
        json={"tiers": [{"months": 1, "price_vnd": 20_000}]},
        headers=auth_header,
    )
    r = client.put(
        "/api/v1/canva/price-tiers/agents",
        json={"user_ids": [sub["id"]], "tiers": [{"months": 1, "price_vnd": 9_000}]},
        headers=auth_header,
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"updated": 1, "cleared": False}

    mine = client.get("/api/v1/canva/price-tiers", headers=bearer(sub["token"])).json()
    assert mine["source"] == "user"
    assert mine["tiers"] == [{"months": 1, "price_vnd": 9_000}]

    # Đại lý khác chưa đặt riêng → rơi về bảng hệ thống.
    other = make_beta_sub(client, auth_header, username="agent2")
    theirs = client.get("/api/v1/canva/price-tiers", headers=bearer(other["token"])).json()
    assert theirs["source"] == "system"
    assert theirs["tiers"] == [{"months": 1, "price_vnd": 20_000}]


def test_dat_hang_loat_va_xoa_bang_rieng(client: TestClient, auth_header: dict) -> None:
    a = make_beta_sub(client, auth_header, username="agentA")
    b = make_beta_sub(client, auth_header, username="agentB")
    tiers = [{"months": 1, "price_vnd": 12_000}, {"months": 12, "price_vnd": 90_000}]

    r = client.put(
        "/api/v1/canva/price-tiers/agents",
        json={"user_ids": [a["id"], b["id"]], "tiers": tiers},
        headers=auth_header,
    )
    assert r.json()["updated"] == 2
    for who in (a, b):
        got = client.get("/api/v1/canva/price-tiers", headers=bearer(who["token"])).json()
        assert got["tiers"] == tiers and got["source"] == "user"

    # Gửi danh sách rỗng = xoá bảng riêng, quay về mặc định.
    r = client.put(
        "/api/v1/canva/price-tiers/agents",
        json={"user_ids": [a["id"]], "tiers": []},
        headers=auth_header,
    )
    assert r.json() == {"updated": 1, "cleared": True}
    got = client.get("/api/v1/canva/price-tiers", headers=bearer(a["token"])).json()
    assert got["source"] == "builtin"


def test_liet_ke_dai_ly_dang_co_gia_rieng(client: TestClient, auth_header: dict) -> None:
    """Trang quản trị phải nhìn được ai đang lệch khỏi bảng mặc định.

    Đặt giá riêng mà không đọc lại được thì đó là thao tác ghi một chiều: admin nhìn
    màn hình không biết mình đã đặt cho ai, đặt bao nhiêu.
    """
    a = make_beta_sub(client, auth_header, username="agentX")
    make_beta_sub(client, auth_header, username="agentY")
    tiers = [{"months": 1, "price_vnd": 11_000}]

    r = client.get("/api/v1/canva/price-tiers/agents", headers=auth_header)
    assert r.status_code == 200 and r.json()["overrides"] == []

    client.put(
        "/api/v1/canva/price-tiers/agents",
        json={"user_ids": [a["id"]], "tiers": tiers},
        headers=auth_header,
    )
    rows = client.get("/api/v1/canva/price-tiers/agents", headers=auth_header).json()
    assert rows["overrides"] == [{"user_id": a["id"], "tiers": tiers}]

    # Xoá giá riêng thì biến khỏi danh sách, không còn hiện "đang lệch".
    client.put(
        "/api/v1/canva/price-tiers/agents",
        json={"user_ids": [a["id"]], "tiers": []},
        headers=auth_header,
    )
    rows = client.get("/api/v1/canva/price-tiers/agents", headers=auth_header).json()
    assert rows["overrides"] == []


def test_dai_ly_khong_xem_duoc_danh_sach_gia_rieng(
    client: TestClient, auth_header: dict
) -> None:
    sub = make_beta_sub(client, auth_header, username="tomo")
    r = client.get("/api/v1/canva/price-tiers/agents", headers=bearer(sub["token"]))
    assert r.status_code == 403, r.text


def test_chi_super_admin_duoc_dat_gia(client: TestClient, auth_header: dict) -> None:
    sub = make_beta_sub(client, auth_header, username="notadmin")
    r = client.put(
        "/api/v1/canva/price-tiers/default",
        json={"tiers": [{"months": 1, "price_vnd": 1_000}]},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 403, r.text


# ── Tiền thật: mời vào team Canva phải trừ đúng bảng ─────────────────────────

def test_moi_canva_tru_vi_theo_bang_bac(client: TestClient, auth_header: dict) -> None:
    """12 tháng phải trừ đúng 100.000 — không phải 12 × 15.000, cũng không phải phí
    mặc định của nhánh ChatGPT."""
    set_settings(client, auth_header, invite_fee_vnd=380_000)  # giá ChatGPT, không liên quan
    ws = create_ws(client, auth_header, "Canva Team", platform="canva")
    sub = make_beta_sub(client, auth_header, username="canvaseller", balance=500_000)
    assign(client, auth_header, ws["id"], sub["id"])
    tok = sub["token"]

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "kh1@example.com", "role": "member", "subscription_months": 12},
        headers=bearer(tok),
    )
    assert r.status_code == 201, r.text
    assert wallet_of(client, tok)["balance"] == 400_000

    txns = client.get("/api/v1/wallet/transactions", headers=bearer(tok)).json()["items"]
    invite_txns = [t for t in txns if t["kind"] == "invite_fee"]
    assert len(invite_txns) == 1 and invite_txns[0]["amount"] == -100_000, txns


def test_xem_truoc_phi_canva_khop_voi_luc_tru(client: TestClient, auth_header: dict) -> None:
    """Trang mời hiện phí bằng endpoint xem trước — hiện một đằng trừ một nẻo là mất
    lòng tin ngay lần đầu dùng."""
    set_settings(client, auth_header, invite_fee_vnd=380_000)
    ws = create_ws(client, auth_header, "Canva Team", platform="canva")
    sub = make_beta_sub(client, auth_header, username="previewer", balance=500_000)
    assign(client, auth_header, ws["id"], sub["id"])
    tok = sub["token"]

    preview = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite-preview",
        json={"invites": [
            {"email": "a@example.com", "subscription_months": 12},
            {"email": "b@example.com", "subscription_months": 3},
        ]},
        headers=bearer(tok),
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["total_fee"] == 140_000  # 100.000 + 40.000

    before = wallet_of(client, tok)["balance"]
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-invite",
        json={"invites": [
            {"email": "a@example.com", "subscription_months": 12},
            {"email": "b@example.com", "subscription_months": 3},
        ], "role": "member"},
        headers=bearer(tok),
    )
    assert r.status_code == 202, r.text
    assert before - wallet_of(client, tok)["balance"] == 140_000


def test_hoa_don_qr_canva_mang_duoi_cv(client: TestClient, auth_header: dict) -> None:
    """Ví thiếu → QR. Mã hoá đơn Canva phải kết thúc bằng 'cv' (user 2026-09-01) để
    nhìn sao kê ngân hàng là biết tiền của nhánh nào."""
    set_settings(client, auth_header)
    ws = create_ws(client, auth_header, "Canva Team", platform="canva")
    sub = make_beta_sub(client, auth_header, username="poorseller", balance=1_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "kh2@example.com", "role": "member", "subscription_months": 12},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    order = r.json()["detail"]["order"]
    assert order["amount_vnd"] == 100_000
    assert order["ref_code"].endswith("cv"), order
    assert len(order["ref_code"]) == 20, order  # 18 hex + 'cv', bằng độ dài mã GPT
    assert order["note"].endswith(order["ref_code"])


def test_hoa_don_qr_gpt_khong_co_duoi_cv(client: TestClient, auth_header: dict) -> None:
    set_settings(client, auth_header, invite_fee_vnd=380_000)
    ws = create_ws(client, auth_header, "GPT WS")
    sub = make_beta_sub(client, auth_header, username="gptseller", balance=1_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "kh3@example.com", "role": "member", "subscription_months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 402, r.text
    ref = r.json()["detail"]["order"]["ref_code"]
    assert not ref.endswith("cv") and len(ref) == 20, ref
