/**
 * Tìm input "Người dùng" trong modal review. ChatGPT dùng number-like text
 * input không có aria-label rõ ràng — fallback: tìm trong [role="dialog"] /
 * [aria-modal="true"] input chứa giá trị numeric.
 */
export function findUserCountInput(): HTMLInputElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
    ),
  );
  for (const dialog of dialogs) {
    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input"));
    for (const inp of inputs) {
      const value = inp.value?.trim() ?? "";
      // Chấp nhận input chứa số nguyên (1-999), bỏ qua input email/text dài.
      if (/^\d{1,3}$/.test(value)) return inp;
    }
  }
  // Fallback page-wide: bất kỳ input numeric nào trên trang (last resort).
  const all = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
  for (const inp of all) {
    const value = inp.value?.trim() ?? "";
    if (/^\d{1,3}$/.test(value) && inp.offsetParent !== null) return inp;
  }
  return null;
}
