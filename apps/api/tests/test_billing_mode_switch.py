"""CẦU DAO `billing_mode` — super-admin gạt từng workspace một (EXPIRY_RULES §3.6.6).

VÌ SAO CÓ FILE NÀY: gạt một workspace sang `cycle_aligned` là đổi cách tính hạn VÀ
cách tính tiền của cả không gian đó. Gạt sai không có gì bật lên — hạn vẫn hiện ra một
con số trông hợp lý, chỉ có điều thu sai từ lượt bán kế tiếp. Bốn chốt chặn dưới đây là
thứ duy nhất đứng giữa một cú bấm nhầm và cả một chu kỳ bán sai giá.

Hai lớp test:

  1. THUẦN LOGIC (`plan_billing_mode_switch`) — không đụng DB: chặn Canva, bắt nhập
     ngày chốt khi không có gì để neo, khoảng 1..31, và MỒI ngày neo từ `renewal_date`
     có ép UTC. Chỗ ép UTC đã sai hai lần trong tính năng này nên có test riêng.
  2. ENDPOINT (`POST /{workspace_id}/billing-mode`) — cần Postgres: quyền, nhật ký,
     và BẤT BIẾN quan trọng nhất là gạt KHÔNG đụng `subscription_end_at` của ai
     (§3.6.8).
"""

import uuid
from datetime import datetime, time as dtime, timedelta, timezone

from fastapi.testclient import TestClient

from app.models import BILLING_MODE_CYCLE_ALIGNED, BILLING_MODE_LEGACY_30D
from app.routers.workspaces.settings import plan_billing_mode_switch
from tests.wallet_helpers import bearer, create_ws, create_user, login

VN = timezone(timedelta(hours=7))  # giờ user nghĩ trong đầu
UTC = timezone.utc


def _plan(**over):
    """Gọi hàm thuần với bộ tham số mặc định "workspace GPT sạch"."""
    args = {
        "platform": "gpt",
        "mode": BILLING_MODE_CYCLE_ALIGNED,
        "current_anchor_day": None,
        "requested_anchor_day": None,
        "requested_force_from_day": None,
        "renewal_date": None,
    }
    args.update(over)
    return plan_billing_mode_switch(**args)


# ─────────────────────────────────────────────────────────────────────────────
# 1. THUẦN LOGIC — chạy được không cần Postgres
# ─────────────────────────────────────────────────────────────────────────────


def test_canva_khong_gat_duoc_sang_cycle_aligned():
    """Canva không có hoá đơn business để neo, và giá lượt bán ở chế độ này luôn đi
    qua đơn giá THÁNG của GPT (`payment_flow.fee_for_window`), bỏ qua bảng bậc thang
    Canva ⇒ gạt nhầm là âm thầm bán sai giá."""
    anchor, error = _plan(platform="canva", requested_anchor_day=25)
    assert anchor is None
    assert error is not None
    assert "Canva" in error


def test_canva_van_gat_ve_legacy_duoc():
    """Chặn là chặn chiều BẬT. Đưa một team Canva về chế độ cũ phải luôn chạy được,
    không thì lỡ tay có dữ liệu hỏng là không có đường lùi."""
    anchor, error = _plan(platform="canva", mode=BILLING_MODE_LEGACY_30D)
    assert error is None
    assert anchor is None


def test_khong_co_neo_va_khong_co_ngay_gia_han_thi_tu_choi():
    """Không có neo thì MỌI lượt bán sẽ ném 409 giữa chừng (`_require_anchor_day`) —
    gạt xong là hỏng cả workspace, nên phải chặn ngay lúc gạt."""
    anchor, error = _plan()
    assert anchor is None
    assert error is not None
    assert "ngày chốt chu kỳ" in error


def test_moi_ngay_neo_tu_ngay_gia_han_theo_gio_UTC():
    """MỒI ngày neo từ `renewal_date` PHẢI ép UTC trước khi đọc `.day`.

    `2026-07-26 02:00 +07` chính là `2026-07-25 19:00 UTC`: đọc `.day` trần ra 26,
    ép UTC mới ra 25. Lệch một ngày ở đây là lệch MỐC CHỐT của cả workspace ⇒ lệch
    hạn và lệch giá cho mọi email trong đó, mà `members/_shared.cycle_params` thì
    đọc theo UTC nên hai chỗ sẽ nói hai con số khác nhau.
    """
    anchor, error = _plan(renewal_date=datetime(2026, 7, 26, 2, 0, tzinfo=VN))
    assert error is None
    assert anchor == 25


def test_ngay_gia_han_naive_coi_nhu_UTC():
    """DB lưu UTC; giá trị naive (dữ liệu cũ) phải được coi là UTC, không đoán."""
    anchor, error = _plan(renewal_date=datetime(2026, 7, 25, 19, 0))
    assert error is None
    assert anchor == 25


def test_ngay_neo_nhap_tay_thang_ngay_gia_han():
    """Nhập tay là ý muốn tường minh của người gạt — đè lên giá trị mồi."""
    anchor, error = _plan(
        requested_anchor_day=1, renewal_date=datetime(2026, 7, 25, tzinfo=UTC)
    )
    assert error is None
    assert anchor == 1


def test_giu_ngay_neo_dang_co_khi_khong_nhap_gi():
    anchor, error = _plan(current_anchor_day=25)
    assert error is None
    assert anchor == 25


def test_ngay_ngoai_khoang_1_31_bi_tu_choi():
    """Khớp `ck_workspaces_cycle_anchor_day` / `ck_workspaces_cycle_force_day` trong
    `models.py`. Chặn ở đây để người gạt đọc được câu tiếng Việt thay vì lỗi ràng
    buộc DB."""
    for day in (0, 32, -1):
        anchor, error = _plan(requested_anchor_day=day)
        assert anchor is None
        assert error is not None and "1 tới 31" in error

    anchor, error = _plan(requested_anchor_day=25, requested_force_from_day=40)
    assert anchor is None
    assert error is not None and "Ngày ép thêm tháng" in error


def test_ve_legacy_khong_can_neo():
    """`legacy_30d` tính hạn bằng neo + số tháng × 30 ngày, không cần mốc nào."""
    anchor, error = _plan(mode=BILLING_MODE_LEGACY_30D)
    assert error is None
    assert anchor is None


def test_ve_legacy_giu_nguyen_ngay_neo_cu():
    """Gạt đi gạt lại không được làm mất cấu hình chu kỳ đã đặt."""
    anchor, error = _plan(mode=BILLING_MODE_LEGACY_30D, current_anchor_day=25)
    assert error is None
    assert anchor == 25


# ─────────────────────────────────────────────────────────────────────────────
# 2. ENDPOINT — cần Postgres
# ─────────────────────────────────────────────────────────────────────────────


def _set_renewal_date(ws: dict, when: datetime) -> None:
    """Đặt `renewal_date` cho workspace như extension đẩy billing về."""
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws["id"]))
        row.renewal_date = when
        db.commit()


def _ws_row(ws_id: str) -> dict:
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws_id))
        return {
            "billing_mode": row.billing_mode,
            "cycle_anchor_day": row.cycle_anchor_day,
            "cycle_cutoff_utc": row.cycle_cutoff_utc,
            "cycle_force_extra_from_day": row.cycle_force_extra_from_day,
        }


def _switch(client: TestClient, header: dict, ws_id: str, **body):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/billing-mode", json=body, headers=header
    )


def test_gat_sang_cycle_aligned_tra_ve_du_bon_truong(
    client: TestClient, auth_header: dict
):
    """Giao diện phải nhìn ra workspace nào đang ở chế độ nào — không thì gạt nhầm
    một không gian cũng chẳng ai thấy."""
    ws = create_ws(client, auth_header, "WS-MODE")
    _set_renewal_date(ws, datetime(2026, 7, 26, 2, 0, tzinfo=VN))

    resp = _switch(client, auth_header, ws["id"], mode="cycle_aligned")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["billing_mode"] == "cycle_aligned"
    # Ép UTC: 26/7 02:00 giờ VN = 25/7 19:00 UTC ⇒ mốc ngày 25.
    assert body["cycle_anchor_day"] == 25
    assert body["cycle_cutoff_utc"] is None
    assert body["cycle_force_extra_from_day"] is None

    got = client.get(f"/api/v1/workspaces/{ws['id']}", headers=auth_header).json()
    assert got["billing_mode"] == "cycle_aligned"
    assert got["cycle_anchor_day"] == 25


def test_gat_kem_gio_chot_va_nguong_ep_thang(client: TestClient, auth_header: dict):
    ws = create_ws(client, auth_header, "WS-MODE-PARAM")
    resp = _switch(
        client,
        auth_header,
        ws["id"],
        mode="cycle_aligned",
        cycle_anchor_day=25,
        cycle_cutoff_utc="04:30:00",
        cycle_force_extra_from_day=23,
    )
    assert resp.status_code == 200, resp.text
    row = _ws_row(ws["id"])
    assert row["cycle_anchor_day"] == 25
    assert row["cycle_cutoff_utc"] == dtime(4, 30)
    assert row["cycle_force_extra_from_day"] == 23


def test_gui_null_tuong_minh_thi_xoa_ghi_de(client: TestClient, auth_header: dict):
    """Gửi null = quay về giá trị chung của `payment_settings`. Không có đường xoá
    thì ghi đè lỡ tay đặt sai sẽ dính vĩnh viễn."""
    ws = create_ws(client, auth_header, "WS-MODE-CLEAR")
    _switch(
        client,
        auth_header,
        ws["id"],
        mode="cycle_aligned",
        cycle_anchor_day=25,
        cycle_cutoff_utc="04:30:00",
    )
    resp = _switch(
        client,
        auth_header,
        ws["id"],
        mode="cycle_aligned",
        cycle_cutoff_utc=None,
    )
    assert resp.status_code == 200, resp.text
    assert _ws_row(ws["id"])["cycle_cutoff_utc"] is None
    # Không gửi trường nào thì giữ nguyên: ngày neo vẫn còn.
    assert _ws_row(ws["id"])["cycle_anchor_day"] == 25


def test_canva_bi_tu_choi_bang_cau_tieng_viet(client: TestClient, auth_header: dict):
    ws = create_ws(client, auth_header, "WS-CANVA", platform="canva")
    resp = _switch(
        client, auth_header, ws["id"], mode="cycle_aligned", cycle_anchor_day=25
    )
    assert resp.status_code == 400, resp.text
    assert "Canva" in resp.json()["detail"]
    # Từ chối là KHÔNG ghi gì — dở dang còn tệ hơn không làm.
    row = _ws_row(ws["id"])
    assert row["billing_mode"] == "legacy_30d"
    assert row["cycle_anchor_day"] is None


def test_thieu_moc_neo_bi_tu_choi(client: TestClient, auth_header: dict):
    """Không có ngày chốt và cũng không có ngày gia hạn để suy ra ⇒ gạt xong là mọi
    lượt bán ném 409 giữa chừng. Chặn ngay tại đây."""
    ws = create_ws(client, auth_header, "WS-NO-ANCHOR")
    resp = _switch(client, auth_header, ws["id"], mode="cycle_aligned")
    assert resp.status_code == 400, resp.text
    assert "ngày chốt chu kỳ" in resp.json()["detail"]
    assert _ws_row(ws["id"])["billing_mode"] == "legacy_30d"


def test_ngay_ngoai_khoang_bi_tu_choi_bang_cau_tieng_viet(
    client: TestClient, auth_header: dict
):
    """Phải là câu người đọc được, không phải cấu trúc lỗi 422 của pydantic."""
    ws = create_ws(client, auth_header, "WS-BAD-DAY")
    resp = _switch(
        client, auth_header, ws["id"], mode="cycle_aligned", cycle_anchor_day=32
    )
    assert resp.status_code == 400, resp.text
    assert "1 tới 31" in resp.json()["detail"]


def test_gat_khong_dung_han_cua_ai(client: TestClient, auth_header: dict):
    """§3.6.8 — gạt sang `cycle_aligned` KHÔNG đụng ai đang chạy.

    Hạn hiện tại giữ nguyên, không migration, không thu thêm, không cắt bớt: lần gia
    hạn kế tiếp tự rơi vào luật §3.6.2 và nhờ ĐIỂM NỐI mà khách trả đúng số ngày từ
    hạn cũ tới mốc. Ai "tiện tay migrate cho đẹp" là cắt mất thời gian khách đã trả
    tiền — im lặng, không ai thấy.
    """
    from app.db import SessionLocal
    from app.models import Member

    ws = create_ws(client, auth_header, "WS-KEEP-END")
    end_at = datetime(2026, 9, 14, 8, 15, 30, tzinfo=UTC)
    with SessionLocal() as db:
        db.add(
            Member(
                workspace_id=uuid.UUID(ws["id"]),
                email="giu-han@example.com",
                status="active",
                subscription_months=1,
                subscription_purchased_at=datetime(2026, 8, 15, 8, 15, 30, tzinfo=UTC),
                subscription_end_at=end_at,
            )
        )
        db.commit()

    resp = _switch(
        client, auth_header, ws["id"], mode="cycle_aligned", cycle_anchor_day=25
    )
    assert resp.status_code == 200, resp.text

    with SessionLocal() as db:
        row = (
            db.query(Member)
            .filter(Member.workspace_id == uuid.UUID(ws["id"]))
            .one()
        )
        assert row.subscription_end_at == end_at
        assert row.subscription_months == 1


def test_ghi_nhat_ky_ca_bon_truong(client: TestClient, auth_header: dict):
    """Gạt chế độ tính tiền mà không có dấu vết là không đối soát được."""
    ws = create_ws(client, auth_header, "WS-AUDIT-MODE")
    _switch(
        client,
        auth_header,
        ws["id"],
        mode="cycle_aligned",
        cycle_anchor_day=25,
        cycle_cutoff_utc="03:00:00",
        cycle_force_extra_from_day=23,
    )
    logs = client.get(
        "/api/v1/audit-logs",
        params={"action": "WORKSPACE_BILLING_MODE_SET"},
        headers=auth_header,
    )
    assert logs.status_code == 200, logs.text
    rows = [r for r in logs.json() if r["target_id"] == ws["id"]]
    assert rows, logs.text
    data = rows[0]["data"]
    for field in (
        "billing_mode",
        "cycle_anchor_day",
        "cycle_cutoff_utc",
        "cycle_force_extra_from_day",
    ):
        assert field in data, data
        assert "before" in data[field] and "after" in data[field]
    assert data["billing_mode"] == {"before": "legacy_30d", "after": "cycle_aligned"}
    # Giờ chốt phải là CHUỖI: `datetime.time` thô không qua được json.dumps của
    # JSONB `data` ⇒ 500 ngay lúc gạt cầu dao.
    assert data["cycle_cutoff_utc"]["after"] == "03:00:00"


def test_dai_ly_khong_gat_duoc(client: TestClient, auth_header: dict):
    """Đổi cách tính tiền của cả không gian là việc của super-admin."""
    ws = create_ws(client, auth_header, "WS-SUB-DENY")
    sub = create_user(client, auth_header, "subgatmode", ["MEMBER_VIEW"])
    token = login(client, sub["username"])
    resp = _switch(
        client, bearer(token), ws["id"], mode="cycle_aligned", cycle_anchor_day=25
    )
    assert resp.status_code == 403, resp.text
    assert _ws_row(ws["id"])["billing_mode"] == "legacy_30d"


def test_patch_workspace_khong_gat_duoc_che_do(client: TestClient, auth_header: dict):
    """Cầu dao CỐ Ý không nằm trong PATCH chung: gửi kèm `billing_mode` vào đó phải
    KHÔNG có tác dụng gì, để không ai gạt nhầm lúc đang sửa tên workspace."""
    ws = create_ws(client, auth_header, "WS-PATCH-MODE")
    resp = client.patch(
        f"/api/v1/workspaces/{ws['id']}",
        json={"name": "WS-PATCH-MODE-2", "billing_mode": "cycle_aligned"},
        headers=auth_header,
    )
    assert resp.status_code == 200, resp.text
    assert _ws_row(ws["id"])["billing_mode"] == "legacy_30d"
