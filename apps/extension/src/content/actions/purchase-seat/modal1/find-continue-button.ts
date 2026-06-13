import { queryByAnyText } from "../../../human";
import { findControlByKey } from "../../../i18n-ui";
import { TEXT_FALLBACKS } from "../../../selectors";

/**
 * Tìm nút "Tiếp tục" trong modal review. Có thể là <button> hoặc role=button.
 * Ưu tiên trong modal scope; fallback page-wide.
 */
export function findContinueButton(): HTMLElement | null {
  const dialog = document.querySelector<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
  );
  if (dialog) {
    const inDialog = queryByAnyText(
      "button",
      TEXT_FALLBACKS.billingContinueButton,
      dialog,
    );
    if (inDialog) return inDialog;
  }
  return findControlByKey(
    "billing_continue_button",
    TEXT_FALLBACKS.billingContinueButton,
    { page: "/admin/billing" },
  );
}
