import { querySelectorFirst } from "../../../human";
import { SELECTORS } from "../../../selectors";

export function findInviteEmailInput(): HTMLInputElement | HTMLTextAreaElement | null {
  // Ưu tiên element bên trong [role="dialog"] để tránh bắt nhầm input khác.
  const inDialog = querySelectorFirst<HTMLInputElement | HTMLTextAreaElement>(
    SELECTORS.inviteEmailInput,
  );
  if (inDialog) {
    console.log("[autogpt-invite] email input found:", inDialog.tagName, inDialog.type);
    return inDialog;
  }
  return null;
}

/** Đếm số input "email-like" trong dialog (multi-row UI 2026). */
export function countDialogEmailInputs(dialog: HTMLElement): number {
  return dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="email"], input[type="text"], textarea',
  ).length;
}

/** Trả input cuối cùng đang trống trong dialog — dùng cho row mới sau Add more. */
export function findLastEmptyEmailInput(
  dialog: HTMLElement,
): HTMLInputElement | HTMLTextAreaElement | null {
  const inputs = Array.from(
    dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="email"], input[type="text"], textarea',
    ),
  );
  // Duyệt ngược: chọn input rỗng cuối cùng (row mới nhất luôn ở dưới)
  for (let i = inputs.length - 1; i >= 0; i--) {
    const el = inputs[i];
    if (!el.value) return el;
  }
  return null;
}
