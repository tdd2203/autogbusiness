/**
 * Lệnh mời BÁO LỖI — có phải loại lỗi VÔ ĐỊNH cần F5 + soi lại tab Lời mời/Người
 * dùng để phân xử, thay vì báo FAILED (backend hiểu = mời hỏng → hoàn phí + void
 * kỳ + xoá bản ghi) hay không.
 *
 * Tách khỏi `runner.ts` để test được bằng dữ liệu thuần — cùng lý do với
 * `invite-outcome.ts`: đây là chỗ đã 2 lần làm mất tiền thật, phải khoá bằng test.
 *
 * RANH GIỚI: "vô định" ≠ "hỏng".
 *   - Lệnh CHƯA hề bấm Gửi (không tìm thấy nút, toggle external không bật được,
 *     không vào được trang) → biết chắc lời mời không đi ⇒ FAILED, hoàn phí ĐÚNG.
 *   - Lệnh ĐÃ bấm Gửi rồi mới mất dấu (kênh message đứt, content timeout, hoặc
 *     chờ 15s không đọc được toast lẫn dialog-đóng) → lời mời CÓ THỂ đã đi ⇒ phải
 *     đi tìm bằng chứng, không được đoán.
 *   - ChatGPT nói thẳng lỗi trong dialog (`chatgpt_error_hint`: email trùng, không
 *     hợp lệ, hết ghế) → bằng chứng DƯƠNG là không đi ⇒ giữ FAILED, không phân xử.
 *
 * ⚠️ BÀI HỌC (user 2026-08-12, ca mời báo hỏng OAN — CA 1):
 * v0.10.1 mở đường salvage nhưng CHỈ nhận 2 kiểu lỗi hạ tầng (CONTENT_TIMEOUT /
 * "message channel closed"), bỏ sót đúng cái lỗi hay xảy ra nhất: `VERIFY_FAILED`
 * sau khi đã click Gửi. Kết quả: lời mời tới hộp thư người nhận thật, mà task báo
 * FAILED lúc 19:31:20 → hoàn 330.000đ + `void_refunded_invite_periods` xoá sạch kỳ
 * đã trả → member kẹt 'pending' với hạn NULL, tức dùng miễn phí VÔ HẠN.
 */

export type InviteFailureLike = {
  error_code?: string;
  error_message?: string;
  /** `data` của response lỗi (content gắn khi kết quả vô định). */
  data?: Record<string, unknown>;
};

/**
 * Lỗi hạ tầng nuốt mất kết quả: kênh message chết giữa lúc content đang chạy.
 *
 * ⚠️ KHỚP THEO CHUỖI CỦA CHROME nên phải bám đúng từng chữ. Ba biến thể đã gặp
 * thật (chép nguyên văn từ `queue_items.error_message` trên production):
 *
 *   "The message port closed before a response was received."
 *   "A listener indicated an asynchronous response by returning true, but the
 *    message channel closed before a response was received"
 *   "The page keeping the extension port is moved into back/forward cache, so
 *    the message channel is closed."          ← 24/8/2026, task e5c67d9e
 *
 * Biến thể thứ ba là bfcache: content script đang chạy thì trang giữ port bị
 * Chrome đóng băng (điều hướng qua `/admin/identity` để bật toggle "mời ngoài
 * tên miền" — đúng đường mà mọi email NGOÀI miền phải đi). Nó ghi "message
 * channel **is** closed", chen một chữ `is` mà bản trước không lường: regex
 * trượt → salvage không chạy → task báo FAILED thẳng → backend hoàn phí + xoá
 * bản ghi. Hôm đó lời mời chưa kịp đi nên không mất tiền, nhưng cùng lỗi ấy xảy
 * ra SAU cú bấm Gửi thì mất đúng như CA 1 ngày 12/8.
 *
 * Nên `channel (is )?closed` và bắt thẳng cả cụm `back/forward cache` — kênh chết
 * vì trang bị đóng băng thì kết quả vô định bất kể Chrome diễn đạt thế nào.
 */
const INDETERMINATE_CHANNEL_RE =
  /message channel (?:is )?closed|message port closed|asynchronous response|back\/forward cache/i;

/**
 * `true` ⇒ ĐỪNG kết luận hỏng: chạy vòng verify (F5 + VERIFY_PENDING_INVITE +
 * CHECK_ACTIVE_AFTER_INVITE) rồi chỉ báo COMPLETED nếu THẤY email; không thấy thì
 * mới trả về đúng lỗi gốc này.
 */
export function shouldSalvageInvite(failure: InviteFailureLike): boolean {
  const { error_code, error_message, data } = failure;
  if (error_code === "CONTENT_TIMEOUT") return true;
  if (INDETERMINATE_CHANNEL_RE.test(error_message ?? "")) return true;
  if (error_code === "VERIFY_FAILED") {
    // Chỉ khi content xác nhận đã bấm Gửi VÀ ChatGPT không hề báo lỗi ngược lại.
    return data?.submit_clicked === true && !data?.chatgpt_error_hint;
  }
  return false;
}
