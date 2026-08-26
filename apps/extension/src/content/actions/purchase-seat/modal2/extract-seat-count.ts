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

/**
 * Hộp có đang nói tới việc mua THÊM LOẠI SUẤT KHÁC ngoài "Tiêu chuẩn" không.
 *
 * Từ 26/8/2026 hộp "Quản lý suất" có MỘT bộ đếm cho MỖI loại suất, và khi cả
 * hai cùng tăng thì thẻ tóm tắt viết:
 *
 *   "Thêm 1 suất Tiêu chuẩn và 1 suất Cao cấp"   + 3.505.500 đ/tháng
 *
 * Suất Cao cấp đắt hơn Tiêu chuẩn 12 lần (3.245.000 vs 260.500 đ/tháng). Chốt
 * `extractAdditionalSeatCountFromModal` KHÔNG bắt được ca này: nó đọc cụm đầu
 * ("Thêm 1 suất …") ra đúng 1 và cho qua, trong khi hoá đơn gánh thêm một suất
 * Cao cấp. Đây là hàm CHẶN riêng cho ca đó.
 *
 * Hai dấu hiệu, dính cái nào cũng phải DỪNG:
 *   1. có cụm "<số> suất <loại khác>" với loại nhận ra được (Cao cấp/Premium);
 *   2. mệnh đề "Thêm …" chứa TỪ HAI cụm "<số> suất" trở lên — kể cả khi ChatGPT
 *      đổi tên loại suất thành chữ ta chưa biết.
 *
 * Trả `null` khi hộp chỉ nói về một loại suất (đường đi bình thường).
 */
export function detectMixedSeatTypes(text: string): string | null {
  // Bản thường hoá dài BẰNG ĐÚNG bản gộp khoảng trắng (1 ký tự → 1 ký tự) nên
  // index khớp trên nó cắt thẳng ra chữ CÓ DẤU để đưa vào thông báo lỗi.
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  const norm = normalizeForMatch(collapsed);

  // (1) loại suất KHÁC gọi đúng tên — cả hai thứ tự chữ:
  //     vi/zh: "1 suất Cao cấp" · en: "1 Premium seat".
  const OTHER = /(?:(\d{1,3})\s*(?:suat|seats?|licenses?|席位)\s*(cao\s*cap|premium|高级))|(?:(\d{1,3})\s*(cao\s*cap|premium|高级)\s*(?:suat|seats?|licenses?|席位))/i;
  const other = norm.match(OTHER);
  if (other) {
    const count = parseInt(other[1] ?? other[3], 10);
    if (Number.isFinite(count) && count > 0) {
      const at = other.index ?? 0;
      const raw = collapsed.slice(at, at + other[0].length);
      return `hộp nói thêm "${raw}" — KHÔNG phải suất Tiêu chuẩn`;
    }
  }

  // (2) mệnh đề "Thêm …" liệt kê TỪ HAI cụm "<số> [loại] suất" trở lên — lưới
  // an toàn cho ca ChatGPT đổi tên loại suất thành chữ ta chưa biết.
  //
  // Phải xét MỌI chữ "Thêm" trong hộp, không chỉ chữ đầu: hộp mở đầu bằng dòng
  // "Thêm hoặc xóa các suất trong không gian làm việc của bạn" — bám chữ "Thêm"
  // đầu tiên là cửa sổ rơi trọn vào câu giới thiệu và bỏ sót đúng thẻ tóm tắt
  // cần chặn ("Thêm 1 suất Tiêu chuẩn và 1 suất Cao cấp") nằm mãi phía dưới.
  //
  // Cho phép tên loại chen giữa số và chữ "suất" (tiếng Anh: "1 Premium seat"),
  // và CHỈ đếm cụm có số > 0 — cụm "0 suất …" không mua gì thì không phải mua
  // kèm.
  const GROUP = /(\d{1,3})\s*(?:[\p{L}]{1,12}\s+){0,2}(?:suat|seats?|席位)/giu;
  for (const lead of norm.matchAll(/them|add\b|添加/gi)) {
    const at = lead.index ?? 0;
    const clause = norm.slice(at, at + 80);
    const groups = [...clause.matchAll(GROUP)].filter(
      (g) => parseInt(g[1], 10) > 0,
    );
    if (groups.length > 1) {
      return `hộp liệt kê ${groups.length} loại suất cùng lúc ("${collapsed.slice(at, at + 60).trim()}")`;
    }
  }

  return null;
}
