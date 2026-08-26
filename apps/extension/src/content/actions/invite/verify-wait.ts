/**
 * Thời gian chờ ChatGPT XÁC NHẬN sau cú bấm "Gửi lời mời" (toast thành công HOẶC
 * dialog tự đóng). Hết thời gian này mà không đọc được dấu hiệu nào ⇒ `VERIFY_FAILED`.
 *
 * ⚠️ VÌ SAO KHÔNG PHẢI MỘT SỐ CỐ ĐỊNH (ca thật 26/8/2026, task `76d68e55`):
 * mẻ 5 email `karol*` — extension bấm Gửi, ChatGPT NHẬN THẬT (mẻ đồng bộ 3 phút sau
 * thấy đủ 5 email trong tab "Lời mời đang chờ"), nhưng 15s cố định trôi qua mà hộp
 * thoại chưa kịp đóng ⇒ task báo FAILED. Lời mời đã đi mà cả hệ thống tưởng hỏng:
 * backend phải hoãn phán xử, đi đối chiếu, và chỉ suýt nữa thì hoàn 1.650.000đ oan
 * (xem `apps/api/app/routers/queue/completion.md`, dòng 26/8/2026).
 *
 * ChatGPT xử lý lời mời TUẦN TỰ theo từng email — một mẻ 5 email tốn nhiều thời gian
 * hơn hẳn một email lẻ, nên trần chờ phải CO GIÃN theo số email thay vì để mẻ lớn
 * dùng chung trần của mẻ 1 email.
 *
 * Đánh đổi đã cân nhắc: nới trần chỉ làm CHẬM ca hỏng thật (chờ lâu hơn rồi mới báo
 * lỗi), còn cắt sớm thì tạo ra ca "mời trót lọt mà báo hỏng" — đắt hơn nhiều bậc, vì
 * nó chạm thẳng vào đường tiền. Ca mời trót lọt gần như luôn xong sớm hơn trần này
 * nên thực tế không ai phải chờ thêm.
 *
 * Trần vẫn phải NHỎ HƠN NHIỀU so với hạn Phase 1 của background
 * (`CONTENT_TIMEOUTS.INVITE_MEMBER` = 450s trong `background/runner.ts`), vì sau cú
 * chờ này còn bước quét tab "Lời mời" + tắt toggle + vòng F5 verify.
 */

/** Chờ cho email ĐẦU TIÊN. 15s (bản cũ) là quá sát ngay cả với mời 1 email. */
export const VERIFY_WAIT_BASE_MS = 25_000;

/** Cộng thêm cho MỖI email kể từ email thứ hai trong cùng một mẻ. */
export const VERIFY_WAIT_PER_EMAIL_MS = 6_000;

/** Trần tuyệt đối — mẻ lớn cũng không được ngốn hết hạn Phase 1 của background. */
export const VERIFY_WAIT_MAX_MS = 90_000;

/**
 * Trần chờ xác nhận cho mẻ `emailCount` email.
 *
 *   1 email  → 25s
 *   5 email  → 49s   (đúng mẻ đã gãy ngày 26/8/2026)
 *   10 email → 79s
 *   ≥12 email→ 90s   (chạm trần)
 *
 * `emailCount` không hợp lệ (0, âm, NaN) → coi như 1 email: thà chờ đủ còn hơn cắt
 * sớm rồi báo hỏng oan.
 */
export function inviteVerifyTimeoutMs(emailCount: number): number {
  const count =
    Number.isFinite(emailCount) && emailCount >= 1 ? Math.floor(emailCount) : 1;
  const ms = VERIFY_WAIT_BASE_MS + (count - 1) * VERIFY_WAIT_PER_EMAIL_MS;
  return Math.min(ms, VERIFY_WAIT_MAX_MS);
}
