import { normalizeForMatch } from "./money";

/**
 * Đọc số suất mà modal "Xem lại giao dịch mua" NÓI là sẽ thêm — dùng làm chốt
 * an toàn: lệch với `quantity` của task là DỪNG, không bấm xác nhận.
 *
 * UI 2026-08-22 (vi) viết: "Thêm 1 suất Tiêu chuẩn".
 * UI cũ viết: "1 suất bổ sung" / "1 additional seat".
 *
 * ⚠️ Chỉ khớp dòng NÓI VỀ PHẦN THÊM. Modal còn in "47 ghế Tiêu chuẩn" (số ghế
 * hiện tại) và "48 ghế Tiêu chuẩn" (số ghế sau khi mua) — bắt nhầm 2 số đó là
 * sanity check báo lệch oan, hoặc tệ hơn: PASS nhầm khi số ghế tình cờ khớp.
 * Vì vậy KHÔNG có pattern kiểu "(\d+) ghế".
 *
 * Trả null nếu không đọc được (caller tự quyết định xử lý).
 */
export function extractAdditionalSeatCountFromModal(text: string): number | null {
  const norm = normalizeForMatch(text);
  const patterns: RegExp[] = [
    // UI 2026-08-22: "Thêm 1 suất Tiêu chuẩn" / "Thêm 2 suất"
    /them\s*(\d{1,3})\s*suat/i,
    // UI cũ: "1 suất bổ sung", "1 suất cấp phép bổ sung"
    /(\d{1,3})\s*suat.{0,30}bo\s*sung/i,
    /(\d{1,3})\s*(?:cho\s*ngoi|ghe)\s*bo\s*sung/i,
    // EN
    /add\s*(\d{1,3})\s*(?:standard\s*|plus\s*|business\s*)?(?:seat|user|license)/i,
    /(\d{1,3})\s*additional\s*(?:seat|user|license)/i,
    // ZH
    /添加?\s*(\d{1,3})\s*(?:个\s*)?(?:用户|席位|许可)/,
  ];
  for (const re of patterns) {
    const m = norm.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0 && n <= 999) return n;
    }
  }
  return null;
}
