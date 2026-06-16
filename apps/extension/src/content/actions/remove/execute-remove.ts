import type { ExecuteActionResponse } from "../../../shared/messages";
import {
  humanClick,
  queryByText,
  querySelectorFirst,
  randomDelay,
  waitFor,
} from "../../human";
import { reportProgress } from "../../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../../selectors";
import { findMemberRow, findRowMenuButton } from "../member-row";
import { dbLabelsFor, reportLabelMismatch } from "../../../shared/ui-labels";
import { clickTabAndWait } from "../sync";
import { clearMemberFilter } from "./member-filter";
import { locateMemberRow } from "./locate-member";

export async function executeRemove(
  taskId: string,
  email: string,
): Promise<ExecuteActionResponse> {
  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}).`,
    };
  }

  // Đảm bảo đang ở tab "Người dùng" — REMOVE chỉ làm được trên active member
  // list, không phải tab "Lời mời" / "Yêu cầu". Best-effort, không fail nếu tab
  // button không có (có thể đã ở đúng tab rồi).
  await reportProgress(
    taskId,
    { phase: "navigating", message: "Chuyển tab Người dùng..." },
    true,
  );
  await clickTabAndWait("tab_active_members", TEXT_FALLBACKS.tabActiveMembers, 800);

  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${email} (ô lọc → lật trang nếu cần)...` },
    true,
  );
  // Định vị bền vững: ô lọc trước, không thấy thì lật hết trang + scroll
  // (giống SYNC) để không bỏ sót member trong list dài/phân trang.
  const row = await locateMemberRow(email);
  if (!row) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy ${email} sau khi duyệt hết mọi trang. Có thể email đã rời workspace; chạy SYNC để đối chiếu lại.`,
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

  // Verify member biến mất khỏi danh sách. Filter input vẫn đang giữ giá trị
  // search → list chỉ chứa row khớp; nếu row mất nghĩa là xoá thật sự thành
  // công (không phải do scroll out viewport).
  await reportProgress(taskId, { phase: "verifying", message: "Đợi member biến mất khỏi danh sách..." }, true);
  let verifyOk = false;
  try {
    await waitFor(() => (findMemberRow(email) ? null : document.body), 10_000);
    verifyOk = true;
  } catch {
    // Fall through — sẽ clear filter rồi return error.
  }

  // Clear filter cho list về trạng thái đầy đủ (UX: user mở tab admin lên thấy
  // toàn bộ member, không phải state đã filter).
  await clearMemberFilter();

  if (!verifyOk) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: "Member vẫn còn trong danh sách sau khi confirm Remove.",
    };
  }

  return { ok: true, data: { email } };
}
