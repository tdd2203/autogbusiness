/**
 * Bắt băng-rôn LỖI ĐỎ mà ChatGPT in NGAY TRONG hộp xác nhận sau khi bấm nút
 * cuối: "Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn"
 * (ảnh user chụp 2026-08-26, hộp "Xem lại thay đổi người dùng").
 *
 * VÌ SAO CẦN: gặp ca này hộp KHÔNG đóng và nút cuối bị khoá lại. Luồng cũ chỉ
 * biết "hộp chưa đóng" nên nằm chờ cho hết `CHARGE_DISMISS_TIMEOUT_MS` (120s)
 * rồi trả về câu mơ hồ "giao dịch CÓ THỂ đã đi qua" — mất 2 phút mà vẫn không
 * ai biết đã trừ tiền hay chưa. Đọc được băng-rôn thì biết NGAY là ChatGPT đã
 * trả lời (chứ không phải đang xử lý), để đi thẳng sang bước F5 đọc lại số suất.
 *
 * ⚠️ KHÔNG suy ra "chưa mua" từ băng-rôn này. ChatGPT vẫn có thể đã ghi nhận
 * giao dịch rồi mới hỏng ở bước dựng lại màn hình — chốt duy nhất đáng tin là
 * SỐ SUẤT đọc lại sau khi tải lại trang.
 */

import { normalizeForMatch } from "./money";

/**
 * Các cụm ChatGPT dùng khi báo hỏng. Cố ý CHẶT: chỉ nhận câu nói thẳng là có sự
 * cố, không nhận mấy chữ chung chung ("thử lại", "error" đứng một mình) vốn có
 * thể là nhãn nút hay chữ trong phần khác của hộp.
 */
const ERROR_PATTERNS = [
  /da\s*xay\s*ra\s*su\s*co/,
  /co\s*loi\s*xay\s*ra/,
  /(da\s*)?xay\s*ra\s*loi/,
  /khong\s*the\s*cap\s*nhat/,
  /something\s*went\s*wrong/,
  /an?\s*error\s*(?:occurred|happened)/,
  /there\s*was\s*(?:a|an)\s*(?:problem|error)/,
  /(?:we\s*)?(?:could\s*not|couldn'?t|unable\s*to)\s*update/,
  /出了点问题/,
  /发生(?:了)?错误/,
  /出现(?:了)?错误/,
  /无法更新/,
];

/** Câu lỗi dài quá mức này là quét trúng cả hộp chứ không phải riêng băng-rôn. */
const MAX_BANNER_LEN = 300;

/** Đoạn text này có phải câu báo hỏng của ChatGPT không? (tách riêng để test) */
export function isErrorBannerText(raw: string): boolean {
  const norm = normalizeForMatch(raw);
  return ERROR_PATTERNS.some((re) => re.test(norm));
}

/**
 * Tìm băng-rôn lỗi trong hộp, trả về CHÍNH câu ChatGPT in ra (giữ nguyên dấu)
 * để ghi vào kết quả task cho user đọc. Không có lỗi → null.
 *
 * Lấy node SÂU NHẤT còn khớp: hộp cha nào cũng "chứa" câu lỗi, mà chép cả hộp
 * vào thông báo task thì không ai đọc nổi.
 */
export function findModalErrorBanner(modal: HTMLElement): string | null {
  const rootText = modal.textContent ?? "";
  if (!isErrorBannerText(rootText)) return null;

  let best: string | null = null;
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const text = (child.textContent ?? "").trim();
      if (!text || !isErrorBannerText(text)) continue;
      if (best === null || text.length < best.length) best = text;
      walk(child);
    }
  };
  walk(modal);

  const picked = (best ?? rootText).trim().replace(/\s+/g, " ");
  return picked.length > MAX_BANNER_LEN
    ? `${picked.slice(0, MAX_BANNER_LEN)}…`
    : picked;
}
