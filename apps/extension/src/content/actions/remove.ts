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
    removeItem = await waitFor(() => {
      return (
        querySelectorFirst<HTMLElement>(SELECTORS.removeMenuItem) ??
        TEXT_FALLBACKS.removeMenuItem
          .map((t) => queryByText('[role="menuitem"]', t))
          .find((el) => el !== null) ??
        null
      );
    }, 5000);
  } catch {
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
    confirmBtn = await waitFor(() => {
      return (
        querySelectorFirst<HTMLElement>(SELECTORS.confirmRemoveButton) ??
        TEXT_FALLBACKS.confirmRemoveButton
          .map((t) => queryByText("button", t))
          .find((el) => el !== null) ??
        null
      );
    }, 5000);
  } catch {
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
