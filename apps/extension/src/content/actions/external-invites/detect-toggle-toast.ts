/**
 * Bắt câu ChatGPT in ra NGAY SAU khi công tắc "Cho phép lời mời từ miền bên
 * ngoài" (/admin/identity) đổi trạng thái — user gửi nguyên văn 30/8/2026:
 *
 *   TẮT: "Lời mời từ miền bên ngoài bị vô hiệu hóa với không gian làm việc này"
 *
 * VÌ SAO CẦN, dù `set-toggle.ts` đã đọc `aria-checked` và poll tới khi khớp:
 * `aria-checked` là trạng thái CLIENT vẽ ra sau cú bấm — nó nói "React đã đổi
 * state và fire PATCH", không nói "ChatGPT đã ghi nhận". Câu này thì có: ChatGPT
 * chỉ in ra sau khi lưu xong, và nó gọi thẳng tên không gian làm việc. Hai chỗ
 * dùng:
 *
 *   1. Ghi vào kết quả lệnh (`external_toggle_toast`) để soi lại được về sau —
 *      trước nay chỉ có mỗi cờ `confirmed` do chính ta suy ra.
 *   2. CỨU nhánh tắt: mất công tắc khỏi DOM (trang vừa điều hướng, re-render)
 *      thì `readStateFresh` trả null và ta phải cảnh báo "không xác nhận được
 *      đã tắt" dù ChatGPT vừa nói thẳng là đã tắt.
 *
 * ⚠️ Chiều ngược lại KHÔNG đúng: không thấy câu này KHÔNG có nghĩa là chưa đổi
 * (toast tự tắt sau vài giây, ta chỉ ngó trang theo nhịp poll). Nó chỉ dùng để
 * KHẲNG ĐỊNH, không bao giờ để phủ định.
 *
 * ⚠️ Và chỉ nhận câu nói ĐỦ HAI VẾ: vế "lời mời ngoài miền" + vế "bị vô hiệu
 * hoá / được bật". Nguyên nhãn của chính công tắc ("Cho phép lời mời từ miền bên
 * ngoài") cũng nằm trên trang này — nhận một vế là ăn nhầm nhãn, tức tự khai
 * bằng chứng cho một cú bấm chưa hề xảy ra.
 */

/** Bỏ dấu + gộp khoảng trắng + thường hoá, để khớp chữ bất kể locale gõ kiểu gì. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Vế 1 — câu đang nói về LỜI MỜI NGOÀI MIỀN chứ không phải setting khác. */
const SUBJECT_PATTERNS = [
  /loi\s*moi\s*(?:tu\s*)?(?:cac\s*)?mien\s*ben\s*ngoai/,
  /loi\s*moi\s*(?:tu\s*)?ben\s*ngoai\s*to\s*chuc/,
  /external\s*domain\s*invit/,
  /invit\w*\s*from\s*external\s*domain/,
  /外部域(?:名)?邀请/,
  /外部邀请/,
];

/** Vế 2a — câu nói setting ĐÃ TẮT. */
const OFF_PATTERNS = [
  /bi\s*vo\s*hieu\s*hoa/,
  /da\s*bi\s*(?:vo\s*hieu\s*hoa|tat)/,
  /(?:da\s*)?tat\s*(?:cho|voi|doi\s*voi)/,
  /(?:is|are|was|were|has\s*been|have\s*been)?\s*disabled/,
  /turned\s*off/,
  /已(?:被)?(?:禁用|停用|关闭)/,
];

/** Vế 2b — câu nói setting ĐÃ BẬT. */
const ON_PATTERNS = [
  /duoc\s*bat/,
  /da\s*(?:duoc\s*)?(?:bat|kich\s*hoat)/,
  /(?:is|are|was|were|has\s*been|have\s*been)?\s*enabled/,
  /turned\s*on/,
  /已(?:被)?(?:启用|开启)/,
];

/** Câu dài quá mức này là quét trúng cả trang chứ không phải riêng dòng toast. */
const MAX_TOAST_LEN = 300;

/** Nơi ChatGPT treo toast — quét trước để lấy đúng câu ngắn. */
const TOAST_SELECTORS = [
  '[role="status"]',
  '[role="alert"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  "[data-radix-toast-root]",
  "[data-sonner-toast]",
].join(",");

/**
 * Đoạn text này có phải câu ChatGPT báo công tắc vừa đổi không, và đổi về đâu?
 * `null` = không phải (hoặc mập mờ: nói cả tắt lẫn bật thì không dám chọn).
 */
export function readToggleToastText(raw: string): boolean | null {
  const norm = normalize(raw);
  if (!SUBJECT_PATTERNS.some((re) => re.test(norm))) return null;
  const off = OFF_PATTERNS.some((re) => re.test(norm));
  const on = ON_PATTERNS.some((re) => re.test(norm));
  if (off === on) return null;
  return on;
}

/**
 * Tìm câu ĐANG hiện trên trang, trả nguyên văn (giữ dấu) + trạng thái nó khai.
 * Không có → null.
 *
 * Chỉ quét các vùng thông báo, KHÔNG đi bộ cả `body`: nhãn công tắc và phần mô
 * tả của nó nằm ngay trên cùng trang, quét rộng là mời gọi khớp nhầm — mà khớp
 * nhầm ở đây đẻ ra bằng chứng giả cho một thao tác chưa xảy ra.
 */
export function findExternalToggleToast(): {
  text: string;
  enabled: boolean;
} | null {
  const nodes = document.querySelectorAll<HTMLElement>(TOAST_SELECTORS);
  let best: { text: string; enabled: boolean } | null = null;
  for (const el of Array.from(nodes)) {
    const raw = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    if (!raw) continue;
    const state = readToggleToastText(raw);
    if (state === null) continue;
    // Câu NGẮN NHẤT khớp: hộp cha nào cũng "chứa" toast con của nó.
    if (best === null || raw.length < best.text.length) {
      best = { text: raw, enabled: state };
    }
  }
  if (!best) return null;
  return best.text.length > MAX_TOAST_LEN
    ? { text: `${best.text.slice(0, MAX_TOAST_LEN)}…`, enabled: best.enabled }
    : best;
}
