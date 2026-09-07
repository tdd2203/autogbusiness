/**
 * GIẤY PHÉP MUA SUẤT — cửa cuối cùng trước khi extension trừ tiền thật trên
 * ChatGPT.
 *
 * Vì sao có file này (ca thật GPT1 7/9/2026): trần thành viên của workspace đang
 * đặt 387 mà lệnh mời `tnguyen281187` vẫn nâng suất lên 388 và bị trừ ₫41.452
 * ngay lập tức. Trần chỉ gác ở cửa TẠO lệnh bên backend (đếm người trong DB),
 * còn khâu mua nằm ở đây và trước bản này nó không biết trần là gì: thấy ChatGPT
 * hết chỗ là mua. ChatGPT không có bước xác nhận thanh toán — bấm Continue trong
 * hộp "Quản lý số suất" là tiền rời khỏi thẻ, không đòi lại được.
 *
 * Hai điều kiện user chốt 7/9/2026, phải ĐỦ CẢ HAI:
 *   1. mọi email của lệnh đã TỪNG THAM GIA workspace này (backend quyết, gửi
 *      xuống trong `allowed` — xem `seats.purchase_allowance`);
 *   2. tổng suất SAU khi mua không vượt TRẦN THÀNH VIÊN (`maxTotal`).
 *
 * Điều kiện 2 chốt Ở ĐÂY chứ không ở backend vì tổng suất thật chỉ đọc được trên
 * trang ChatGPT: `workspace.seat_total` bên DB là số scrape, có thể cũ cả ngày.
 *
 * FAIL-CLOSED: không có giấy phép (backend cũ, hay một đường tạo lệnh nào đó
 * quên gắn) ⇒ KHÔNG MUA. Mặc định ngược lại thì mỗi chỗ quên là một lần tiêu tiền
 * ngoài ý người dùng, mà tiền đã trừ thì không có đường lui.
 */

export type SeatPurchasePolicy = {
  /** Điều kiện 1 (backend quyết): mọi email của lệnh là người đã từng tham gia. */
  allowed: boolean;
  /** Trần thành viên = tổng suất tối đa được phép có. `null` = không đặt trần. */
  maxTotal: number | null;
  /** Câu giải thích khi `allowed=false`, viết sẵn cho người dùng đọc. */
  reason?: string | null;
};

/**
 * Lý do KHÔNG được mua, hoặc `null` khi được phép.
 *
 * @param policy giấy phép backend gửi kèm task (`payload.seat_purchase`).
 * @param totalBefore tổng suất ĐỌC ĐƯỢC TRÊN CHATGPT trước khi mua.
 * @param shortfall số suất định mua.
 */
export function blockedPurchaseReason(
  policy: SeatPurchasePolicy | undefined,
  totalBefore: number,
  shortfall: number,
): string | null {
  if (!policy) {
    return (
      "Lệnh này không kèm giấy phép mua suất nên hệ thống không tự mua. " +
      "Mua thêm suất trên ChatGPT rồi chạy lại lệnh."
    );
  }
  if (!policy.allowed) {
    return (
      policy.reason ??
      "Lệnh này không được phép mua thêm suất. Mua suất trên ChatGPT rồi chạy lại."
    );
  }
  const cap = policy.maxTotal;
  if (cap !== null && totalBefore + shortfall > cap) {
    return (
      `Mua ${shortfall} suất sẽ nâng tổng suất lên ${totalBefore + shortfall}, ` +
      `vượt trần ${cap} suất đã đặt cho không gian này. Không mua và không mời. ` +
      "Nâng trần thành viên (hoặc mua suất tay trên ChatGPT) rồi chạy lại lệnh."
    );
  }
  return null;
}
