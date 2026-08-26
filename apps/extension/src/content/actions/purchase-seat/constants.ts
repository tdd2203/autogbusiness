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

/**
 * Đợi nút "Quản lý số suất" xuất hiện trên trang Thành viên trước khi dám kết
 * luận "workspace này chưa được ChatGPT bật UI mới".
 *
 * Ca thật 22/8/2026 (2 lệnh mời, 18:03 và 18:20): hỏi một lần ngay lúc vừa tới
 * trang → chưa render → tưởng workspace UI cũ → BỎ QUA chốt suất → mời mù trong
 * lúc workspace hết sạch suất → ChatGPT bật hộp "mua kèm gửi lời mời" → hỏng.
 * Xem `check-seat-availability.ts`.
 *
 * Workspace UI cũ THẬT thì phải trả giá bằng đúng chừng này giây mỗi lần mời —
 * đổi lại không bao giờ mời mù nữa. Nút có sẵn (đại đa số) → trả về tức thì.
 */
export const MANAGE_SEATS_BUTTON_WAIT_MS = 6_000;

/** Nhịp dò lại nút "Quản lý số suất" trong lúc chờ. */
export const MANAGE_SEATS_BUTTON_POLL_MS = 400;

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

/**
 * Đợi hộp "Xem lại giao dịch mua" đóng hẳn (= ChatGPT đã xử lý xong lệnh mua)
 * sau khi bấm "Xác nhận mua".
 *
 * Ca thật 24/8/2026 (lệnh mời wallet_tester): bấm "Xác nhận mua" xong ChatGPT
 * quay vòng khá lâu — bản cũ chờ 10s là bỏ đi mời tiếp trong khi hộp CÒN ĐANG
 * MỞ. Hộp mở là một lớp phủ chặn cả trang: cú mời ngay sau đó hỏng, user phải
 * chạy lại lệnh thứ hai mới mời được.
 *
 * Chờ lâu KHÔNG tốn gì khi máy nhanh (hộp đóng là đi tiếp ngay), mà ngân sách
 * thì có sẵn: runner cho INVITE_MEMBER và PURCHASE_SEAT 450s.
 */
export const CHARGE_DISMISS_TIMEOUT_MS = 120_000;

/** Nhịp dò lại trạng thái hộp trong lúc chờ giao dịch. */
export const CHARGE_DISMISS_POLL_MS = 500;

/**
 * Số lần đọc LIÊN TIẾP phải thấy hộp đã đóng mới tin là đóng thật. Radix có
 * nhịp animation đóng/mở; đọc đúng một lần dễ bắt trúng khung hình chuyển tiếp.
 */
export const CHARGE_DISMISS_STABLE_POLLS = 3;

/**
 * Hộp đóng rồi vẫn phải đợi LỚP PHỦ (backdrop/overlay của Radix) rời DOM. Lớp
 * phủ còn nằm đó thì mọi cú bấm phía sau rơi vào nó chứ không tới nút thật —
 * đúng kiểu hỏng mà lệnh mời gặp phải.
 */
export const OVERLAY_CLEAR_TIMEOUT_MS = 20_000;

/**
 * Nghỉ sau khi giao dịch xong, TRƯỚC thao tác kế (mở dialog mời). Cho ChatGPT
 * kịp cập nhật lại trang sau khi số suất đổi.
 */
export const POST_PURCHASE_SETTLE_MS = 5_000;

/**
 * Nghỉ sau khi hộp "Quản lý suất" vừa mở, trước khi đụng vào bộ đếm. Hộp mở ra
 * trước, số thật điền vào sau một nhịp re-render.
 */
export const SEAT_MODAL_SETTLE_MS = 1_500;

/**
 * Nghỉ giữa hai cú bấm "+"/"−" trong hộp "Quản lý suất" (user 2026-08-24: "thao
 * tác rất là nhanh, cần làm chậm lại, không cần vội"). Bản cũ bấm liên tục ngay
 * khi số vừa nhích — React còn đang re-render thì cú kế dễ rơi vào node cũ.
 */
export const SEAT_STEP_GAP_MS = 700;

/** Nghỉ trước khi bấm "Tiếp tục" (mở hộp thanh toán). */
export const PRE_CONTINUE_PAUSE_MS = 1_500;

/** Nghỉ trước khi bấm "Xác nhận mua" — ⚠️ cú bấm TRỪ TIỀN THẬT. */
export const PRE_CONFIRM_PAUSE_MS = 2_500;

/**
 * Đợi hai nguồn số suất (dòng tỉ lệ "150/151 đã gán" và bộ đếm "[−] 151 [+]")
 * KHỚP NHAU trước khi kết luận là chúng lệch.
 *
 * Ca thật 23/8/2026: bộ đếm đọc ra 150 khi dòng tỉ lệ đã nói 151 → chốt chặn nổ
 * OAN và cú "Mời lại" chết, dù thực tế còn trống 1 suất. Hai chỗ đó là hai
 * component React khởi tạo độc lập; code cũ chờ dòng tỉ lệ tới 8s nhưng đọc bộ
 * đếm ngay lập tức, không thử lại. Xem `modal1/settle-seat-crosscheck.ts`.
 *
 * Khớp ngay lần đọc đầu (đại đa số) → không tốn nhịp nào.
 */
export const SEAT_CROSSCHECK_SETTLE_MS = 2_500;

/** Nhịp đọc lại hai nguồn số suất trong lúc chờ chúng khớp nhau. */
export const SEAT_CROSSCHECK_POLL_MS = 250;

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
 * Đợi nút "Xác nhận mua" hết khoá. ChatGPT khoá nút trong lúc còn tính tiền
 * prorate, mở khoá khi tính xong.
 *
 * Ca thật 22/8/2026 (2 task liền, 18:17 và 18:28): hỏi ngay lúc hộp vừa mở thì
 * thấy khoá, bản trước bỏ cuộc luôn → báo "thiếu phương thức thanh toán" OAN
 * trong khi thẻ vẫn có sẵn. Để rộng hơn nút "Tiếp tục" vì bước này ChatGPT còn
 * phải tính tiền.
 */
export const CONFIRM_ENABLE_TIMEOUT_MS = 10_000;

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

/**
 * Đợi hàng thẻ suất ("Suất Tiêu chuẩn · Đã gán 60/62") hiện trên trang Thành
 * viên trước khi kết luận workspace này chưa có UI mới và quay về mở hộp.
 *
 * Ngắn hơn `MANAGE_SEATS_BUTTON_WAIT_MS` vì thẻ nằm ngay trong phần đầu trang,
 * render cùng lúc với danh sách; chờ lâu chỉ làm chậm những workspace CHƯA có
 * thẻ — mà những workspace đó còn phải chờ tiếp nút "Quản lý số suất".
 */
export const SEAT_CARDS_WAIT_MS = 4_000;

/** Nhịp dò lại hàng thẻ suất trong lúc chờ. */
export const SEAT_CARDS_POLL_MS = 300;

/**
 * Sau khi bấm "Xác nhận mua": chờ con số suất IN SẴN trên trang Thành viên nhích
 * lên đúng số vừa mua. Số tăng = ChatGPT đã ghi nhận giao dịch — không cần mở
 * lại hộp "Quản lý suất" để đọc kiểm nữa (user 2026-08-26).
 *
 * Dài hơn các mốc chờ UI khác vì đây là chờ SERVER: ChatGPT trừ tiền xong mới
 * đẩy số suất mới xuống, và hàng thẻ chỉ vẽ lại sau lượt refetch đó. Chờ hụt thì
 * mất đường xác nhận rẻ nhất và phải quay về đường mở hộp/tải lại trang.
 */
export const SEAT_CARDS_VERIFY_TIMEOUT_MS = 15_000;

/** Nhịp dò lại hàng thẻ trong lúc chờ số suất mới. */
export const SEAT_CARDS_VERIFY_POLL_MS = 700;
