import { queryByAnyText } from "../../../human";
import { TEXT_FALLBACKS } from "../../../selectors";
import { normalizeForMatch } from "./money";

/**
 * Nút KHÔNG BAO GIỜ được bấm ở bước cuối: nút lùi/huỷ/đóng. Modal mới có
 * "Quay lại" nằm cạnh "Xác nhận mua" — bản cũ chỉ loại "Hủy/Cancel/取消" nên
 * "Quay lại" lọt lưới.
 */
const DISMISS_TEXTS =
  /^(quay\s*lai|huy|huy\s*bo|dong|back|cancel|close|dismiss|返回|取消|关闭)$/i;

/** Nút đổi phương thức thanh toán ("Thay đổi") — cũng không phải nút xác nhận. */
const CHANGE_PAYMENT_TEXTS = /^(thay\s*doi|change|edit|更改|修改)$/i;

/**
 * Tìm nút xác nhận cuối cùng trong modal "Xem lại giao dịch mua".
 * ⚠️ Bấm nút này = TRỪ TIỀN THẬT NGAY qua thẻ đã lưu.
 *
 * Chỉ quét TRONG modal để không với ra nút khác trên trang.
 */
export function findConfirmPurchaseButton(modal: HTMLElement): HTMLElement | null {
  const byText = queryByAnyText("button", TEXT_FALLBACKS.billingAddUserButton, modal);
  if (byText) return byText;

  // ChatGPT đổi nhãn → lấy nút hành động cuối cùng. Modal luôn xếp nút xác nhận
  // ở cuối, bên phải nút lùi.
  const candidates = Array.from(modal.querySelectorAll<HTMLButtonElement>("button"))
    .filter((b) => {
      if (b.hasAttribute("disabled")) return false;
      const aria = b.getAttribute("aria-label") ?? "";
      if (/close|đóng|dong|关闭/i.test(aria)) return false;
      const text = normalizeForMatch(b.textContent ?? "");
      if (!text) return false; // nút icon-only (X đóng modal)
      if (DISMISS_TEXTS.test(text)) return false;
      if (CHANGE_PAYMENT_TEXTS.test(text)) return false;
      return true;
    });
  return candidates[candidates.length - 1] ?? null;
}
