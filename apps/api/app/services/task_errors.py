"""Chức năng: DỊCH LỖI TASK CHO NGƯỜI DÙNG — một câu ngắn, không thuật ngữ.

Vì sao có file này (chốt user 28/8/2026): `error_message` do extension ghi là nhật
ký kỹ thuật viết cho người sửa code — dài, kể tên selector, nêu cả giá suất Cao cấp
và số giây chờ. Ví dụ thật ngày 28/8:

    "Cần mua thêm 7 suất trước khi mời nhưng không mua được: Đã bấm 'Quản lý số
     suất' nhưng không thấy bộ đếm số suất của hàng "Tiêu chuẩn" sau 15s. Hộp nay
     có MỘT bộ đếm cho MỖI loại suất (Tiêu chuẩn / Cao cấp) — không ghim chắc được
     hàng Tiêu chuẩn thì KHÔNG bấm, vì suất Cao cấp đắt hơn 12 lần..."

Đại lý đọc đoạn đó không rút ra được việc gì phải làm, chỉ thấy hệ thống hỏng nặng
rồi bấm mời lại liên tục (16 lệnh hỏng y hệt nhau sáng 28/8). Nên:

  - Người dùng (sub-admin) thấy MỘT câu: chuyện gì và nên làm gì tiếp.
  - Super-admin giữ nguyên nhật ký đầy đủ để còn chẩn đoán.

Chỗ cắt nằm ở `queue/admin.py::list_tasks` — mọi trang của dashboard đều lấy task
qua đó nên chỉ cần chặn một cửa.
"""

# Câu ngắn theo từng mã lỗi. Viết cho người bán hàng, không cho người sửa code:
# nói HẬU QUẢ + VIỆC CẦN LÀM, không nói selector/DOM/số giây.
_FRIENDLY: dict[str, str] = {
    # ── Suất / ghế ────────────────────────────────────────────────────────────
    "NOT_ENOUGH_SEATS": (
        "Không gian đã hết suất và hệ thống chưa mua bù được. Chưa gửi lời mời "
        "nào, chưa trừ tiền. Vui lòng báo quản trị viên thay vì mời lại."
    ),
    "SEAT_CHECK_FAILED": (
        "Chưa đọc được số suất còn trống của không gian. Chưa gửi lời mời nào, "
        "chưa trừ tiền. Vui lòng báo quản trị viên."
    ),
    "SEAT_PURCHASE_FAILED": (
        "Mua thêm suất không thành công nên lệnh dừng lại. Chưa gửi lời mời nào. "
        "Vui lòng báo quản trị viên."
    ),
    "SEAT_RELOAD_FAILED": (
        "Đã mua suất nhưng trang ChatGPT chưa tải lại được. Vui lòng thử lại sau "
        "vài phút."
    ),
    "SEAT_LOCK_REQUIRED": (
        "Có lệnh khác đang mua suất cho không gian này. Hệ thống sẽ chạy lại lệnh "
        "của bạn, không cần thao tác gì."
    ),
    # ── Gửi lời mời ───────────────────────────────────────────────────────────
    # EXTERNAL_TOGGLE_FAILED CỐ Ý KHÔNG khai ở đây (chốt user 2026-08-31): bật cờ
    # mời ngoài tên miền là việc hệ thống tự làm trong luồng mời, không phải chuyện
    # người bán hiểu hay xử được. Thiếu khai ⇒ rơi vào `FALLBACK` bên dưới, người
    # dùng thấy câu chung. Nhật ký kỹ thuật đầy đủ vẫn nguyên cho super-admin.
    "INVITE_NOT_TYPED": (
        "Không nhập được email vào ô mời nên chưa gửi. Đã hoàn phí."
    ),
    "VERIFY_FAILED": (
        "Đã bấm gửi nhưng chưa nhận được xác nhận từ ChatGPT. Hệ thống đang kiểm "
        "tra lại, đừng mời lại email này cho tới khi có kết quả."
    ),
    "INVITE_UNVERIFIED_TIMEOUT": (
        "Chưa xác nhận được lời mời trong thời gian chờ. Hệ thống đang kiểm tra "
        "lại, đừng mời lại email này cho tới khi có kết quả."
    ),
    "INVITE_NOT_FOUND_BY_SYNC": (
        "Không tìm thấy lời mời trong danh sách chờ của ChatGPT. Vui lòng thử "
        "lại sau vài phút."
    ),
    "MEMBER_NOT_IN_WORKSPACE": (
        "Email này không còn trong không gian làm việc. Vui lòng kiểm tra lại "
        "danh sách thành viên."
    ),
    "REMOVE_VERIFY_FAILED": (
        "Chưa xác nhận được thao tác gỡ thành viên. Hệ thống đang kiểm tra lại."
    ),
    # ── Trình duyệt / kết nối ─────────────────────────────────────────────────
    "NOT_LOGGED_IN_CHATGPT": (
        "Trình duyệt chạy lệnh chưa đăng nhập ChatGPT. Vui lòng báo quản trị viên."
    ),
    "PAGE_NOT_ADMIN": (
        "Trình duyệt chạy lệnh không mở đúng trang quản trị ChatGPT. Vui lòng báo "
        "quản trị viên."
    ),
    "CONTENT_NOT_INJECTED": (
        "Trình duyệt chạy lệnh chưa sẵn sàng. Vui lòng thử lại sau vài phút."
    ),
    "STALE_BUILD": (
        "Tiện ích trên trình duyệt chạy lệnh đang là bản cũ. Vui lòng báo quản "
        "trị viên cập nhật."
    ),
    "CONTENT_TIMEOUT": (
        "Lệnh chạy quá lâu nên bị dừng. Hệ thống đang kiểm tra lại kết quả thật "
        "trên ChatGPT trước khi kết luận."
    ),
    "TIMEOUT": (
        "Lệnh chạy quá lâu nên bị dừng. Hệ thống đang kiểm tra lại kết quả thật "
        "trên ChatGPT trước khi kết luận."
    ),
    # ── Giao diện ChatGPT đổi ─────────────────────────────────────────────────
    "FAILED_UI_CHANGED": (
        "Giao diện ChatGPT vừa thay đổi nên hệ thống chưa thao tác được. Vui lòng "
        "báo quản trị viên."
    ),
    "UI_ELEMENT_NOT_FOUND": (
        "Giao diện ChatGPT vừa thay đổi nên hệ thống chưa thao tác được. Vui lòng "
        "báo quản trị viên."
    ),
    # ── Vận hành ──────────────────────────────────────────────────────────────
    "USER_CANCELED": "Lệnh đã bị huỷ.",
    "APPROVAL_REJECTED": "Lệnh không được quản trị viên duyệt.",
    "BILLING_SYNC_FAILED": (
        "Chưa đọc được thông tin thanh toán của không gian. Vui lòng thử lại sau."
    ),
    "BULK_UPSERT_FAILED": "Chưa lưu được dữ liệu vừa đồng bộ. Vui lòng thử lại sau.",
    "HARVEST_UPSERT_FAILED": "Chưa lưu được dữ liệu vừa đồng bộ. Vui lòng thử lại sau.",
}

# Mã lạ (extension mới thêm mà chưa kịp khai ở đây) vẫn KHÔNG được rò nhật ký kỹ
# thuật ra ngoài — thà nói chung chung còn hơn dán đoạn chẩn đoán khó hiểu.
FALLBACK = (
    "Lệnh chưa chạy xong. Hệ thống đang kiểm tra lại, vui lòng báo quản trị viên "
    "nếu lặp lại."
)


def friendly_error_message(error_code: str | None, error_message: str | None) -> str | None:
    """Câu ngắn thay cho `error_message` kỹ thuật khi người xem KHÔNG phải admin.

    Trả `None` khi task không có lỗi gì — để chỗ gọi giữ nguyên giá trị `None`.
    """
    if not error_code and not error_message:
        return None
    if error_code and error_code in _FRIENDLY:
        return _FRIENDLY[error_code]
    return FALLBACK


# ── Nhãn NGẮN + ai xử lý — phục vụ khối "Chất lượng lượt mời" ở trang Tổng quan ──
#
# Câu trong `_FRIENDLY` dài 2 vế (chuyện gì + làm gì) nên hợp với một dòng lỗi đơn
# lẻ, không hợp bảng xếp hạng lý do. Nhãn ngắn ở đây là tên GỌI của lý do; câu đầy
# đủ vẫn lấy từ `friendly_error_message` để hai chỗ không bao giờ nói khác nhau.
#
# `self_serve=True` = đại lý tự mời lại được. False = mời lại cũng hỏng y hệt, phải
# báo quản trị viên (hết suất, chưa đăng nhập, giao diện ChatGPT đổi) HOẶC hệ thống
# đang tự kiểm tra lại và mời lại lúc này là nhân đôi ghế. Sáng 28/8/2026 có 16 lệnh
# mời lại y hệt nhau vì không ai phân biệt được hai nhóm này.
_SHORT: dict[str, tuple[str, bool]] = {
    # ── Suất ──────────────────────────────────────────────────────────────────
    # Suất được MUA TỰ ĐỘNG trong lúc mời (`ensure-seats.ts`), nên với người bán
    # thì mọi ca hỏng ở chặng suất đều là một chuyện: mua suất không xong. Bốn mã
    # dưới đây khác nhau ở chỗ hỏng (vượt hạn mức 20 suất/lần, đọc không ra số
    # suất, mua rồi đọc lại vẫn thiếu, tải lại trang hỏng) — chi tiết đó nằm ở
    # `error_message` cho admin, không phải việc của đại lý.
    "NOT_ENOUGH_SEATS": ("Mua suất thất bại", False),
    "SEAT_CHECK_FAILED": ("Mua suất thất bại", False),
    "SEAT_PURCHASE_FAILED": ("Mua suất thất bại", False),
    "SEAT_RELOAD_FAILED": ("Mua suất thất bại", False),
    "SEAT_LOCK_REQUIRED": ("Lệnh khác đang mua suất", False),
    # ── Gửi lời mời ───────────────────────────────────────────────────────────
    # EXTERNAL_TOGGLE_FAILED: xem chú thích ở `_FRIENDLY` — không đặt nhãn riêng.
    "INVITE_NOT_TYPED": ("Không nhập được email vào ô mời", True),
    "VERIFY_FAILED": ("Chưa xác nhận được lời mời", False),
    "INVITE_UNVERIFIED_TIMEOUT": ("Chưa xác nhận được lời mời", False),
    "INVITE_NOT_FOUND_BY_SYNC": ("Không thấy lời mời trong danh sách chờ", True),
    # ── Trình duyệt chạy lệnh ────────────────────────────────────────────────
    "NOT_LOGGED_IN_CHATGPT": ("Trình duyệt chạy lệnh chưa sẵn sàng", False),
    "PAGE_NOT_ADMIN": ("Trình duyệt chạy lệnh chưa sẵn sàng", False),
    "CONTENT_NOT_INJECTED": ("Trình duyệt chạy lệnh chưa sẵn sàng", False),
    "STALE_BUILD": ("Tiện ích trình duyệt là bản cũ", False),
    "CONTENT_TIMEOUT": ("Lệnh chạy quá lâu", False),
    "TIMEOUT": ("Lệnh chạy quá lâu", False),
    # ── Giao diện ChatGPT ────────────────────────────────────────────────────
    "FAILED_UI_CHANGED": ("Giao diện ChatGPT thay đổi", False),
    "UI_ELEMENT_NOT_FOUND": ("Giao diện ChatGPT thay đổi", False),
    # ── Vận hành ─────────────────────────────────────────────────────────────
    "USER_CANCELED": ("Lệnh đã bị huỷ", True),
    "APPROVAL_REJECTED": ("Quản trị viên không duyệt", False),
}

_SHORT_FALLBACK = ("Chưa rõ nguyên nhân", False)


def short_error_label(error_code: str | None) -> tuple[str, bool]:
    """(nhãn ngắn, đại lý tự mời lại được) cho 1 mã lỗi."""
    if not error_code:
        return _SHORT_FALLBACK
    return _SHORT.get(error_code, _SHORT_FALLBACK)
