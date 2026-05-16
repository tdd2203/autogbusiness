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
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";
import { findMemberRow, findRowMenuButton } from "./member-row";

export async function executeChangeRole(
  email: string,
  newRole: ChatGPTRole,
): Promise<ExecuteActionResponse> {
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
    changeRoleItem = await waitFor(() => {
      return (
        querySelectorFirst<HTMLElement>(SELECTORS.changeRoleMenuItem) ??
        TEXT_FALLBACKS.changeRoleMenuItem
          .map((t) => queryByText('[role="menuitem"]', t))
          .find((el) => el !== null) ??
        null
      );
    }, 5000);
  } catch {
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
  const roleOption =
    queryByText('[role="menuitem"]', newRole) ??
    queryByText('[role="option"]', newRole) ??
    queryByText("button", newRole);
  if (!roleOption) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy option role '${newRole}' trong UI.`,
    };
  }
  await humanClick(roleOption);

  // Verify — đợi role text trong row đổi (best-effort; tuỳ theo UI có refresh ngay không)
  await randomDelay(1500, 3000);

  return { ok: true, data: { email, new_role: newRole } };
}
