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

/** Lỗi hạ tầng nuốt mất kết quả: kênh message chết giữa lúc content đang chạy. */
const INDETERMINATE_CHANNEL_RE =
  /message channel closed|message port closed|asynchronous response/i;

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
