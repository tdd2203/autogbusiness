"""Khoá số của chế độ `cycle_aligned` — luật ở `app/routers/members/EXPIRY_RULES.md` §3.6.

VÌ SAO CÓ FILE NÀY: chế độ này quyết định TIỀN của mọi lượt bán, mà sai thì sai hàng
loạt và im lặng — hạn vẫn hiện ra một con số trông hợp lý, chỉ có điều thu thiếu hoặc
thu thừa. Mọi con số dưới đây đã được user duyệt tay ngày 2026-09-07; đổi kết quả test
nghĩa là đổi luật, phải sửa EXPIRY_RULES trước rồi mới sửa ở đây.

Bốn nhóm dễ hỏng nhất, mỗi nhóm một lớp test:

1. `half_days_between` — quy tắc nửa ngày. Ranh giới ĐÚNG 12 tiếng và phần dư ĐÚNG 0 là
   hai chỗ off-by-one kinh điển.
2. `workspace_cycle` — mốc tự cuộn theo tháng dương lịch, kể cả ngày neo 31 rơi vào
   tháng ngắn.
3. `quote_cycle` — ĐIỂM NỐI (chống thu trùng khi gia hạn sớm) và ngưỡng ép thêm tháng.
4. Bảng giá đầu-cuối — chốt lại đúng những con số user đã xem.

Test THUẦN LOGIC: không đụng DB, dùng workspace giả. Riêng `test_cot_workspace_ton_tai`
chạm model thật để bắt ca đổi tên cột mà quên sửa helper.
"""

from datetime import datetime, time as dtime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.models import BILLING_MODE_CYCLE_ALIGNED, MemberSubscriptionCycle, Workspace
from app.services.payment_flow import fee_for_window, prorated_fee
from app.routers.members._shared import (
    half_days_between,
    is_cycle_aligned,
    next_boundary,
    quote_cycle,
    sold_window,
    workspace_cycle,
)

VN = timezone(timedelta(hours=7))  # giờ user nghĩ trong đầu
UTC = timezone.utc

UNIT_VND = 330_000  # đơn giá 1 tháng dùng cho mọi ví dụ đã duyệt
ROUND_TO = 1_000


def _ws(anchor_day: int, *, cutoff=dtime(3, 0), force_from: int = 23):
    """Workspace giả — helper chỉ đọc thuộc tính, không cần ORM/DB."""
    return SimpleNamespace(
        billing_mode=BILLING_MODE_CYCLE_ALIGNED,
        cycle_anchor_day=anchor_day,
        cycle_cutoff_utc=cutoff,
        cycle_force_extra_from_day=force_from,
        renewal_date=None,
    )


def _utc(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


def _vn(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=VN)


_USER = SimpleNamespace(invite_fee_vnd=UNIT_VND)
_SETTINGS = SimpleNamespace(price_round_to_vnd=ROUND_TO, invite_fee_vnd=UNIT_VND)


def _fee(quote) -> int:
    """Tiền thật, qua `payment_flow.fee_for_window` (EXPIRY_RULES §3.6.5).

    `settings_row` truyền sẵn nên hàm không đụng DB — `db=None` là cố ý.
    """
    return fee_for_window(
        None,
        _USER,
        prorated_half_days=quote.prorated_half_days,
        cycle_days=quote.cycle_days,
        whole_months=quote.whole_months,
        settings_row=_SETTINGS,
    )


# ── 1. Quy tắc nửa ngày ─────────────────────────────────────────────────────


def test_vi_du_user_mua_sang_va_mua_toi():
    """Ca user tự tính tay: mốc kick ngày 30 lúc 10:00.

    Mua ngày 20 lúc 10:00 → tròn 10 ngày. Mua ngày 20 lúc 23:00 → 9 ngày 11 tiếng, dư
    11 tiếng ≤ 12 ⇒ 9,5 ngày. Mua buổi tối RẺ HƠN nửa ngày tiền, cố ý.
    """
    moc = _utc(2026, 9, 30, 10)
    assert half_days_between(_utc(2026, 9, 20, 10), moc) == 20  # 10 ngày
    assert half_days_between(_utc(2026, 9, 20, 23), moc) == 19  # 9,5 ngày


@pytest.mark.parametrize(
    "mua, mong_doi, y_nghia",
    [
        (_utc(2026, 9, 20, 10), 20, "dư đúng 0 ⇒ KHÔNG cộng thừa nửa ngày nào"),
        (_utc(2026, 9, 20, 22), 19, "dư ĐÚNG 12 tiếng ⇒ vẫn là nửa ngày"),
        (_utc(2026, 9, 20, 21, 59), 20, "dư 12h01 ⇒ mới lên trọn ngày"),
        (_utc(2026, 9, 30, 9), 1, "chưa tới 1 tiếng ⇒ nửa ngày"),
        (_utc(2026, 9, 30, 10), 0, "đúng mốc ⇒ 0"),
        (_utc(2026, 10, 1), 0, "đã qua mốc ⇒ 0, KHÔNG âm"),
    ],
)
def test_ranh_gioi_nua_ngay(mua, mong_doi, y_nghia):
    assert half_days_between(mua, _utc(2026, 9, 30, 10)) == mong_doi, y_nghia


# ── 2. Mốc chu kỳ tự cuộn ───────────────────────────────────────────────────


def test_chu_ky_tu_cuon_theo_thang_duong_lich():
    """31 ngày cho 25/7→25/8, KHÔNG phải 30 ngày cứng như chế độ cũ."""
    start, end = workspace_cycle(_ws(25), _utc(2026, 8, 5, 1))
    assert (start, end) == (_utc(2026, 7, 25, 3), _utc(2026, 8, 25, 3))
    assert (end - start).days == 31


def test_moc_ngay_31_lui_ve_cuoi_thang_ngan():
    """Neo ngày 31 mà tháng 2 chỉ có 28 ngày ⇒ lùi về 28/2, không được mất mốc."""
    start, end = workspace_cycle(_ws(31), _utc(2026, 2, 10))
    assert (start, end) == (_utc(2026, 1, 31, 3), _utc(2026, 2, 28, 3))
    assert next_boundary(_ws(31), end) == _utc(2026, 3, 31, 3)


def test_dung_moc_thuoc_ve_ky_MOI():
    """`at` đúng bằng mốc ⇒ mở kỳ mới. Trước mốc 1 giây vẫn là kỳ cũ."""
    ws = _ws(25)
    assert workspace_cycle(ws, _utc(2026, 8, 25, 3))[0] == _utc(2026, 8, 25, 3)
    assert workspace_cycle(ws, _utc(2026, 8, 25, 2, 59))[1] == _utc(2026, 8, 25, 3)


def test_workspace_chua_co_moc_thi_bao_loi_ro_rang():
    """Thiếu `cycle_anchor_day` mà cứ tính bừa là bán sai giá im lặng — phải chặn."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        workspace_cycle(_ws(None), _utc(2026, 8, 5))
    assert e.value.status_code == 409


# ── 3. ĐIỂM NỐI + ngưỡng ép thêm tháng ──────────────────────────────────────


def test_gia_han_som_khong_thu_trung():
    """Ca thật §3.6.2: chu kỳ 25/8→25/9, khách còn hạn tới 12/9, bấm gia hạn ngày 1/9.

    Điểm nối phải là 12/9 (hạn cũ) chứ không phải 1/9 (lúc bấm). Đếm từ lúc bấm sẽ ra
    24 ngày ⇒ THU TRÙNG 11 ngày khách đã trả.
    """
    q = quote_cycle(
        _ws(25), _utc(2026, 9, 1), current_end=_utc(2026, 9, 12, 3)
    )
    assert q.join_at == _utc(2026, 9, 12, 3)
    assert q.prorated_half_days == 26  # 13 ngày
    assert q.end_at == _utc(2026, 9, 25, 3)
    assert _fee(q) == 139_000


def test_gia_han_muon_khong_tinh_lui_ve_qua_khu():
    """Hạn cũ đã qua ⇒ điểm nối = now, không cộng ngược phần đã hết."""
    q = quote_cycle(
        _ws(25), _utc(2026, 8, 22, 9), current_end=_utc(2026, 8, 20, 3)
    )
    assert q.join_at == _utc(2026, 8, 22, 9)
    assert q.prorated_half_days == 6  # 3 ngày
    assert q.forced_extra_month is True


def test_gia_han_khi_da_hoi_tu_la_tron_mot_thang():
    """Điểm nối = đúng mốc cũ ⇒ KHÔNG có phần lẻ, trả tròn 1 tháng.

    Đây là ca phổ biến nhất về lâu dài. Nếu nó ra "62 nửa ngày" thay vì "1 tháng" thì
    hoá đơn và giao diện sẽ đọc ra một con số ngày kỳ quặc.
    """
    q = quote_cycle(
        _ws(25), _utc(2026, 8, 20), current_end=_utc(2026, 8, 25, 3)
    )
    assert q.prorated_half_days == 0
    assert q.whole_months == 1
    assert q.end_at == _utc(2026, 9, 25, 3)
    assert _fee(q) == UNIT_VND


def test_nguong_dem_tu_DAU_CHU_KY_khong_phai_ngay_tren_lich():
    """Chu kỳ 25/7→25/8 thì "ngày thứ 23" là 16/8, KHÔNG phải 23/8 (chốt user 7/9).

    Đây là chỗ đọc nhầm dễ nhất: hai cách đếm chỉ trùng nhau khi chu kỳ bắt đầu ngày 1.
    Ranh giới lật đúng 10:00 giờ VN (03:00 UTC) ngày 16/8.
    """
    ws = _ws(25)
    truoc = quote_cycle(ws, _vn(2026, 8, 16, 9))
    sau = quote_cycle(ws, _vn(2026, 8, 16, 11))
    assert (truoc.day_of_cycle, truoc.forced_extra_month) == (22, False)
    assert (sau.day_of_cycle, sau.forced_extra_month) == (23, True)
    assert truoc.end_at == _utc(2026, 8, 25, 3)
    assert sau.end_at == _utc(2026, 9, 25, 3)
    # Ngày 23 trên LỊCH vẫn phải nằm sâu trong vùng bị ép, không phải mốc lật.
    assert quote_cycle(ws, _vn(2026, 8, 23, 9)).day_of_cycle == 29


def test_mua_them_thang_cong_don_moc():
    ws = _ws(25)
    assert quote_cycle(ws, _vn(2026, 8, 5, 8), extra_months=1).end_at == _utc(
        2026, 9, 25, 3
    )
    assert quote_cycle(ws, _vn(2026, 8, 5, 8), extra_months=3).end_at == _utc(
        2026, 11, 25, 3
    )


# ── 4. Bảng giá đã duyệt tay ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "mua_vn, ngay_le_x2, thang, han, tien",
    [
        (_vn(2026, 7, 26, 9), 61, 0, _utc(2026, 8, 25, 3), 325_000),
        (_vn(2026, 8, 5, 8), 41, 0, _utc(2026, 8, 25, 3), 219_000),
        (_vn(2026, 8, 5, 20), 40, 0, _utc(2026, 8, 25, 3), 213_000),
        (_vn(2026, 8, 10, 6), 31, 0, _utc(2026, 8, 25, 3), 165_000),
        (_vn(2026, 8, 16, 9), 19, 0, _utc(2026, 8, 25, 3), 102_000),
        (_vn(2026, 8, 16, 20), 18, 1, _utc(2026, 9, 25, 3), 426_000),
        (_vn(2026, 8, 20, 14), 10, 1, _utc(2026, 9, 25, 3), 384_000),
        (_vn(2026, 8, 25, 9), 1, 1, _utc(2026, 9, 25, 3), 336_000),
        (_vn(2026, 8, 25, 11), 0, 1, _utc(2026, 9, 25, 3), 330_000),
    ],
)
def test_bang_gia_chu_ky_25_7(mua_vn, ngay_le_x2, thang, han, tien):
    """Chu kỳ 25/7→25/8, kick 10:00 giờ VN, đơn giá 330.000 — user duyệt 2026-09-07."""
    q = quote_cycle(_ws(25), mua_vn)
    assert q.prorated_half_days == ngay_le_x2
    assert q.whole_months == thang
    assert q.end_at == han
    assert _fee(q) == tien


@pytest.mark.parametrize(
    "mua_utc, ngay_le_x2, thang, tien",
    [
        (_utc(2026, 8, 10, 6), 44, 0, 235_000),
        (_utc(2026, 8, 10, 20), 43, 0, 229_000),
        (_utc(2026, 8, 23, 6), 18, 1, 426_000),
        (_utc(2026, 9, 1, 2), 1, 1, 336_000),
    ],
)
def test_bang_gia_chu_ky_1_8(mua_utc, ngay_le_x2, thang, tien):
    """Chu kỳ 1/8→1/9 — bảng trong EXPIRY_RULES §10.2."""
    q = quote_cycle(_ws(1), mua_utc)
    assert q.prorated_half_days == ngay_le_x2
    assert q.whole_months == thang
    assert _fee(q) == tien


def test_mua_gop_nhieu_email_cung_luot_thi_cung_gia():
    """Mời 17 email một lượt = một thời điểm ⇒ hoá đơn gọn `17 × giá hôm nay`."""
    ws, now = _ws(25), _vn(2026, 8, 5, 8)
    assert len({_fee(quote_cycle(ws, now)) for _ in range(17)}) == 1


@pytest.mark.parametrize(
    "at, extra_months",
    [
        (_vn(2026, 8, 5, 8), 0),
        (_vn(2026, 8, 5, 20), 0),
        (_vn(2026, 8, 16, 11), 0),
        (_vn(2026, 8, 20, 14), 2),
        (_utc(2026, 7, 25, 3), 0),
    ],
)
def test_suy_nguoc_cua_so_ban_trung_khit_bao_gia(at, extra_months):
    """`sold_window` phải ra ĐÚNG con số của `quote_cycle` cho cùng lượt bán.

    Vì sao đáng một test riêng: hạn được ghi lúc TẠO member, còn tiền được tính ở
    một hàm khác sau đó, suy ngược từ hai mốc đã lưu. Hai đường ấy lệch nhau một
    nửa ngày là hoá đơn thu một đằng, hạn dùng một nẻo — và không có gì báo.
    """
    ws = _ws(25)
    q = quote_cycle(ws, at, extra_months=extra_months)
    assert sold_window(ws, join_at=q.join_at, end_at=q.end_at) == (
        q.prorated_half_days,
        q.cycle_days,
        q.whole_months,
    )


# ── 5. Cầu dao + cột thật ───────────────────────────────────────────────────


def test_mac_dinh_la_che_do_cu():
    """`billing_mode` mặc định `legacy_30d` ⇒ deploy xong KHÔNG có gì đổi."""
    assert is_cycle_aligned(SimpleNamespace(billing_mode="legacy_30d")) is False
    assert is_cycle_aligned(SimpleNamespace(billing_mode="lung tung")) is False
    assert is_cycle_aligned(_ws(25)) is True


@pytest.mark.parametrize(
    "half_days, cycle_days, mong_doi, y_nghia",
    [
        (0, 31, 0, "không có phần lẻ ⇒ 0đ"),
        (-4, 31, 0, "số âm (điểm nối đã qua mốc) ⇒ 0đ, không ra tiền âm"),
        (62, 31, UNIT_VND, "phần lẻ phủ trọn chu kỳ ⇒ đúng 1 đơn giá"),
        (1, 31, 6_000, "nửa ngày ⇒ 5.322đ, làm tròn LÊN bội 1.000"),
        (44, 31, 235_000, "22 ngày của chu kỳ 31 ngày"),
        (44, 28, 260_000, "cùng 22 ngày nhưng chu kỳ tháng 2 ⇒ đắt hơn"),
    ],
)
def test_tien_phan_le(half_days, cycle_days, mong_doi, y_nghia):
    """Chu kỳ ngắn thì mỗi ngày đắt hơn — một chu kỳ TRỌN luôn bằng đúng 1 đơn giá,
    bất kể nó dài 28 hay 31 ngày, giống hệt cách ChatGPT tính cho ta."""
    assert prorated_fee(UNIT_VND, half_days, cycle_days, ROUND_TO) == mong_doi, y_nghia


def test_cot_chu_ky_co_phan_le():
    assert hasattr(MemberSubscriptionCycle(), "prorated_half_days")


def test_cot_workspace_ton_tai():
    """Đổi tên cột mà quên sửa helper thì test giả (SimpleNamespace) không bắt được."""
    ws = Workspace()
    for cot in (
        "billing_mode",
        "cycle_anchor_day",
        "cycle_cutoff_utc",
        "cycle_force_extra_from_day",
    ):
        assert hasattr(ws, cot), f"Workspace thiếu cột {cot}"
