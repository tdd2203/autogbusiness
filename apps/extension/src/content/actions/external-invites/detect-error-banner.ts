/**
 * Bắt BĂNG-RÔN ĐỎ mà ChatGPT in ra NGAY SAU cú bấm công tắc "Cho phép lời mời
 * từ miền bên ngoài" (/admin/identity) — ảnh user chụp 3/9/2026:
 *
 *   "Something went wrong. If this issue persists please contact us through our
 *    help center at help.openai.com."
 *
 * VÌ SAO PHẢI BẮT RIÊNG, dù đã có `detect-toggle-toast` + poll `aria-checked`:
 * gặp ca này React vẫn vẽ công tắc sang ON (state client đổi trước, PATCH hỏng
 * sau), nên `aria-checked` khai ON mà ChatGPT thì KHÔNG lưu. Tin theo công tắc
 * là đi mời email ngoài miền vào một workspace vẫn đang chặn → ChatGPT từ chối
 * im lặng → dashboard treo "đang chờ" cho lời mời chưa từng tồn tại.
 *
 * Thấy băng-rôn thì chốt duy nhất đáng tin là TẢI LẠI TRANG rồi đọc lại công
 * tắc (user: "lập tức f5"). Còn OFF sau khi F5 ⇒ ChatGPT đang lỗi thật, phải
 * ngưng mời — xem `runner.ts` nhánh `awaiting_external_recheck`.
 *
 * ⚠️ Chiều ngược lại KHÔNG đúng: không thấy băng-rôn KHÔNG có nghĩa là đã lưu
 * xong (nó tự tắt sau vài giây, ta chỉ ngó trang theo nhịp poll).
 *
 * ⚠️ Nhận nhầm ở đây RẺ: hậu quả duy nhất là thêm một lần F5 + đọc lại công
 * tắc, đều là việc chỉ-đọc. Nên bộ chữ ở dưới lấy rộng vừa phải, không cần chặt
 * như `detect-toggle-toast` (bên đó nhận nhầm là tự khai bằng chứng giả).
 */

import { normalizeIdentityText } from "./normalize-text";

/**
 * Các cụm ChatGPT dùng khi báo hỏng chung. Cố ý KHÔNG nhận mấy chữ lẻ đứng một
 * mình ("lỗi", "error", "thử lại") — chúng là nhãn nút và chữ trong phần mô tả.
 */
const ERROR_PATTERNS = [
  /something\s*went\s*wrong/,
  /da\s*xay\s*ra\s*su\s*co/,
  /co\s*loi\s*xay\s*ra/,
  /(?:da\s*)?xay\s*ra\s*loi/,
  /an?\s*error\s*(?:occurred|happened)/,
  /there\s*was\s*(?:a|an)\s*(?:problem|error)/,
  /khong\s*the\s*(?:cap\s*nhat|luu)/,
  /(?:we\s*)?(?:could\s*not|couldn'?t|unable\s*to)\s*(?:update|save)/,
  /出了点问题/,
  /发生(?:了)?错误/,
  /出现(?:了)?错误/,
];

/**
 * Dải nâu "A workspace member hit a limit / Turn on auto-reload..." nằm ngay
 * cạnh băng-rôn đỏ trong đúng ảnh user gửi, nhưng KHÔNG cần loại riêng: nó nói
 * về hạn mức tín dụng và không chứa cụm nào ở trên. Đừng thêm danh sách loại
 * trừ cho nó — hàm dưới bắt đầu bằng cách khớp trên `textContent` của CẢ hộp
 * cha, nên một cụm "không phải lỗi" đặt ở đó sẽ giết luôn cả băng-rôn thật khi
 * hai dải cùng hiện.
 */

/** Câu dài quá mức này là quét trúng cả trang chứ không phải riêng băng-rôn. */
const MAX_BANNER_LEN = 300;

/** Đoạn text này có phải câu ChatGPT báo hỏng không? (tách riêng để test) */
export function isIdentityErrorText(raw: string): boolean {
  const norm = normalizeIdentityText(raw);
  return ERROR_PATTERNS.some((re) => re.test(norm));
}

/**
 * Tìm băng-rôn đỏ ĐANG hiện trên trang, trả nguyên văn (giữ dấu) để ghi vào
 * kết quả lệnh cho người đọc sau này. Không có → null.
 *
 * Đi bộ từ `body` chứ không chỉ ngó vùng thông báo: băng-rôn này ChatGPT vẽ
 * chồng lên header, không chắc nằm trong `[role="alert"]` nào. Đi rộng ở đây an
 * toàn vì mấy cụm chữ trên KHÔNG có sẵn trong nội dung tĩnh của /admin/identity
 * — khác câu xác nhận công tắc, vốn trùng chính nhãn của công tắc.
 *
 * Lấy node SÂU NHẤT còn khớp: hộp cha nào cũng "chứa" băng-rôn con của nó, mà
 * chép cả trang vào thông báo lệnh thì không ai đọc nổi.
 */
export function findIdentityErrorBanner(
  root: HTMLElement = document.body,
): string | null {
  if (!root || !isIdentityErrorText(root.textContent ?? "")) return null;

  let best: string | null = null;
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const text = (child.textContent ?? "").trim();
      if (!text || !isIdentityErrorText(text)) continue;
      if (best === null || text.length < best.length) best = text;
      walk(child);
    }
  };
  walk(root);

  const picked = (best ?? root.textContent ?? "").trim().replace(/\s+/g, " ");
  if (!picked) return null;
  return picked.length > MAX_BANNER_LEN
    ? `${picked.slice(0, MAX_BANNER_LEN)}…`
    : picked;
}
