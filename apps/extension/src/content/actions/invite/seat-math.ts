/**
 * Phép tính CHỖ TRỐNG THẬT của workspace — tách riêng vì nó quyết định TIÊU TIỀN.
 *
 * Hộp "Quản lý suất" của ChatGPT in "147/151 đã gán": 151 là tổng suất, 147 là số
 * người ĐÃ THAM GIA. Lời mời đang treo KHÔNG nằm trong 147 — đo trên production
 * 24/8/2026: CHATGPT PRO hiện "60/60 đã gán" mà vẫn còn 1 lời mời chưa ai bấm
 * nhận; GPT1 hiện "148/151 đã gán" trong khi hệ thống có 148 active + 1 chờ.
 *
 * Nhưng suất ấy sẽ bị chiếm ngay khi người ta bấm nhận, nên nó là NỢ SUẤT phải
 * trừ trước. Lấy thẳng `tổng − đã gán` làm chỗ trống là bỏ quên món nợ đó: mời
 * thêm 1 email vào CHATGPT PRO sẽ chỉ mua 1 suất trong khi cần 2 — một cho người
 * đang chờ, một cho email mới (user chốt 24/8/2026).
 */

/**
 * @param total    tổng suất workspace đang giữ (dòng tỉ lệ trong hộp).
 * @param assigned số suất ChatGPT nói "đã gán" (= người đã tham gia).
 * @param pendingDebt số lời mời đang chờ CHƯA được tính vào `assigned`, và KHÔNG
 *   kể email của chính lệnh mời đang chạy (backend `_seat_hint` đã loại) — đếm
 *   trùng ở đây là mua thừa bằng tiền thật.
 * @returns số suất còn mời được, không bao giờ âm.
 */
export function freeSeatsWithPendingDebt(
  total: number,
  assigned: number,
  pendingDebt: number,
): number {
  return Math.max(0, total - (assigned + Math.max(0, pendingDebt)));
}
