"""HOÁ ĐƠN QUYẾT ĐỊNH MỐC CHU KỲ (chốt user 2026-09-08, EXPIRY_RULES §3.6.3).

VÌ SAO CÓ FILE NÀY: ở chế độ `cycle_aligned`, mốc chốt chu kỳ là thứ định ra hạn dùng
và giá của MỌI email trong workspace. Trước 8/9/2026 mốc tự cuộn theo tháng và hoá đơn
dán về mà lệch ngày thì bị CHẶN, bắt tích ô xác nhận rồi dán lại lần hai. Luật mới:
hoá đơn là chứng từ của chính ChatGPT nên nó QUYẾT ĐỊNH mốc — con số ta tự cuộn chỉ là
phỏng đoán, còn bắt xác nhận mỗi kỳ chỉ dạy người ta tích ô cho xong rồi bấm tiếp.

Ba ngả, mỗi ngả một lý do:

  - Hoá đơn của kỳ ĐANG chạy / SẮP tới mà lệch ngày → DỜI MỐC NGAY, không hỏi, ghi
    `WORKSPACE_CYCLE_MISMATCH` / `SUCCESS` (`outcome=auto_applied`).
  - Hoá đơn CŨ (kỳ của nó kết thúc trước cả mốc mở của kỳ đang chạy) → VẪN LƯU vào
    danh sách vì báo cáo tài chính cần nó, nhưng KHÔNG đụng tới mốc. Đây là ca thật hay
    gặp: super-admin dán bù cả xấp hoá đơn cũ để tính chi phí — cho chúng dời mốc là
    kéo mốc của cả workspace về quá khứ.
  - Chưa có mốc nào → chính hoá đơn này mồi ra mốc, ghi như cũ.

HAI CỬA VÀO, MỘT LUẬT: dán tay (`billing-paste`, JWT super-admin) và extension tự quét
(`billing-sync`, X-API-KEY) đều đi qua `decide_cycle_anchor`. Chép luật ra hai nơi là
hai cửa cho ra hai mốc khác nhau, nên file này khoá cả hai cửa.

Workspace `legacy_30d` KHÔNG đụng tới: ở chế độ đó mốc chu kỳ không tham gia tính hạn
của ai cả nên chẳng có gì để bảo vệ — hành vi cũ phải giữ nguyên từng dòng.
"""

import uuid
from datetime import datetime, time as dtime, timedelta, timezone

from fastapi.testclient import TestClient

from app.routers.workspaces.billing import (
    CYCLE_ANCHOR_AUTO_APPLIED,
    CYCLE_ANCHOR_MATCHED,
    CYCLE_ANCHOR_OUT_OF_RANGE,
    CYCLE_ANCHOR_NO_ANCHOR,
    CYCLE_ANCHOR_STALE_KEPT,
    cycle_mismatch_day,
    decide_cycle_anchor,
)
from tests.wallet_helpers import create_ws

VN = timezone(timedelta(hours=7))
UTC = timezone.utc
CUTOFF = dtime(3, 0)  # mặc định hệ thống = 10h giờ VN


# ─────────────────────────────────────────────────────────────────────────────
# 1. ĐỊNH NGHĨA "LỆCH MỐC" — thuần logic, chạy được không cần Postgres
# ─────────────────────────────────────────────────────────────────────────────


def test_dung_ngay_neo_thi_khong_lech():
    assert cycle_mismatch_day(datetime(2026, 9, 25, 3, 0, tzinfo=UTC), 25, CUTOFF) is None


def test_lech_mot_ngay_thi_bao_moc_dang_chay():
    assert cycle_mismatch_day(datetime(2026, 9, 24, 3, 0, tzinfo=UTC), 25, CUTOFF) == 25


def test_khong_so_gio_chi_so_ngay():
    """Giờ trong `period_end` là giờ của Stripe, còn giờ chốt là con số ta tự đặt —
    so cả giờ thì hoá đơn nào cũng "lệch" và mốc bị dời mỗi lần dán."""
    assert cycle_mismatch_day(datetime(2026, 9, 25, 0, 0, tzinfo=UTC), 25, CUTOFF) is None
    assert cycle_mismatch_day(datetime(2026, 9, 25, 23, 59, tzinfo=UTC), 25, CUTOFF) is None


def test_ngay_neo_31_roi_vao_thang_ngan_van_la_khop():
    """Luật "ngày neo 29/30/31 rơi vào tháng ngắn thì lùi về ngày cuối tháng" phải
    tính CÙNG một cách với `_boundary_on`. Tự viết `anchor_day != period_end.day` là
    báo động giả cho mọi tháng ngắn — và giờ báo động giả không còn dừng lại ở một
    cảnh báo nữa: nó DỜI MỐC của cả workspace về ngày cuối tháng ngắn."""
    assert cycle_mismatch_day(datetime(2026, 2, 28, 3, 0, tzinfo=UTC), 31, CUTOFF) is None
    assert cycle_mismatch_day(datetime(2026, 4, 30, 3, 0, tzinfo=UTC), 31, CUTOFF) is None
    # Tháng 2 năm nhuận có 29 ngày ⇒ mốc là 29, hoá đơn chốt 28 là LỆCH thật.
    assert cycle_mismatch_day(datetime(2024, 2, 28, 3, 0, tzinfo=UTC), 31, CUTOFF) == 29


def test_ep_UTC_truoc_khi_doc_ngay():
    """`26/9 02:00 +07` chính là `25/9 19:00 UTC`. Đọc `.day` trần ra 26 ⇒ tưởng lệch
    rồi dời mốc của cả workspace sang ngày 26 vì một phép đọc sai múi giờ."""
    assert cycle_mismatch_day(datetime(2026, 9, 26, 2, 0, tzinfo=VN), 25, CUTOFF) is None


def test_naive_coi_nhu_UTC():
    assert cycle_mismatch_day(datetime(2026, 9, 25, 3, 0), 25, CUTOFF) is None


# ─────────────────────────────────────────────────────────────────────────────
# 2. LUẬT BA NGẢ — hàm thuần, cũng không cần Postgres
# ─────────────────────────────────────────────────────────────────────────────

CYCLE_START = datetime(2026, 9, 25, 3, 0, tzinfo=UTC)
# Kỳ đang chạy 25/9 → 25/10; "hôm nay" nằm GIỮA kỳ. Chọn cố ý: khoảng
# [mốc mở, hôm nay) chính là chỗ bản đầu để lọt hoá đơn cũ.
NOW = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
MAX_END = datetime(2026, 11, 25, 3, 0, tzinfo=UTC)  # mốc kế tiếp sau kỳ đang chạy


def _decide(period_end: datetime, *, anchor_day: int | None = 25, now=NOW, max_end=MAX_END):
    return decide_cycle_anchor(
        period_end=period_end,
        anchor_day=anchor_day,
        cutoff=CUTOFF,
        now=now,
        max_period_end=None if anchor_day is None else max_end,
        invoice_number="MSNS6RGC-0042",
    )


def test_hoa_don_ky_KE_TIEP_lech_ngay_van_duoc_doi_moc():
    """Trần là mốc kế tiếp, không phải mốc của kỳ đang chạy — hoá đơn kỳ sau vẫn vào."""
    d = _decide(datetime(2026, 11, 24, 9, 0, tzinfo=UTC))
    assert d.outcome == CYCLE_ANCHOR_AUTO_APPLIED
    assert d.anchor_day_after == 24


def test_khop_moc_thi_khong_dong_gi_va_khong_log():
    d = _decide(datetime(2026, 10, 25, 9, 0, tzinfo=UTC))
    assert d.outcome == CYCLE_ANCHOR_MATCHED
    assert d.anchor_day_after is None
    assert d.write_renewal_date is True
    assert d.log_result is None


def test_ky_dang_chay_lech_ngay_thi_doi_moc_ngay():
    """Không hỏi, không cờ xác nhận: hoá đơn nói mốc là ngày 27 thì mốc là ngày 27."""
    d = _decide(datetime(2026, 10, 27, 9, 0, tzinfo=UTC))
    assert d.outcome == CYCLE_ANCHOR_AUTO_APPLIED
    assert d.anchor_day_after == 27
    assert d.write_renewal_date is True
    assert d.log_result == "SUCCESS"
    assert d.log_data["anchor_day_before"] == 25
    assert d.log_data["anchor_day_after"] == 27
    assert d.log_data["invoice_number"] == "MSNS6RGC-0042"


def test_hoa_don_cu_NAM_TRONG_ky_dang_chay_cung_khong_doi_moc():
    """Ca mà bản đầu để lọt: ngày chốt đã TRÔI QUA nhưng vẫn sau mốc mở của kỳ.

    Neo 25, hôm nay 8/10, kỳ mở từ 25/9. Dán bù một hoá đơn cũ chốt ngày 5/10 —
    nằm trong kỳ đang chạy nhưng đã qua. Lấy mốc mở làm ranh giới thì nó lọt vào
    nhánh "kỳ hiện tại" và kéo mốc cả không gian về ngày 5. So với HIỆN TẠI mới
    đúng: hoá đơn của kỳ đang chạy thì kỳ chưa đóng, ngày chốt phải ở tương lai."""
    d = _decide(datetime(2026, 10, 5, 9, 0, tzinfo=UTC))
    assert d.outcome == CYCLE_ANCHOR_STALE_KEPT
    assert d.anchor_day_after is None
    assert d.write_renewal_date is False


def test_ngay_chot_qua_xa_thi_khong_doi_moc():
    """Bỏ chặn hỏi mà không đặt trần thì một con số rác cũng dời được mốc.

    Dán nhầm năm (27/3/2027) khi neo đang là 25: quá mốc kế tiếp rất xa, không thể
    là hoá đơn của kỳ đang chạy hay kỳ sắp tới."""
    d = _decide(datetime(2027, 3, 27, 9, 0, tzinfo=UTC))
    assert d.outcome == CYCLE_ANCHOR_OUT_OF_RANGE
    assert d.anchor_day_after is None
    assert d.write_renewal_date is False
    assert d.log_result == "SKIPPED"


def test_hoa_don_cu_thi_khong_dong_toi_moc():
    """Chốt bảo vệ việc dán bù hoá đơn cũ: kỳ của nó kết thúc trước cả mốc mở của kỳ
    đang chạy nên nó không thể đang mô tả mốc hiện tại. Cả `renewal_date` cũng không
    được ghi — `cycle_params` mồi mốc từ chính cột đó khi `cycle_anchor_day` trống."""
    d = _decide(datetime(2026, 7, 24, 9, 0, tzinfo=UTC))
    assert d.outcome == CYCLE_ANCHOR_STALE_KEPT
    assert d.anchor_day_after is None
    assert d.write_renewal_date is False
    assert d.log_result == "SKIPPED"


def test_neo_moi_lay_ngay_da_ep_UTC():
    """`27/10 02:00 +07` = `26/10 19:00 UTC`. Lấy `.day` trần là neo vào 27, lệch MỘT
    ngày so với cách `_shared.cycle_params` đọc — lệch mốc của cả workspace."""
    d = _decide(datetime(2026, 10, 27, 2, 0, tzinfo=VN))
    assert d.anchor_day_after == 26
    assert d.log_data["pasted_day"] == 26


def test_chua_co_moc_thi_khong_co_gi_de_lech():
    d = _decide(datetime(2026, 10, 13, 9, 0, tzinfo=UTC), anchor_day=None)
    assert d.outcome == CYCLE_ANCHOR_NO_ANCHOR
    assert d.anchor_day_after is None
    assert d.write_renewal_date is True
    assert d.log_result is None


# ─────────────────────────────────────────────────────────────────────────────
# 3. ENDPOINT — cần Postgres
# ─────────────────────────────────────────────────────────────────────────────

ANCHOR_DAY = 25


def _switch_cycle_aligned(client: TestClient, header: dict, ws_id: str) -> None:
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/billing-mode",
        json={"mode": "cycle_aligned", "cycle_anchor_day": ANCHOR_DAY},
        headers=header,
    )
    assert resp.status_code == 200, resp.text


def _cycle_bounds(ws_id: str) -> tuple[datetime, datetime]:
    """Mốc mở / mốc chốt của chu kỳ ĐANG chạy — đọc bằng chính helper của hệ thống,
    để test không tự chế lại phép tính mốc (chế lại là hai nơi trôi khỏi nhau)."""
    from app.db import SessionLocal
    from app.models import Workspace
    from app.routers.members._shared import cycle_settings, workspace_cycle

    with SessionLocal() as db:
        ws = db.get(Workspace, uuid.UUID(ws_id))
        return workspace_cycle(
            ws, datetime.now(timezone.utc), settings_row=cycle_settings(db)
        )


def _ws_row(ws_id: str) -> tuple[datetime | None, int | None]:
    """`(renewal_date, cycle_anchor_day)` đọc thẳng từ DB."""
    from app.db import SessionLocal
    from app.models import Workspace

    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws_id))
        return row.renewal_date, row.cycle_anchor_day


def _paste(
    client: TestClient, header: dict, ws_id: str, period_end: datetime, **extra
):
    body = {
        "quantity": 10,
        "unit_price_vnd": 330_000,
        "subtotal_vnd": 3_300_000,
        "vat_vnd": 330_000,
        "total_vnd": 3_630_000,
        "amount_vnd": 3_630_000,
        "date": period_end.isoformat(),
        "period_start": (period_end - timedelta(days=31)).isoformat(),
        "period_end": period_end.isoformat(),
        "invoice_number": f"MSNS6RGC-{period_end:%Y%m%d}",
    }
    body.update(extra)
    return client.post(
        f"/api/v1/workspaces/{ws_id}/billing-paste", json=body, headers=header
    )


def _sync(client: TestClient, ws: dict, renewal_date: datetime):
    return client.post(
        "/api/v1/workspaces/billing-sync",
        json={"renewal_date": renewal_date.isoformat()},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )


def _cycle_logs(client: TestClient, header: dict, ws_id: str) -> list[dict]:
    resp = client.get(
        "/api/v1/audit-logs",
        params={"action": "WORKSPACE_CYCLE_MISMATCH", "limit": 200},
        headers=header,
    )
    assert resp.status_code == 200, resp.text
    return [r for r in resp.json() if r["target_id"] == ws_id]


# ── 3.1 Đường DÁN TAY ────────────────────────────────────────────────────────


def test_legacy_van_dan_duoc_moi_hoa_don(client: TestClient, auth_header: dict):
    """Workspace chưa gạt cầu dao phải chạy y như trước: dán là ghi, không hỏi gì, và
    KHÔNG sinh ra mốc chu kỳ nào."""
    ws = create_ws(client, auth_header, "WS-PASTE-LEGACY")
    period_end = datetime(2026, 9, 13, 3, 0, tzinfo=UTC)
    resp = _paste(client, auth_header, ws["id"], period_end)
    assert resp.status_code == 200, resp.text
    assert _ws_row(ws["id"]) == (period_end, None)
    assert not _cycle_logs(client, auth_header, ws["id"])


def test_dung_moc_thi_ghi_binh_thuong(client: TestClient, auth_header: dict):
    ws = create_ws(client, auth_header, "WS-PASTE-MATCH")
    _switch_cycle_aligned(client, auth_header, ws["id"])
    _start, end = _cycle_bounds(ws["id"])

    resp = _paste(client, auth_header, ws["id"], end)
    assert resp.status_code == 200, resp.text
    assert _ws_row(ws["id"]) == (end, ANCHOR_DAY)
    assert not _cycle_logs(client, auth_header, ws["id"])


def test_hoa_don_ky_dang_chay_lech_thi_doi_moc_ngay(
    client: TestClient, auth_header: dict
):
    """Không còn 409, không còn ô tích: dán một lần là mốc đi theo hoá đơn."""
    ws = create_ws(client, auth_header, "WS-PASTE-MOVE")
    _switch_cycle_aligned(client, auth_header, ws["id"])
    _start, end = _cycle_bounds(ws["id"])
    lech = end - timedelta(days=1)  # cùng kỳ đang chạy, nhưng chốt ngày 24

    resp = _paste(client, auth_header, ws["id"], lech)
    assert resp.status_code == 200, resp.text
    assert resp.json()["cycle_anchor_day"] == lech.day

    # ⚠️ ĐÂY MỚI LÀ ĐIỀU PHẢI KHOÁ: `renewal_date` KHÔNG phải thứ quyết định mốc —
    # `cycle_params` đọc `cycle_anchor_day` trước và chỉ mồi từ `renewal_date` khi cột
    # kia còn NULL, mà đường gạt chế độ luôn điền sẵn nó. Assert mỗi `renewal_date` là
    # test vẫn xanh trong khi MỐC THẬT đứng im.
    _start2, end2 = _cycle_bounds(ws["id"])
    assert end2.day == lech.day, (end2, lech)
    assert _ws_row(ws["id"]) == (lech, lech.day)

    # Hoá đơn vẫn phải vào danh sách.
    invoices = resp.json()["billing_invoices"] or []
    assert len(invoices) == 1, invoices

    logs = _cycle_logs(client, auth_header, ws["id"])
    assert len(logs) == 1, logs
    assert logs[0]["result"] == "SUCCESS"
    assert logs[0]["actor_type"] == "ADMIN"
    assert logs[0]["data"]["outcome"] == CYCLE_ANCHOR_AUTO_APPLIED
    assert logs[0]["data"]["anchor_day_before"] == ANCHOR_DAY
    assert logs[0]["data"]["anchor_day_after"] == lech.day

    # Dán lại chính hoá đơn ấy thì im lặng — mốc đã theo nó rồi, không log thêm.
    assert _paste(client, auth_header, ws["id"], lech).status_code == 200
    assert len(_cycle_logs(client, auth_header, ws["id"])) == 1


def test_hoa_don_cu_van_luu_nhung_khong_doi_moc(client: TestClient, auth_header: dict):
    """Ca hỏng thật cần tránh: super-admin dán bù hoá đơn CŨ cho báo cáo tài chính.

    Hoá đơn vẫn phải vào danh sách (không thì công dán mất trắng và báo cáo hụt),
    nhưng mốc chu kỳ thì giữ nguyên — kéo mốc về quá khứ là đổi hạn và đổi giá của
    mọi email trong không gian, mà trên màn hình không có gì bật lên.
    """
    ws = create_ws(client, auth_header, "WS-PASTE-STALE")
    _switch_cycle_aligned(client, auth_header, ws["id"])
    start, _end = _cycle_bounds(ws["id"])
    cu = (start - timedelta(days=40)).replace(day=24)

    resp = _paste(client, auth_header, ws["id"], cu)
    assert resp.status_code == 200, resp.text
    invoices = resp.json()["billing_invoices"] or []
    assert len(invoices) == 1, invoices
    assert invoices[0]["period_end"] == cu.isoformat()

    # Mốc KHÔNG bị kéo về quá khứ — cả `renewal_date` lẫn `cycle_anchor_day`.
    assert _ws_row(ws["id"]) == (None, ANCHOR_DAY)
    _start2, end2 = _cycle_bounds(ws["id"])
    assert end2.day == ANCHOR_DAY

    logs = _cycle_logs(client, auth_header, ws["id"])
    assert len(logs) == 1, logs
    assert logs[0]["result"] == "SKIPPED"
    assert logs[0]["data"]["outcome"] == CYCLE_ANCHOR_STALE_KEPT


def test_chua_co_moc_thi_ban_dan_van_moi_duoc(client: TestClient, auth_header: dict):
    """Workspace `cycle_aligned` mà chưa có ngày chốt (gạt bằng SQL tay) thì không có
    gì để lệch — chính bản dán này là thứ mồi ra mốc, phải cho ghi như cũ."""
    from app.db import SessionLocal
    from app.models import Workspace

    ws = create_ws(client, auth_header, "WS-PASTE-NO-ANCHOR")
    with SessionLocal() as db:
        row = db.get(Workspace, uuid.UUID(ws["id"]))
        row.billing_mode = "cycle_aligned"
        db.commit()

    period_end = datetime(2026, 9, 13, 3, 0, tzinfo=UTC)
    resp = _paste(client, auth_header, ws["id"], period_end)
    assert resp.status_code == 200, resp.text
    assert _ws_row(ws["id"]) == (period_end, None)
    assert not _cycle_logs(client, auth_header, ws["id"])


# ── 3.2 Đường EXTENSION TỰ QUÉT (`billing-sync`) ─────────────────────────────
#
# `renewal_date` extension gửi lên là ngày kết thúc "Current cycle" đọc ở tab Kế
# hoạch — cùng một con số với `period_end` của hoá đơn kỳ đó, nên nó dời mốc được y
# như bản dán tay. Trước 8/9/2026 đường này ghi thẳng `renewal_date` không qua chốt
# nào: hoá đơn cũ quét về cũng kéo mốc lùi, còn workspace đã có `cycle_anchor_day`
# thì mốc đứng im dù ChatGPT đã đổi kỳ.


def test_sync_doi_duoc_moc_chu_ky(client: TestClient, auth_header: dict):
    ws = create_ws(client, auth_header, "WS-SYNC-MOVE")
    _switch_cycle_aligned(client, auth_header, ws["id"])
    _start, end = _cycle_bounds(ws["id"])
    lech = end - timedelta(days=1)

    resp = _sync(client, ws, lech)
    assert resp.status_code == 200, resp.text
    assert resp.json()["cycle_anchor_day"] == lech.day
    assert _ws_row(ws["id"]) == (lech, lech.day)
    _start2, end2 = _cycle_bounds(ws["id"])
    assert end2.day == lech.day, (end2, lech)

    logs = _cycle_logs(client, auth_header, ws["id"])
    assert len(logs) == 1, logs
    assert logs[0]["result"] == "SUCCESS"
    # Không có người dùng nào phía sau (auth bằng X-API-KEY) nên actor là EXTENSION,
    # đúng quy ước của mọi nhật ký do extension sinh ra.
    assert logs[0]["actor_type"] == "EXTENSION"
    assert logs[0]["data"]["anchor_day_after"] == lech.day


def test_sync_ky_cu_thi_khong_keo_moc_ve_qua_khu(
    client: TestClient, auth_header: dict
):
    ws = create_ws(client, auth_header, "WS-SYNC-STALE")
    _switch_cycle_aligned(client, auth_header, ws["id"])
    start, _end = _cycle_bounds(ws["id"])
    cu = (start - timedelta(days=40)).replace(day=24)

    resp = _sync(client, ws, cu)
    assert resp.status_code == 200, resp.text
    # Mốc giữ nguyên, và `renewal_date` cũng không bị ghi (nó là thứ mồi ra mốc khi
    # `cycle_anchor_day` còn trống).
    assert _ws_row(ws["id"]) == (None, ANCHOR_DAY)

    logs = _cycle_logs(client, auth_header, ws["id"])
    assert len(logs) == 1, logs
    assert logs[0]["result"] == "SKIPPED"
    assert logs[0]["actor_type"] == "EXTENSION"


def test_sync_legacy_giu_nguyen_hanh_vi_cu(client: TestClient, auth_header: dict):
    """Workspace `legacy_30d`: sync ghi `renewal_date` như xưa, không đẻ mốc chu kỳ,
    không ghi thêm dòng nhật ký nào."""
    ws = create_ws(client, auth_header, "WS-SYNC-LEGACY")
    ngay = datetime(2026, 9, 13, 3, 0, tzinfo=UTC)

    resp = _sync(client, ws, ngay)
    assert resp.status_code == 200, resp.text
    assert _ws_row(ws["id"]) == (ngay, None)
    assert not _cycle_logs(client, auth_header, ws["id"])
    # Hoá đơn cũ quét về cũng vẫn ghi đè như trước — nhánh cũ không được đổi một dòng.
    cu = datetime(2026, 6, 13, 3, 0, tzinfo=UTC)
    assert _sync(client, ws, cu).status_code == 200
    assert _ws_row(ws["id"]) == (cu, None)
    assert not _cycle_logs(client, auth_header, ws["id"])
