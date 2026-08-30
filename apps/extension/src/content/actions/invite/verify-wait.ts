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

/**
 * Trần tuyệt đối cho lượt CHỜ XÁC NHẬN.
 *
 * 90s → 60s (user 30/8/2026): *"khi ChatGPT không phản hồi trong 1 phút thì mời
 * lại email đó một lần nữa"*. Hết trần KHÔNG còn nghĩa là báo hỏng — xem
 * `SILENT_RETRY_AFTER_MS`: extension đi soi tab "Lời mời đang chờ xử lý" rồi tab
 * "Người dùng", chỉ khi cả hai đều trắng mới mời lại. Nên cắt sớm ở đây không
 * tạo ra ca "mời trót lọt mà báo hỏng" như hồi trần còn là một cú chờ mù.
 */
export const VERIFY_WAIT_MAX_MS = 60_000;

/**
 * Mốc "ChatGPT im quá lâu" tính từ cú bấm "Gửi lời mời" — trước mốc này KHÔNG
 * được mời lại (chốt user 30/8/2026: *"khi ChatGPT không phản hồi trong 1 phút"*).
 *
 * Trần chờ ở trên co giãn theo số email nên mẻ 1 email hết chờ ở 25s. Lúc đó soi
 * hai tab là việc chỉ-đọc, làm ngay được. Nhưng cú MỜI LẠI thì đụng vào ChatGPT
 * thật: tab "Lời mời" index trễ vài giây là chuyện thường, mời lại lúc 25s là tự
 * tạo lời mời trùng. Nên soi sớm, mời lại thì đợi đủ một phút.
 */
export const SILENT_RETRY_AFTER_MS = 60_000;

/**
 * Trần chờ xác nhận cho mẻ `emailCount` email.
 *
 *   1 email  → 25s
 *   5 email  → 49s   (đúng mẻ đã gãy ngày 26/8/2026)
 *   ≥7 email → 60s   (chạm trần)
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

/**
 * Sau khi hộp thoại Mời ĐÓNG HẲN, nán lại chừng này chờ toast xác nhận kịp hiện.
 *
 * Chốt user 28/8/2026: "phải chờ cái tab này tắt hoàn toàn, có thông báo đã mời
 * thành công thì mới check xem đã mời được chưa ở Lời mời đang chờ xử lý".
 * Bản cũ dừng chờ ngay khi THẤY MỘT TRONG HAI (toast HOẶC dialog đóng) nên hay
 * rơi vào hai ca xấu:
 *   - dialog vừa đóng, toast chưa kịp vẽ → bằng chứng tụt xuống mức YẾU
 *     ("dialog_closed"), rồi tab "Lời mời" chưa index kịp ⇒ báo hỏng oan;
 *   - toast hiện lúc hộp còn đang gửi dở mẻ → bỏ đi quét tab quá sớm.
 * Giờ điều kiện là ĐÓNG HẲN, và đóng rồi vẫn nán thêm khoảng này để lấy bằng
 * chứng mạnh. Chỉ tốn thêm vài giây cho mỗi lệnh mời.
 */
export const VERIFY_TOAST_GRACE_MS = 4_000;
