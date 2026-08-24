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

/**
 * NỢ SUẤT suy từ CẶP SỐ CỦA DASHBOARD — chỉ dùng khi KHÔNG đếm được tận nơi ở
 * tab "Lời mời đang chờ" của ChatGPT (`count-pending-invites.ts` trả
 * `authoritative:false`).
 *
 * Lấy thẳng `pending` của DB là ĐẾM HAI LẦN người vừa bấm nhận lời mời: ChatGPT
 * cộng họ vào "đã gán" NGAY lúc đó, còn DB phải chờ lần đồng bộ sau mới lật
 * 'pending' → 'active'. Ca thật GPT1 24/8/2026 09:20 (task 7963e4d0):
 *
 *     ChatGPT   148/151 đã gán
 *     Dashboard 147 active + 3 chờ = 150 email đã phát ra
 *
 *   148 + 3 = 151 ⇒ tưởng kín chỗ ⇒ đòi mua 1 suất ⇒ chốt "cấm mua theo số chưa
 *   chắc" giết cả lệnh mời. Thật ra 148 = 147 active + 1 người trong 3 lời mời
 *   chờ ĐÃ bấm nhận mà sync chưa kịp lật ⇒ đã chiếm 150, còn trống đúng 1 suất,
 *   thừa chỗ cho email đang mời.
 *
 * Mọi email vào workspace đều đi qua dashboard (user chốt 24/8/2026), nên số
 * người ChatGPT đang giữ KHÔNG BAO GIỜ vượt tổng email dashboard đã phát ra:
 *
 *     nợ suất = min(pending, max(0, occupied − đã gán))   ⇔   đã chiếm = max(đã gán, occupied)
 *
 * Đúng luật "lấy bên LỚN HƠN giữa hai nguồn" mà `headroomWithoutModal` đã dùng
 * cho đường tắt — trước đây chỉ nhánh đếm-tận-nơi cộng dồn, hai nhánh nói hai kiểu.
 *
 * Vì sao KẸP TRÊN bằng `pending`: nợ suất không thể lớn hơn số lời mời đang treo.
 * `occupied − đã gán` phình ra khi ChatGPT MẤT người mà DB chưa biết (bị gỡ bằng
 * đường khác) — phần phình đó là suất TRỐNG, không phải nợ. Kẹp lại còn là lưới
 * an toàn khi backend cũ chưa loại email của chính lệnh mời khỏi `occupied`:
 * xấu nhất là quay về đúng con số cũ, không bao giờ tệ hơn.
 *
 * ⚠️ KHÔNG áp luật này cho số ĐẾM TẬN NƠI ở tab "Lời mời": email còn nằm trong
 * tab đó thì theo định nghĩa CHƯA vào "đã gán" — không có cửa đếm hai lần.
 *
 * @param occupied member CHƯA bị gỡ mà dashboard đang giữ (`seatHint.occupied`);
 *   không có (backend cũ) → giữ nguyên `pending` như trước.
 */
export function dashboardPendingDebt(
  occupied: number | null | undefined,
  assigned: number,
  pending: number,
): number {
  const debt = Math.max(0, pending);
  if (typeof occupied !== "number" || !Number.isFinite(occupied)) return debt;
  return Math.min(debt, Math.max(0, occupied - assigned));
}
