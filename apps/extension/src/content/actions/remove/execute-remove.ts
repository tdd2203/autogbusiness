import type { ExecuteActionResponse } from "../../../shared/messages";
import {
  humanClick,
  normalizeMatchText,
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

const LOG = "[autogpt-remove]";

/**
 * Mọi phần tử "item" trong menu "..." đang mở. ChatGPT (Radix UI) KHÔNG luôn gắn
 * `role="menuitem"` — item xoá có thể là `menuitemradio`/`option`/`button` trong
 * `[role="menu"]`. v0.7.14 chỉ quét `[role="menuitem"]` → bỏ sót "Loại bỏ thành
 * viên" → fail "không có item Remove". Quét rộng như change-license-type.
 */
function openMenuItems(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], ' +
        '[role="menu"] [role="option"], [role="menu"] button, ' +
        '[role="menuitem"], [role="menuitemradio"], [role="option"]',
    ),
  );
}

/** Text mọi menu item đang mở — đưa vào error_message để debug DOM thật. */
function dumpMenuItems(): string[] {
  return openMenuItems()
    .map((e) => (e.textContent ?? "").trim())
    .filter(Boolean);
}

/** Tìm item menu khớp 1 trong các nhãn (substring sau normalize). */
function findMenuItemByText(texts: readonly string[]): HTMLElement | null {
  const items = openMenuItems();
  for (const t of texts) {
    const needle = normalizeMatchText(t);
    if (!needle) continue;
    for (const el of items) {
      const hay = normalizeMatchText(el.textContent ?? "");
      if (hay === needle || hay.includes(needle)) return el;
    }
  }
  return null;
}

/** Nút xác nhận xoá trong dialog — quét cả `[role="dialog"]`/`[role="alertdialog"]`. */
function findConfirmRemoveButton(texts: readonly string[]): HTMLElement | null {
  const sel = querySelectorFirst<HTMLElement>(SELECTORS.confirmRemoveButton);
  if (sel) return sel;
  const btns = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"] button, [role="alertdialog"] button, button',
    ),
  );
  for (const t of texts) {
    const needle = normalizeMatchText(t);
    if (!needle) continue;
    for (const b of btns) {
      const hay = normalizeMatchText(b.textContent ?? "");
      // So khớp CHÍNH XÁC hoặc bắt đầu bằng nhãn để tránh dính nút "Hủy bỏ".
      if (hay === needle || hay.startsWith(needle)) return b;
    }
  }
  return null;
}

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

  // Đợi menu mở rồi tìm item "Loại bỏ thành viên" (vi) / "Remove" (en) / …
  const dbRemove = dbLabelsFor("menu_remove_member", "/admin/members");
  const removeTexts =
    dbRemove.length > 0
      ? [...dbRemove, ...TEXT_FALLBACKS.removeMenuItem]
      : TEXT_FALLBACKS.removeMenuItem;
  let removeItem: HTMLElement | null = null;
  try {
    removeItem = await waitFor(() => {
      return (
        querySelectorFirst<HTMLElement>(SELECTORS.removeMenuItem) ??
        findMenuItemByText(removeTexts)
      );
    }, 5000);
  } catch {
    if (dbRemove.length > 0) {
      reportLabelMismatch("menu_remove_member", dbRemove[0], "/admin/members");
    }
    // Dump item thật để biết menu rỗng (menu không mở) hay text/role khác.
    const seen = dumpMenuItems();
    console.warn(`${LOG} remove item not found. Menu items:`, JSON.stringify(seen));
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        seen.length === 0
          ? "Menu '...' không mở (không thấy item nào). ChatGPT có thể đổi nút menu row."
          : `Menu mở nhưng không có item xoá. Item thấy: ${JSON.stringify(seen)}`,
    };
  }

  await randomDelay();
  await humanClick(removeItem);

  // Đợi confirm dialog → nút đỏ "Xóa" (vi) / "Remove" (en). Bỏ qua "Hủy bỏ".
  const dbConfirm = dbLabelsFor("confirm_remove_button", "/admin/members");
  const confirmTexts =
    dbConfirm.length > 0
      ? [...dbConfirm, ...TEXT_FALLBACKS.confirmRemoveButton]
      : TEXT_FALLBACKS.confirmRemoveButton;
  let confirmBtn: HTMLElement;
  try {
    confirmBtn = await waitFor(() => findConfirmRemoveButton(confirmTexts), 5000);
  } catch {
    if (dbConfirm.length > 0) {
      reportLabelMismatch("confirm_remove_button", dbConfirm[0], "/admin/members");
    }
    const btns = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"] button, [role="alertdialog"] button',
      ),
    )
      .map((b) => (b.textContent ?? "").trim())
      .filter(Boolean);
    console.warn(`${LOG} confirm button not found. Dialog buttons:`, JSON.stringify(btns));
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy nút xác nhận xoá. Nút trong dialog: ${JSON.stringify(btns)}`,
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
