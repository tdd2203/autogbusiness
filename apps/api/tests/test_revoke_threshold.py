"""Ngưỡng treo của lệnh THU HỒI LỜI MỜI phải theo số lời mời phải thu hồi.

Ca ickj886@gmail.com (27/8/2026): thu hồi trót lọt mà bị chốt là hỏng vì
extension đóng sổ xác minh ở giây thứ 12-17, giữa lúc ChatGPT còn chưa cập nhật
danh sách (~34s, cùng độ trễ mà lệnh gỡ đã đo từ 12/7/2026). Extension nay hỏi
lại tới 60s mỗi lời mời, nên một lệnh mang nhiều email cần ngưỡng dài tương ứng
— nếu không, chính đồng hồ treo 3 phút của backend dọn đúng lệnh đang chạy thật.

Dashboard gửi lệnh nhiều email qua `POST /workspaces/{id}/revoke-invites` (phát
hiện lời mời lạ). Lệnh đó KHÔNG phải mẻ gộp nên không có `merged_size`.
"""

from app.models import QueueItem
from app.routers.queue.execution import merged_threshold_factor
from app.services import task_merge


def _item(type_: str, payload: dict) -> QueueItem:
    return QueueItem(type=type_, status="IN_PROGRESS", payload=payload)


def test_thu_hoi_nhieu_loi_moi_duoc_nhan_nguong_theo_so_email():
    item = _item("REVOKE_INVITES", {"emails": ["a@x.com", "b@x.com", "c@x.com"]})
    assert merged_threshold_factor(item) == 3


def test_thu_hoi_mot_loi_moi_van_la_mot_luot():
    assert merged_threshold_factor(_item("REVOKE_INVITES", {"emails": ["a@x.com"]})) == 1


def test_lay_he_so_lon_hon_giua_me_gop_va_so_email():
    me_lon_hon = _item("REVOKE_INVITES", {"emails": ["a@x.com"], "merged_size": 4})
    assert merged_threshold_factor(me_lon_hon) == 4
    email_lon_hon = _item(
        "REVOKE_INVITES", {"emails": ["a@x.com", "b@x.com"], "merged_size": 1}
    )
    assert merged_threshold_factor(email_lon_hon) == 2


def test_bo_qua_phan_tu_rac_trong_danh_sach_email():
    item = _item("REVOKE_INVITES", {"emails": ["a@x.com", "", None, 7, "khong-phai-email"]})
    assert merged_threshold_factor(item) == 1


def test_khong_vuot_tran_me_gop():
    item = _item("REVOKE_INVITES", {"emails": [f"e{i}@x.com" for i in range(50)]})
    assert merged_threshold_factor(item) == task_merge.MAX_MERGED_TASKS


def test_loai_lenh_khac_khong_an_theo_so_email():
    # Lời mời gộp là MỘT lần mở hộp mời, thời gian gần như không đổi → hệ số 1.
    assert (
        merged_threshold_factor(_item("INVITE_MEMBER", {"emails": ["a@x.com", "b@x.com"]}))
        == 1
    )


def test_go_thanh_vien_van_chi_theo_me_gop():
    assert merged_threshold_factor(_item("REMOVE_MEMBER", {"email": "a@x.com"})) == 1
    assert (
        merged_threshold_factor(_item("REMOVE_MEMBER", {"email": "a@x.com", "merged_size": 5}))
        == 5
    )
