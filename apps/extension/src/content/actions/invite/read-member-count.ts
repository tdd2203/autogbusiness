/**
 * Đọc "Business · 146 thành viên" ngay trên trang /admin/members — KHÔNG mở hộp
 * "Quản lý suất".
 *
 * Vì sao cần (user 2026-08-24): mở hộp "Quản lý suất" trước mỗi lần mời là chỗ
 * hỏng nhiều nhất của luồng mời — hộp không mở sau 15s, hoặc bộ đếm lệch dòng tỉ
 * lệ → chết cả task dù workspace thừa suất. Số thành viên in sẵn trên trang, đọc
 * không tốn cú bấm nào.
 *
 * ⚠️ Số này KHÔNG phải "số suất đã gán". Tab "Người dùng" chỉ đếm người ĐÃ tham
 * gia; lời mời ĐANG CHỜ cũng giữ suất mà không nằm trong số này. Nên nó chỉ là
 * CẬN DƯỚI của số suất đang bị chiếm — dùng để kết luận "chắc chắn còn thừa" thì
 * phải cộng thêm số lời mời đang chờ (dashboard gửi kèm). Xem `ensure-seats.ts`.
 */

import { normalizeForMatch } from "../purchase-seat/modal2/money";

/** "146 thành viên" · "146 members" · "146 成员" (bản thường hoá bỏ dấu). */
const COUNT_RE = /(\d{1,5})\s*(?:thanh vien|members?|成员)/gi;

/**
 * @param text mặc định lấy nguyên trang. Truyền vào để test.
 * @returns số thành viên, hoặc null khi không thấy / thấy nhiều số khác nhau.
 */
export function parseMemberCount(text: string): number | null {
  const norm = normalizeForMatch(text);
  const found = new Set<number>();
  for (const m of norm.matchAll(COUNT_RE)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 99_999) found.add(n);
  }
  // Trang in con số này 2 chỗ (thanh bên + tiêu đề) nên khớp nhau là bình thường.
  // Ra NHIỀU số khác nhau nghĩa là bắt trúng chữ "thành viên" của chỗ khác →
  // không dám dùng, trả null để caller mở hộp đọc tận nơi như cũ.
  return found.size === 1 ? [...found][0] : null;
}

export function readMemberCountFromPage(): number | null {
  return parseMemberCount(document.body?.innerText ?? "");
}
