import { queryByAnyText } from "../../../human";
import { TEXT_FALLBACKS } from "../../../selectors";

/**
 * Tìm modal review #2 ("Quản lý chỗ ngồi"). Khác modal #1: KHÔNG có input
 * numeric (đã ẩn), CÓ button "Thêm người dùng" + KHÔNG có nút "+/-".
 *
 * Heuristic: scan dialogs đang mở, pick dialog nào chứa text "suất" / "seat" /
 * currency amount + button matching `billingAddUserButton` patterns.
 */
export function findChargeModal(_quantity: number): HTMLElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"]',
    ),
  );
  for (const dialog of dialogs) {
    // Modal #2 luôn có: "suất ... bổ sung" / "additional seat" / "tổng" / "total"
    const hasSeatPhrase =
      /suất.{0,20}bổ\s*sung|additional\s+seat|additional\s+user|bổ\s*sung|额外|附加/i.test(
        dialog.textContent ?? "",
      );
    // KHÔNG có input numeric đang visible
    const numericInputs = Array.from(
      dialog.querySelectorAll<HTMLInputElement>("input"),
    ).filter((i) => /^\d{1,3}$/.test((i.value ?? "").trim()));
    // CÓ button "Thêm người dùng" hoặc tương tự
    const hasConfirmButton = !!queryByAnyText(
      "button",
      TEXT_FALLBACKS.billingAddUserButton,
      dialog,
    );
    if (hasSeatPhrase && numericInputs.length === 0 && hasConfirmButton) {
      return dialog;
    }
    // Fallback: dialog có currency amount + confirm button
    const hasCurrency = /[₫đ]\s*\d|\$\s*\d|¥\s*\d/i.test(dialog.textContent ?? "");
    if (hasCurrency && hasConfirmButton && numericInputs.length === 0) {
      return dialog;
    }
  }
  return null;
}
