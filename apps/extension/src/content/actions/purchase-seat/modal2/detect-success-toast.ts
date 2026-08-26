/**
 * Bắt băng-rôn XANH ChatGPT in ra khi giao dịch mua suất ĐÃ ĐI QUA:
 * "Gói đăng ký của bạn đã được cập nhật thành công" (ảnh user 2026-08-26).
 *
 * VÌ SAO CẦN, dù đã có `detect-error-banner` và bước đọc số suất trên trang:
 * đây là câu duy nhất ChatGPT nói THẲNG rằng nó đã ghi nhận giao dịch. Ba chỗ
 * dùng, cả ba đều là chỗ trước nay phải đoán:
 *
 *   1. Hộp thanh toán không chịu đóng → thay vì nằm chờ hết 120s rồi trả lời
 *      "giao dịch CÓ THỂ đã đi qua", thấy băng-rôn này là biết ngay đã xong,
 *      chỉ còn phải tải lại trang cho sạch lớp phủ.
 *   2. Băng-rôn ĐỎ chớp lên rồi ChatGPT vẫn làm xong (nó có ca dựng lại màn hình
 *      hỏng sau khi đã trừ tiền) → có băng-rôn xanh thì lỗi kia là lỗi màn hình.
 *   3. QUAN TRỌNG NHẤT — cấm đường MUA LẠI. Sau khi F5 mà số suất chưa nhích,
 *      `judgeSeatsAfterReload` vốn kết luận "chưa mua" rồi cho mua lại một lần.
 *      Thấy câu này thì "chưa nhích" chỉ là trang chậm/hiệu lực kỳ sau, KHÔNG
 *      phải chưa trừ tiền — hạ xuống "không rõ" để người quyết, khỏi mua đúp.
 *
 * ⚠️ Chiều ngược lại KHÔNG đúng: không thấy băng-rôn KHÔNG có nghĩa là chưa mua
 * (toast tự tắt sau vài giây, và ta chỉ đọc trang theo nhịp `CHARGE_DISMISS_POLL_MS`).
 * Nó chỉ dùng để KHẲNG ĐỊNH đã mua, không bao giờ để phủ định.
 */

import { normalizeForMatch } from "./money";

/**
 * Các cụm ChatGPT dùng khi báo giao dịch thành công. Chặt tay như bên
 * `detect-error-banner`: phải có cả VẾ "gói đăng ký / subscription" lẫn vế
 * "cập nhật thành công", để không ăn nhầm chữ "thành công" của phần khác trên
 * trang (ví dụ toast "Đã gửi lời mời thành công" của chính bước mời).
 */
const SUCCESS_PATTERNS = [
  /goi\s*dang\s*ky.{0,24}?da\s*duoc\s*cap\s*nhat\s*thanh\s*cong/,
  /goi\s*dang\s*ky.{0,24}?cap\s*nhat\s*thanh\s*cong/,
  /cap\s*nhat\s*goi\s*dang\s*ky\s*thanh\s*cong/,
  /subscription\s*(?:has\s*been|was|is)?\s*(?:successfully\s*)?updated/,
  /(?:successfully\s*)?updated\s*your\s*subscription/,
  /订阅.{0,10}?更新成功/,
  /已成功更新.{0,10}?订阅/,
];

/** Câu dài quá mức này là quét trúng cả trang chứ không phải riêng băng-rôn. */
const MAX_TOAST_LEN = 300;

/**
 * Nơi ChatGPT treo toast. Quét các node này TRƯỚC để lấy đúng câu ngắn, thay vì
 * bốc cả cụm cha. Không có node nào khớp thì mới đi bộ từ `body`.
 */
const TOAST_SELECTORS = [
  '[role="status"]',
  '[role="alert"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  "[data-radix-toast-root]",
  "[data-sonner-toast]",
].join(",");

/** Đoạn text này có phải câu báo mua thành công của ChatGPT không? */
export function isSuccessToastText(raw: string): boolean {
  const norm = normalizeForMatch(raw);
  return SUCCESS_PATTERNS.some((re) => re.test(norm));
}

/** Node nào là toast/vùng thông báo — `overlayStillUp` phải bỏ qua chúng. */
export function isToastNode(el: Element): boolean {
  const role = el.getAttribute("role");
  if (role === "status" || role === "alert" || role === "log") return true;
  if (el.getAttribute("aria-live")) return true;
  if (el.getAttribute("data-radix-toast-root") !== null) return true;
  if (el.getAttribute("data-sonner-toast") !== null) return true;
  return false;
}

/** Lấy node SÂU NHẤT còn khớp (câu ngắn nhất) — hộp cha nào cũng "chứa" nó. */
function deepestMatch(root: Element): string | null {
  let best: string | null = null;
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const text = (child.textContent ?? "").trim();
      if (!text || !isSuccessToastText(text)) continue;
      if (best === null || text.length < best.length) best = text;
      walk(child);
    }
  };
  walk(root);
  return best;
}

/**
 * Tìm băng-rôn "đã cập nhật thành công" ĐANG hiện trên trang, trả về nguyên văn
 * (giữ dấu) để ghi vào kết quả task. Không có → null.
 *
 * Quét cả trang chứ không riêng trong hộp: toast của ChatGPT treo ở đỉnh trang,
 * ngoài hộp thanh toán (ảnh user 2026-08-26 — hộp đã đóng, toast còn nằm giữa
 * đầu trang Thành viên).
 */
export function findSuccessToast(): string | null {
  const body: Element | null = document.body ?? null;
  // Cửa rẻ: một phép so trên toàn bộ text trang. Không khớp thì khỏi đi bộ DOM —
  // hàm này được gọi 2 lần/giây suốt lúc chờ giao dịch.
  const pageText = body ? body.textContent ?? "" : "";
  if (!isSuccessToastText(pageText)) return null;

  let best: string | null = null;
  const consider = (raw: string | null | undefined): void => {
    const text = (raw ?? "").trim();
    if (!text || !isSuccessToastText(text)) return;
    if (best === null || text.length < best.length) best = text;
  };

  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(TOAST_SELECTORS),
  )) {
    consider(el.textContent);
  }
  if (best === null && body) best = deepestMatch(body);

  const picked = (best ?? pageText).trim().replace(/\s+/g, " ");
  return picked.length > MAX_TOAST_LEN
    ? `${picked.slice(0, MAX_TOAST_LEN)}…`
    : picked;
}
