"""Task CÒN BÁO NHỊP thì CHƯA phải task chết — đừng chốt timeout oan.

Ca thật 26/8/2026 (3 lệnh mời phải mua suất, workspace CHATGPT PRO + GPT1):

  11:25:11  fdeeadc5 nhận task → mua suất → ChatGPT xử lý giao dịch ~3,5′
  11:33:15  backend chốt `QUEUE_TIMEOUT` ở mốc 484s ("quá 8 phút")
  11:33:36  …mẻ đồng bộ ngay sau đó thấy ĐỦ email trong tab "Lời mời đang chờ"

Tức lời mời ĐÃ đi thật, extension vẫn đang chạy, mà dashboard hiện "Thất bại" và
đường tiền phải đi vòng hoãn-phán-xử 20′ mới gỡ được. Cùng ngày còn cd03d5ff
(481s) và 3bc11c7b (482s) — cả ba đều là lệnh mời có bước mua suất.

Ngưỡng cũ đếm từ `picked_at`, nên một bước chờ dài hợp lệ cũng bị tính là "treo".
Ngưỡng mới đếm từ mốc SỐNG GẦN NHẤT (tick tiến độ cuối): extension chết im (service
worker MV3 chết, tab đóng, kênh đứt) vẫn bị dọn đúng như cũ — đó mới là thứ cần bắt
— còn task đang chạy thật thì không bị giết.

Trần tuyệt đối (`_ALIVE_HARD_CAP` × ngưỡng) giữ cho hàng đợi không bị một extension
kẹt-mà-vẫn-báo-nhịp chặn vĩnh viễn.
"""

from datetime import datetime, timedelta, timezone

from app.routers.queue.execution import (
    _ALIVE_HARD_CAP,
    _merge_progress_history,
    stuck_verdict,
)

NGUONG = timedelta(minutes=8)  # INVITE_MEMBER
NOW = datetime(2026, 8, 26, 4, 33, 15, tzinfo=timezone.utc)


def _nhip(seconds_ago: int) -> dict:
    """progress có dấu nhịp cách đây `seconds_ago` giây."""
    return {
        "phase": "seat-purchased",
        "at": (NOW - timedelta(seconds=seconds_ago)).isoformat(),
    }


def test_con_bao_nhip_thi_khong_bi_chot_timeout():
    """Ca 26/8: nhận task 484s trước nhưng vừa báo nhịp 8s trước → CÒN SỐNG."""
    treo, ly_do, im_lang, tong = stuck_verdict(
        NOW - timedelta(seconds=484), _nhip(8), NOW, NGUONG
    )
    assert treo is False
    assert ly_do == "alive"
    assert im_lang == 8
    assert tong == 484


def test_im_lang_qua_nguong_van_bi_don():
    """Extension chết im: nhịp cuối cách đây hơn 8′ → treo, lý do 'silent'."""
    treo, ly_do, im_lang, _ = stuck_verdict(
        NOW - timedelta(minutes=20), _nhip(9 * 60), NOW, NGUONG
    )
    assert treo is True
    assert ly_do == "silent"
    assert im_lang == 9 * 60


def test_khong_co_nhip_nao_thi_dem_tu_luc_nhan_task():
    """Task chưa từng báo tiến độ (kể cả progress=None) → hành vi y như trước."""
    for progress in (None, {}, {"phase": "navigate"}, {"at": "không-phải-ngày"}):
        treo, ly_do, _, _ = stuck_verdict(
            NOW - timedelta(minutes=9), progress, NOW, NGUONG
        )
        assert (treo, ly_do) == (True, "silent"), progress

    treo, ly_do, _, _ = stuck_verdict(NOW - timedelta(minutes=7), None, NOW, NGUONG)
    assert (treo, ly_do) == (False, "alive")


def test_tran_tuyet_doi_cat_ca_task_bao_nhip_vo_tan():
    """Extension kẹt trong vòng lặp vẫn báo nhịp: quá trần thì vẫn phải dọn —
    hàng đợi chạy tuần tự, một task như thế chặn mọi lệnh sau nó."""
    qua_tran = NGUONG * _ALIVE_HARD_CAP + timedelta(seconds=30)
    treo, ly_do, im_lang, tong = stuck_verdict(NOW - qua_tran, _nhip(5), NOW, NGUONG)
    assert treo is True
    assert ly_do == "hard_cap"
    assert im_lang == 5
    assert tong == int(qua_tran.total_seconds())

    # Ngay dưới trần thì vẫn được chạy tiếp.
    duoi_tran = NGUONG * _ALIVE_HARD_CAP - timedelta(seconds=30)
    treo, ly_do, _, _ = stuck_verdict(NOW - duoi_tran, _nhip(5), NOW, NGUONG)
    assert (treo, ly_do) == (False, "alive")


def test_moi_tick_deu_dong_dau_nhip_ke_ca_khi_phase_khong_doi():
    """Dấu nhịp phải có ở MỌI tick — `history` chỉ ghi khi phase ĐỔI, nên một bước
    chờ dài (mua suất) không để lại mốc nào dù extension báo đều mỗi 10s."""
    dau = _merge_progress_history(None, {"phase": "confirm_charge"})
    assert isinstance(dau.get("at"), str)
    assert [h["phase"] for h in dau["history"]] == ["confirm_charge"]

    sau = _merge_progress_history(dau, {"phase": "confirm_charge", "message": "45s"})
    # Cùng phase → history KHÔNG dài thêm, nhưng dấu nhịp phải mới hơn.
    assert [h["phase"] for h in sau["history"]] == ["confirm_charge"]
    assert datetime.fromisoformat(sau["at"]) >= datetime.fromisoformat(dau["at"])
