"""Nhánh Canva — nền dữ liệu (M1, user 2026-09-01).

Canva chạy song song ChatGPT trên CÙNG bảng `workspaces`, phân biệt bằng cột
`platform`. Test canh 3 điều dễ vỡ nhất:

  1. Client CŨ không gửi `platform` phải tiếp tục tạo ra workspace ChatGPT — nếu
     mặc định lệch sang 'canva' thì mọi lệnh mời đang chạy sẽ mở nhầm tab.
  2. Team Canva tự có 50 suất: gói trả phí cấp sẵn, KHÔNG mua thêm được, nên
     `seat_total` là hằng số của gói chứ không chờ scrape về như ChatGPT.
  3. Lọc theo nhánh phải tách sạch hai thế giới, còn KHÔNG lọc thì thấy cả hai —
     các trang dùng chung (nhật ký, ví, báo cáo) dựa vào điều đó.
"""

from fastapi.testclient import TestClient


def _create(client: TestClient, auth_header: dict[str, str], **body) -> dict:
    resp = client.post("/api/v1/workspaces", json=body, headers=auth_header)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_khong_gui_platform_thi_van_la_gpt(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    ws = _create(client, auth_header, name="WS cũ", seat_total=120)
    assert ws["platform"] == "gpt"
    # Không tự nhét 50 suất vào nhánh GPT.
    assert ws["seat_total"] == 120


def test_team_canva_mac_dinh_50_suat(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    ws = _create(client, auth_header, name="Canva 1", platform="canva")
    assert ws["platform"] == "canva"
    assert ws["seat_total"] == 50


def test_canva_van_cho_dat_tay_so_suat(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Gói Canva khác 50 suất thì admin nhập tay được — mặc định chỉ là mặc định."""
    ws = _create(client, auth_header, name="Canva nhỏ", platform="canva", seat_total=30)
    assert ws["seat_total"] == 30


def test_loc_danh_sach_theo_nhanh(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    gpt = _create(client, auth_header, name="GPT1")
    canva = _create(client, auth_header, name="Canva 1", platform="canva")

    def ids(query: str = "") -> set[str]:
        resp = client.get(f"/api/v1/workspaces{query}", headers=auth_header)
        assert resp.status_code == 200, resp.text
        return {w["id"] for w in resp.json()}

    assert ids("?platform=gpt") == {gpt["id"]}
    assert ids("?platform=canva") == {canva["id"]}
    # Không truyền tham số = CẢ HAI nhánh (trang dùng chung cần nhìn thấy tất cả).
    assert ids() == {gpt["id"], canva["id"]}


def test_anh_chup_suat_mang_theo_nhanh(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """`/workspaces/seats` là nguồn suất dùng chung của dashboard — trang mời dùng
    chung cho hai nhánh nên phải lọc được đích ngay từ đây."""
    _create(client, auth_header, name="GPT1", seat_total=100)
    canva = _create(client, auth_header, name="Canva 1", platform="canva")

    resp = client.get("/api/v1/workspaces/seats?platform=canva", headers=auth_header)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["workspace_id"] for r in rows] == [canva["id"]]
    assert rows[0]["platform"] == "canva"
    assert rows[0]["seat_total"] == 50
    # Team mới chưa có ai → còn trống đúng 50 suất.
    assert rows[0]["seat_used"] == 0
    assert rows[0]["seat_left"] == 50

    resp_all = client.get("/api/v1/workspaces/seats", headers=auth_header)
    assert len(resp_all.json()) == 2


def test_platform_la_gia_tri_dong(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Nhánh lạ bị chặn ở tầng schema, không lọt xuống DB rồi thành 'không rõ'."""
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Sai nhánh", "platform": "notion"},
        headers=auth_header,
    )
    assert resp.status_code == 422, resp.text


# ── M2: trần suất cứng + phạm vi trùng email theo nhánh ──────────────────────

def test_team_canva_chan_cung_o_50_suat(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Nhánh GPT cho vượt +50% vì còn mua thêm suất được; Canva thì không có đường
    nào mở thêm, mời quá là Canva từ chối tại chỗ sau khi đã trừ tiền."""
    from tests.wallet_helpers import assign, bearer, make_beta_sub

    ws = _create(client, auth_header, name="Canva chật", platform="canva", seat_total=2)
    sub = make_beta_sub(client, auth_header, username="seatseller", balance=1_000_000)
    assign(client, auth_header, ws["id"], sub["id"])
    key = {"X-API-KEY": ws["extension_api_key"]}

    # 2 thành viên ACTIVE = kín chỗ.
    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/bulk-upsert",
        json={"members": [
            {"email": "a@example.com", "chatgpt_role": "member", "status": "active"},
            {"email": "b@example.com", "chatgpt_role": "member", "status": "active"},
        ]},
        headers=key,
    )
    assert r.status_code in (200, 201), r.text

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "c@example.com", "role": "member", "subscription_months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 409, r.text
    assert "Canva" in r.json()["detail"]


def test_email_mua_ca_hai_nhanh_khong_bi_chan(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Khách mua cả ChatGPT lẫn Canva là chuyện bình thường (user 2026-09-01). Luật
    '1 email chỉ ở 1 workspace' và luật chủ sở hữu chỉ xét TRONG CÙNG NHÁNH."""
    from tests.wallet_helpers import assign, bearer, make_beta_sub

    gpt = _create(client, auth_header, name="GPT1")
    canva = _create(client, auth_header, name="Canva 1", platform="canva")
    sub = make_beta_sub(client, auth_header, username="bothseller", balance=1_000_000)
    assign(client, auth_header, gpt["id"], sub["id"])
    assign(client, auth_header, canva["id"], sub["id"])
    tok = bearer(sub["token"])

    r = client.post(
        f"/api/v1/workspaces/{gpt['id']}/members/invite",
        json={"email": "kh@example.com", "role": "member", "subscription_months": 1},
        headers=tok,
    )
    assert r.status_code == 201, r.text

    # Cùng email, sang nhánh Canva → PHẢI cho.
    r = client.post(
        f"/api/v1/workspaces/{canva['id']}/members/invite",
        json={"email": "kh@example.com", "role": "member", "subscription_months": 1},
        headers=tok,
    )
    assert r.status_code == 201, r.text


def test_van_chan_trung_email_trong_cung_nhanh(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Nới theo nhánh KHÔNG được làm hỏng luật cũ: hai workspace ChatGPT vẫn chặn."""
    from tests.wallet_helpers import assign, bearer, make_beta_sub

    ws1 = _create(client, auth_header, name="GPT1")
    ws2 = _create(client, auth_header, name="GPT2")
    sub = make_beta_sub(client, auth_header, username="dupseller", balance=1_000_000)
    assign(client, auth_header, ws1["id"], sub["id"])
    assign(client, auth_header, ws2["id"], sub["id"])
    tok = bearer(sub["token"])

    r = client.post(
        f"/api/v1/workspaces/{ws1['id']}/members/invite",
        json={"email": "kh@example.com", "role": "member", "subscription_months": 1},
        headers=tok,
    )
    assert r.status_code == 201, r.text
    r = client.post(
        f"/api/v1/workspaces/{ws2['id']}/members/invite",
        json={"email": "kh@example.com", "role": "member", "subscription_months": 1},
        headers=tok,
    )
    assert r.status_code == 409, r.text


# ── M4/M5: payload lệnh + liên kết mời duy nhất ─────────────────────────────

def test_lenh_moi_canva_khong_mang_field_cua_chatgpt(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Payload lệnh Canva phải sạch: không tên miền xác minh, không gợi ý suất, không
    số suất cần mua — Canva không có mấy thứ đó, gửi kèm chỉ làm người đọc payload sau
    này tưởng có luồng mua suất."""
    from tests.wallet_helpers import assign, bearer, make_beta_sub

    ws = _create(client, auth_header, name="Canva Team", platform="canva")
    sub = make_beta_sub(client, auth_header, username="payloadseller", balance=1_000_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={
            "email": "kh@example.com",
            "role": "member",
            "subscription_months": 1,
            "canva_role": "brand_designer",
        },
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text

    tasks = client.get(f"/api/v1/queue?workspace_id={ws['id']}", headers=auth_header).json()
    invite_tasks = [t for t in tasks if t["type"] == "INVITE_MEMBER"]
    assert len(invite_tasks) == 1, tasks
    payload = invite_tasks[0]["payload"]
    assert payload["canva_role"] == "brand_designer"
    assert "verified_domain" not in payload
    assert "seat_hint" not in payload
    assert "new_seat_count" not in payload


def test_lenh_moi_gpt_van_giu_nguyen_payload_cu(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    """Nhánh ChatGPT KHÔNG được đổi gì: extension đang dựa vào seat_hint để quyết định
    có mở hộp mua suất hay không."""
    from tests.wallet_helpers import assign, bearer, make_beta_sub

    ws = _create(client, auth_header, name="GPT WS", seat_total=100)
    sub = make_beta_sub(client, auth_header, username="gptpayload", balance=1_000_000)
    assign(client, auth_header, ws["id"], sub["id"])

    r = client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "kh@example.com", "role": "member", "subscription_months": 1},
        headers=bearer(sub["token"]),
    )
    assert r.status_code == 201, r.text
    tasks = client.get(f"/api/v1/queue?workspace_id={ws['id']}", headers=auth_header).json()
    payload = [t for t in tasks if t["type"] == "INVITE_MEMBER"][0]["payload"]
    assert "seat_hint" in payload and "new_seat_count" in payload
    assert "canva_role" not in payload


def test_luu_lien_ket_moi_duy_nhat(client: TestClient, auth_header: dict[str, str]) -> None:
    """Extension gửi cặp email → link; backend gắn đúng member. Link chỉ dùng được cho
    chính email đó nên gắn nhầm là khách bấm vào lời mời của người khác."""
    from tests.wallet_helpers import assign, bearer, make_beta_sub

    ws = _create(client, auth_header, name="Canva Team", platform="canva")
    sub = make_beta_sub(client, auth_header, username="linkseller", balance=1_000_000)
    assign(client, auth_header, ws["id"], sub["id"])
    client.post(
        f"/api/v1/workspaces/{ws['id']}/members/invite",
        json={"email": "kh@example.com", "role": "member", "subscription_months": 1},
        headers=bearer(sub["token"]),
    )

    key = {"X-API-KEY": ws["extension_api_key"]}
    r = client.post(
        "/api/v1/canva/invite-links",
        json={
            "workspace_id": ws["id"],
            "links": {
                "KH@example.com": "https://www.canva.com/brand/join?token=abc",
                "nguoi-la@example.com": "https://www.canva.com/brand/join?token=zzz",
            },
        },
        headers=key,
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"updated": 1}  # email lạ bị bỏ qua, không báo lỗi

    members = client.get(
        f"/api/v1/workspaces/{ws['id']}/members", headers=auth_header
    ).json()
    row = next(m for m in members if m["email"] == "kh@example.com")
    assert row["invite_link"] == "https://www.canva.com/brand/join?token=abc"


def test_khoa_api_cua_team_khac_khong_ghi_duoc_lien_ket(
    client: TestClient, auth_header: dict[str, str]
) -> None:
    ws_a = _create(client, auth_header, name="Canva A", platform="canva")
    ws_b = _create(client, auth_header, name="Canva B", platform="canva")
    r = client.post(
        "/api/v1/canva/invite-links",
        json={"workspace_id": ws_a["id"], "links": {"x@example.com": "https://canva.com/x"}},
        headers={"X-API-KEY": ws_b["extension_api_key"]},
    )
    assert r.status_code == 403, r.text
