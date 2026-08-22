/**
 * UI 2026-08-22: nút "Quản lý số suất" nằm trên /admin/members (cạnh "+ Mời
 * thành viên"). Đây là đường đi CHÍNH của luồng mua suất.
 */
export const MEMBERS_PATH = "/admin/members";
export const MEMBERS_SEARCH = "?tab=members";

/**
 * Đường CŨ (/admin/billing?tab=plan → "Quản lý giấy phép"). Giữ làm fallback
 * cho workspace chưa được ChatGPT bật UI mới, và vẫn dùng cho skip mode
 * (thanh toán hoá đơn "Đến hạn" còn tồn đọng).
 */
export const BILLING_PLAN_PATH = "/admin/billing";
export const BILLING_PLAN_SEARCH = "?tab=plan";

/** Render delay sau khi navigate / click trong SPA. GIỮ NGUYÊN: chờ trang
 * render sau nav → phụ thuộc tốc độ mạng/máy, giảm = thao tác sớm khi chưa render. */
export const POST_NAV_RENDER_MS = 2500;

/** Hard cap đợi modal "Quản lý suất" (có bộ [−] n [+]) mở. */
export const MODAL_OPEN_TIMEOUT_MS = 15_000;

/** Hard cap đợi modal "Xem lại giao dịch mua" mở sau khi bấm "Tiếp tục". */
export const CHARGE_MODAL_TIMEOUT_MS = 12_000;

/**
 * Đợi ChatGPT TÍNH XONG số tiền trong modal "Xem lại giao dịch mua".
 *
 * Modal hiện ra TRƯỚC, số tiền điền vào SAU vài giây (user mô tả 2026-08-22:
 * "sau vài giây chờ nó tính toán thì nó có ảnh 2"). Đọc ngay lúc modal vừa mở
 * sẽ ra rỗng → chốt "không đọc được số liệu" nổ oan dù UI hoàn toàn bình thường.
 */
export const REVIEW_READY_TIMEOUT_MS = 15_000;

/**
 * Đợi thẻ tóm tắt "Thêm N suất Tiêu chuẩn" hiện trong modal "Quản lý suất" sau
 * khi bấm "+". Thẻ này là chốt kiểm tra SỚM, trước khi đụng tới modal thanh
 * toán — không có cũng không sao (workspace cũ không in), nên timeout ngắn.
 */
export const SEAT_PREVIEW_TIMEOUT_MS = 3_000;

/** Đợi modal xác nhận đóng (= ChatGPT đã nhận lệnh mua) sau khi bấm xác nhận. */
export const CHARGE_DISMISS_TIMEOUT_MS = 10_000;

/**
 * Đợi modal "Quản lý suất" đóng sau khi bấm "Quay lại"/Esc ở bước CHỈ-ĐỌC
 * (kiểm tra suất trước khi mời). Modal còn mở sẽ chặn mọi thao tác mời phía sau.
 */
export const SEAT_MODAL_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Đợi số trong bộ đếm nhích lên sau MỖI lần bấm "+". Thay cho sleep(400)+
 * sleep(600) cứng của bản cũ: máy chậm thì React cập nhật muộn hơn 1s → bản cũ
 * báo VERIFY_FAILED oan, máy nhanh thì phí 400ms mỗi suất.
 */
export const SEAT_STEP_TIMEOUT_MS = 4_000;

/**
 * Đợi nút "Tiếp tục" hết disabled. ChatGPT khoá nút này cho tới khi số suất
 * thực sự đổi, và bỏ khoá sau một nhịp re-render.
 */
export const CONTINUE_ENABLE_TIMEOUT_MS = 5_000;

/**
 * Trần số lần bấm để đưa bộ đếm về đúng số cần mua.
 *
 * Không đếm "bấm đủ N lần" nữa mà BÁM THEO CON SỐ: thiếu thì bấm "+", lỡ vượt
 * thì bấm "−" kéo xuống, tới khi bộ đếm đúng tổng cần. Nhờ vậy cú bấm nhân đôi
 * tự sửa được ngay tại chỗ thay vì phải mở lại hộp. Trần này chỉ để chặn vòng
 * lặp vô tận khi ChatGPT không phản hồi: qty × 3 + 6.
 */
export const seatAdjustMaxSteps = (qty: number): number => qty * 3 + 6;

/** Nghỉ giữa 2 lượt mở lại hộp "Quản lý suất" để bấm lại. */
export const SEAT_RETRY_GAP_MS = 700;

/**
 * Số lượt được phép MỞ LẠI hộp "Quản lý suất" để bấm lại từ đầu.
 *
 * Khi thẻ tóm tắt nói số suất khác số cần mua, KHÔNG fail ngay: đóng hộp, mở
 * lại (bộ đếm trở về số thật) rồi bấm lại cho chuẩn. An toàn tuyệt đối về tiền
 * vì chưa hề bấm "Tiếp tục" — chưa có giao dịch nào được tạo.
 */
export const SEAT_SETUP_MAX_ATTEMPTS = 3;

/**
 * Sau khi đã đọc được SỐ SUẤT trong hộp thanh toán, chờ thêm chừng này cho số
 * TIỀN xuất hiện. Chỉ để ghi audit — KHÔNG chặn luồng nếu hết giờ, vì chốt chỉ
 * dựa trên số suất (yêu cầu user: "chỉ quan tâm số suất, tiền tính sau").
 */
export const REVIEW_MONEY_GRACE_MS = 5_000;

/**
 * Chờ ChatGPT cập nhật số suất sau khi mua, TRƯỚC lần đọc lại DUY NHẤT.
 *
 * Chỉ đọc lại 1 lần (yêu cầu user): mở/đóng modal nhiều lần vừa chậm vừa thêm
 * cơ hội modal kẹt. Nhịp chờ này thay cho việc thử lại nhiều lượt.
 */
export const SEAT_SETTLE_AFTER_PURCHASE_MS = 3_000;

/** Hard cap quantity per task (mirror backend `PURCHASE_SEAT_MAX_PER_TASK`). */
export const MAX_QUANTITY = 20;
