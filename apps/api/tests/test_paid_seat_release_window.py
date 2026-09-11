"""Cửa sổ TRẢ SUẤT TRẢ PHÍ khi gỡ member — `paid_seat_release_deadline` (EXPIRY_RULES §6.1).

Vì sao có file này: ChatGPT bồi hộp "Gỡ suất trả phí?" sau mỗi lệnh gỡ. Bấm gỡ suất
giữa kỳ là vô ích (suất đã trả tiền tới ngày gia hạn) nên extension mặc định GIỮ; chỉ
trong NGÀY CHỐT chu kỳ mới trả suất để hoá đơn kỳ mới nhẹ đi. Hàm này là chỗ DUY NHẤT
quyết định "đang là ngày chốt hay không" — sai một chiều là mất tiền cả kỳ (giữ oan),
sai chiều kia là gỡ suất giữa kỳ (mất chỗ trống chuyển người). Hai ranh giới dễ hỏng:
đúng 24 giờ trước mốc, và giờ hoá đơn.

Test THUẦN LOGIC, workspace giả như `test_cycle_aligned_billing.py`.
"""

from datetime import datetime, time as dtime, timedelta, timezone
from types import SimpleNamespace

from app.models import BILLING_MODE_CYCLE_ALIGNED, BILLING_MODE_LEGACY_30D
from app.routers.members._shared import paid_seat_release_deadline

UTC = timezone.utc


def _ws(anchor_day: int = 11, *, mode: str = BILLING_MODE_CYCLE_ALIGNED, cutoff=dtime(3, 0)):
    return SimpleNamespace(
        billing_mode=mode,
        cycle_anchor_day=anchor_day,
        cycle_cutoff_utc=cutoff,
        cycle_force_extra_from_day=23,
        renewal_date=None,
    )


def _utc(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


# Mặc định hệ thống: hoá đơn 09:00 UTC (16h giờ VN).
_SETTINGS = SimpleNamespace(cycle_invoice_utc=dtime(9, 0), cycle_cutoff_utc=dtime(3, 0))

# Mốc chốt của ví dụ: 11/9/2026 03:00 UTC (10h giờ VN). Kỳ đang chạy 11/8 → 11/9.
BOUNDARY = _utc(2026, 9, 11, 3, 0)
INVOICE = _utc(2026, 9, 11, 9, 0)


def test_giua_ky_thi_khong_tra_suat():
    assert paid_seat_release_deadline(_ws(), _utc(2026, 8, 25, 12, 0), settings_row=_SETTINGS) is None


def test_ngay_cuoi_ky_truoc_moc_chot_thi_tra_suat_toi_gio_hoa_don():
    # Ca thật user thao tác tay 11/9/2026 09:53 giờ VN = 02:53 UTC, TRƯỚC mốc 03:00.
    assert (
        paid_seat_release_deadline(_ws(), _utc(2026, 9, 11, 2, 53), settings_row=_SETTINGS)
        == INVOICE
    )


def test_sau_moc_chot_truoc_gio_hoa_don_thi_van_con_kip():
    # Đợt gỡ tại mốc (03:00 UTC) chạy tới 08:59 vẫn là ngày chốt.
    assert (
        paid_seat_release_deadline(_ws(), _utc(2026, 9, 11, 8, 59), settings_row=_SETTINGS)
        == INVOICE
    )


def test_dung_gio_hoa_don_thi_het_cua_so():
    # ChatGPT đã tính đủ ghế cũ; gỡ suất lúc này rơi sang kỳ sau ⇒ giữ như giữa kỳ.
    assert paid_seat_release_deadline(_ws(), INVOICE, settings_row=_SETTINGS) is None
    assert paid_seat_release_deadline(_ws(), _utc(2026, 9, 11, 15, 0), settings_row=_SETTINGS) is None


def test_ranh_gioi_24_gio_truoc_moc():
    # Đúng 24 giờ trước mốc là bắt đầu ngày cuối; một phút trước đó vẫn là giữa kỳ.
    assert paid_seat_release_deadline(_ws(), BOUNDARY - timedelta(days=1), settings_row=_SETTINGS) == INVOICE
    assert (
        paid_seat_release_deadline(
            _ws(), BOUNDARY - timedelta(days=1, minutes=1), settings_row=_SETTINGS
        )
        is None
    )


def test_gio_hoa_don_som_hon_gio_chot_thi_hoa_don_roi_sang_hom_sau():
    # Chốt 23:00 UTC, hoá đơn cấu hình 09:00 UTC ⇒ hoá đơn của mốc 11/9 23:00 là 12/9 09:00.
    ws = _ws(cutoff=dtime(23, 0))
    assert (
        paid_seat_release_deadline(ws, _utc(2026, 9, 12, 5, 0), settings_row=_SETTINGS)
        == _utc(2026, 9, 12, 9, 0)
    )
    assert paid_seat_release_deadline(ws, _utc(2026, 9, 12, 9, 0), settings_row=_SETTINGS) is None


def test_khong_co_cau_hinh_thi_dung_mac_dinh_09_00():
    assert paid_seat_release_deadline(_ws(), _utc(2026, 9, 11, 4, 0), settings_row=None) == INVOICE


def test_che_do_30_ngay_khong_bao_gio_tra_suat():
    ws = _ws(mode=BILLING_MODE_LEGACY_30D)
    assert paid_seat_release_deadline(ws, _utc(2026, 9, 11, 4, 0), settings_row=_SETTINGS) is None


def test_chua_biet_moc_chu_ky_thi_khong_doan():
    ws = _ws()
    ws.cycle_anchor_day = None
    assert paid_seat_release_deadline(ws, _utc(2026, 9, 11, 4, 0), settings_row=_SETTINGS) is None


def test_gio_may_khong_mui_gio_coi_nhu_utc():
    naive = datetime(2026, 9, 11, 4, 0)
    assert paid_seat_release_deadline(_ws(), naive, settings_row=_SETTINGS) == INVOICE
