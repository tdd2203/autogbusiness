/**
 * Nhận ra hộp xác nhận đang nói "thay đổi CHƯA có hiệu lực ngay".
 *
 * Ảnh user 26/8/2026 — hộp "Xem lại thay đổi người dùng" ghi rõ hai câu:
 *   "Các thay đổi của bạn sẽ có hiệu lực vào lần gia hạn tiếp theo."
 *   "Thêm 1 suất Tiêu chuẩn · Có hiệu lực vào 25 tháng 9, 2026"
 *
 * VÌ SAO SỐNG CÒN: vòng F5 kiểm chứng (xem `runner.ts`) kết luận "chưa mua" khi
 * số suất trên trang KHÔNG nhích. Với hộp kiểu này thì số suất *đúng ra* không
 * nhích cho tới ngày gia hạn — kết luận "chưa mua" rồi mua lại là MUA ĐÚP bằng
 * tiền thật. Thấy câu này thì cấm hẳn đường "mua lại".
 */

import { normalizeForMatch } from "./money";

const EFFECTIVE_LATER_PATTERNS = [
  // vi — "có hiệu lực vào 25 tháng 9, 2026" / "có hiệu lực từ kỳ sau" /
  //      "có hiệu lực vào lần gia hạn tiếp theo"
  /co\s*hieu\s*luc\s*(?:vao|tu|ke\s*tu)/,
  /hieu\s*luc\s*(?:tu|vao)\s*(?:ky|lan\s*gia\s*han|chu\s*ky)/,
  // en
  /(?:takes?|will\s*take)\s*effect\s*(?:on|at|from|starting)/,
  /effective\s*(?:on|from|starting|as\s*of)/,
  /(?:at|on|from)\s*(?:your\s*)?next\s*(?:renewal|billing\s*(?:cycle|period))/,
  // zh
  /(?:将于|自).{0,20}(?:起)?生效/,
  /下(?:一)?(?:个)?(?:续订|结算|账单)(?:周期)?(?:起)?生效/,
];

/** Câu dài quá mức này là quét trúng cả hộp chứ không phải riêng dòng hiệu lực. */
const MAX_LEN = 200;

/**
 * Trả về câu "có hiệu lực vào…" đọc được trong hộp (giữ nguyên dấu), null nếu
 * hộp không nói gì về chuyện hoãn hiệu lực.
 *
 * Nhận trên TEXT THÔ của hộp — gọi từ chỗ đã có `review.rawText`, khỏi phải cầm
 * thêm tham chiếu DOM.
 */
export function detectEffectiveLater(rawText: string): string | null {
  const norm = normalizeForMatch(rawText);
  if (!EFFECTIVE_LATER_PATTERNS.some((re) => re.test(norm))) return null;

  // Cắt lấy đúng câu chứa cụm để thông báo cho người đọc gọn gàng.
  for (const sentence of rawText.split(/(?<=[.。!?])\s+|\n+|·/)) {
    const s = sentence.trim().replace(/\s+/g, " ");
    if (!s) continue;
    if (EFFECTIVE_LATER_PATTERNS.some((re) => re.test(normalizeForMatch(s)))) {
      return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}…` : s;
    }
  }
  const whole = rawText.trim().replace(/\s+/g, " ");
  return whole.length > MAX_LEN ? `${whole.slice(0, MAX_LEN)}…` : whole;
}
