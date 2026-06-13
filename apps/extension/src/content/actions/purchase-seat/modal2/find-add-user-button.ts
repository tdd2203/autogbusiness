import { queryByAnyText } from "../../../human";
import { TEXT_FALLBACKS } from "../../../selectors";

/**
 * Tìm nút "Thêm người dùng" trong modal review #2. Scope strictly trong modal
 * để tránh match nhầm "Thêm" ở chỗ khác.
 */
export function findAddUserButton(modal: HTMLElement): HTMLElement | null {
  // Ưu tiên button primary (variant=primary / class chứa "primary" hoặc bg-black)
  // sau đó fallback text match.
  const inModal = queryByAnyText(
    "button",
    TEXT_FALLBACKS.billingAddUserButton,
    modal,
  );
  if (inModal) return inModal;
  // Fallback: button cuối trong modal (thường là primary CTA bên phải)
  const buttons = Array.from(modal.querySelectorAll<HTMLButtonElement>("button"));
  const visible = buttons.filter(
    (b) =>
      !b.hasAttribute("disabled") &&
      b.getAttribute("aria-label")?.toLowerCase() !== "close" &&
      !/close|đóng|关闭/i.test(b.getAttribute("aria-label") ?? "") &&
      b.offsetParent !== null,
  );
  // Loại bỏ nút "Hủy bỏ" / "Cancel"
  const noCancel = visible.filter(
    (b) => !/hủy|huỷ|cancel|取消/i.test((b.textContent ?? "").trim()),
  );
  return noCancel[noCancel.length - 1] ?? null;
}
