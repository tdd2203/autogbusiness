import { normalizeForMatch } from "../modal2/money";

/**
 * Đọc tình trạng suất từ modal "Quản lý suất" (UI ChatGPT 2026-08-22).
 *
 * Dòng thật trong modal (ảnh user 2026-08-22):
 *
 *   Tiêu chuẩn  649.000 đ/tháng
 *   53 người dùng · 52/53 đã gán          [−] 53 [+]
 *
 * Nghĩa: workspace ĐÃ MUA 53 suất, đang gán cho 52 người → còn TRỐNG 1.
 * Bộ đếm khởi điểm cũng bằng 53 (= tổng suất đã mua).
 *
 * Con số đáng tin nhất là cụm tỉ lệ "52/53 đã gán" vì nó nói rõ cả 2 vế; cụm
 * "53 người dùng" chỉ lặp lại tổng.
 */
export type SeatAvailability = {
  /** Tổng suất đã mua. */
  total: number;
  /** Số suất đang gán cho người dùng. */
  assigned: number;
  /** total − assigned. Số suất còn trống để mời người mới. */
  free: number;
};

/**
 * Parse text của modal "Quản lý suất". Trả null nếu không tìm được cụm tỉ lệ.
 *
 * ⚠️ KHÔNG suy ra `assigned` từ số thành viên trên trang: trang đếm "52 thành
 * viên" nhưng lời mời ĐANG CHỜ cũng có thể đang giữ suất. Chỉ tin con số
 * ChatGPT tự khai trong modal.
 */
export function parseSeatAvailability(text: string): SeatAvailability | null {
  const norm = normalizeForMatch(text);

  // "52/53 đã gán" · "52/53 assigned" · "52/53 已分配"
  const ratio = norm.match(
    /(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:da\s*gan|assigned|d[ãa]\s*gan|已分配)/i,
  );
  if (ratio) {
    const assigned = parseInt(ratio[1], 10);
    const total = parseInt(ratio[2], 10);
    if (isSane(assigned) && isSane(total)) {
      return { total, assigned, free: Math.max(0, total - assigned) };
    }
  }

  // Dự phòng: "đã gán 52/53" (đảo thứ tự nhãn/số).
  const reversed = norm.match(
    /(?:da\s*gan|assigned|已分配)\s*(\d{1,4})\s*\/\s*(\d{1,4})/i,
  );
  if (reversed) {
    const assigned = parseInt(reversed[1], 10);
    const total = parseInt(reversed[2], 10);
    if (isSane(assigned) && isSane(total)) {
      return { total, assigned, free: Math.max(0, total - assigned) };
    }
  }

  return null;
}

function isSane(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 9999;
}
