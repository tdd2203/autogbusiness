import type {
  ChatGPTRole,
  ExecuteActionResponse,
} from "../../shared/messages";
import {
  humanClick,
  queryByText,
  querySelectorFirst,
  randomDelay,
  waitFor,
} from "../human";
import { findRoleOption } from "../i18n-ui";
import { reportProgress } from "../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";
import { findMemberRow, findRowMenuButton } from "./member-row";
import { dbLabelsFor, reportLabelMismatch } from "../../shared/ui-labels";

export async function executeChangeRole(
  taskId: string,
  email: string,
  newRole: ChatGPTRole,
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
      error_message: `Không tìm thấy row của member ${email}.`,
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

  let changeRoleItem: HTMLElement;
  try {
    const dbChange = dbLabelsFor("menu_change_role", "/admin/members");
    const changeTexts =
      dbChange.length > 0
        ? [...dbChange, ...TEXT_FALLBACKS.changeRoleMenuItem]
        : TEXT_FALLBACKS.changeRoleMenuItem;
    changeRoleItem = await waitFor(() => {
      return (
        querySelectorFirst<HTMLElement>(SELECTORS.changeRoleMenuItem) ??
        changeTexts
          .map((t) => queryByText('[role="menuitem"]', t))
          .find((el) => el !== null) ??
        null
      );
    }, 5000);
  } catch {
    const dbChange = dbLabelsFor("menu_change_role", "/admin/members");
    if (dbChange.length > 0) {
      reportLabelMismatch("menu_change_role", dbChange[0], "/admin/members");
    }
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: "Menu mở nhưng không có item 'Change role'.",
    };
  }
  await randomDelay();
  await humanClick(changeRoleItem);

  // Sau khi click "Change role", có thể hiện submenu hoặc dialog với options
  await randomDelay(800, 1800);
  const roleOption = findRoleOption(newRole);
  if (!roleOption) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy option role '${newRole}' trong UI.`,
    };
  }
  await reportProgress(taskId, { phase: "applying", message: `Đang đổi role sang ${newRole}...` }, true);
  await humanClick(roleOption);

  // Verify — đợi role text trong row đổi (best-effort; tuỳ theo UI có refresh ngay không)
  await randomDelay(1500, 3000);

  return { ok: true, data: { email, new_role: newRole } };
}
