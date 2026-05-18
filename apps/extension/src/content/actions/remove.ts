import type { ExecuteActionResponse } from "../../shared/messages";
import {
  humanClick,
  queryByText,
  querySelectorFirst,
  randomDelay,
  waitFor,
} from "../human";
import { reportProgress } from "../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";
import { findMemberRow, findRowMenuButton } from "./member-row";
import { dbLabelsFor, reportLabelMismatch } from "../../shared/ui-labels";

export async function executeRemove(
  taskId: string,
  email: string,
): Promise<ExecuteActionResponse> {
  await reportProgress(taskId, { phase: "locating", message: `Tìm row của ${email}...` }, true);

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}).`,
    };
  }

  const row = findMemberRow(email);
  if (!row) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy row của member ${email}. Có thể chưa scroll tới hoặc đã bị xoá rồi.`,
    };
  }

  const menuBtn = findRowMenuButton(row);
  if (!menuBtn) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Không tìm thấy nút menu '...' trong row member.",
    };
  }
  await randomDelay();
  await humanClick(menuBtn);

  // Đợi menu mở
  let removeItem: HTMLElement | null = null;
  try {
    const dbRemove = dbLabelsFor("menu_remove_member", "/admin/members");
    const removeTexts =
      dbRemove.length > 0
        ? [...dbRemove, ...TEXT_FALLBACKS.removeMenuItem]
        : TEXT_FALLBACKS.removeMenuItem;
    removeItem = await waitFor(() => {
      return (
        querySelectorFirst<HTMLElement>(SELECTORS.removeMenuItem) ??
        removeTexts
          .map((t) => queryByText('[role="menuitem"]', t))
          .find((el) => el !== null) ??
        null
      );
    }, 5000);
  } catch {
    const dbRemove = dbLabelsFor("menu_remove_member", "/admin/members");
    if (dbRemove.length > 0) {
      reportLabelMismatch("menu_remove_member", dbRemove[0], "/admin/members");
    }
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Menu mở nhưng không có item 'Remove'.",
    };
  }

  await randomDelay();
  await humanClick(removeItem);

  // Đợi confirm dialog
  let confirmBtn: HTMLElement;
  try {
    const dbConfirm = dbLabelsFor("confirm_remove_button", "/admin/members");
    const confirmTexts =
      dbConfirm.length > 0
        ? [...dbConfirm, ...TEXT_FALLBACKS.confirmRemoveButton]
        : TEXT_FALLBACKS.confirmRemoveButton;
    confirmBtn = await waitFor(() => {
      return (
        querySelectorFirst<HTMLElement>(SELECTORS.confirmRemoveButton) ??
        confirmTexts
          .map((t) => queryByText("button", t))
          .find((el) => el !== null) ??
        null
      );
    }, 5000);
  } catch {
    const dbConfirm = dbLabelsFor("confirm_remove_button", "/admin/members");
    if (dbConfirm.length > 0) {
      reportLabelMismatch("confirm_remove_button", dbConfirm[0], "/admin/members");
    }
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Không tìm thấy nút confirm Remove.",
    };
  }

  await reportProgress(taskId, { phase: "confirming", message: "Click confirm Remove..." }, true);
  await randomDelay();
  await humanClick(confirmBtn);

  // Verify member biến mất khỏi danh sách
  await reportProgress(taskId, { phase: "verifying", message: "Đợi member biến mất khỏi danh sách..." }, true);
  try {
    await waitFor(() => (findMemberRow(email) ? null : document.body), 10_000);
  } catch {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: "Member vẫn còn trong danh sách sau khi confirm Remove.",
    };
  }

  return { ok: true, data: { email } };
}
