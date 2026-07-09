import type { ExecuteActionResponse } from "../../../shared/messages";
import {
  humanClick,
  humanType,
  normalizeMatchText,
  querySelectorFirst,
  randomDelay,
  sleep,
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

/**
 * Re-verify "đã xoá" bằng cách ép ChatGPT LỌC LẠI TỪ SERVER (clear ô lọc + gõ lại
 * email). Sau khi click confirm Remove, ChatGPT xoá qua server round-trip rồi refetch
 * list — nếu mạng chậm, list (filter optimistic) có thể VẪN còn row trong >10s dù
 * server đã xoá xong → verify cũ timeout 10s → VERIFY_FAILED OAN (bug user 2026-06-29:
 * "xoá thành công nhưng chưa chờ xong đã ghi nhận lỗi"). Lọc lại từ server cho câu trả
 * lời dứt khoát: gõ lại email, nếu row KHÔNG xuất hiện trong 5s = member đã bị xoá thật.
 *
 * Trả true nếu đã xoá (không còn row), false nếu vẫn còn (server vẫn trả member).
 */
async function reverifyRemovedViaFilter(email: string): Promise<boolean> {
  const input = querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput);
  if (!input) {
    // Không có ô lọc → chỉ dựa vào DOM hiện tại.
    return findMemberRow(email) === null;
  }
  const needle = email.includes("@") ? email.split("@")[0] : email;
  await clearMemberFilter();
  await sleep(300);
  await humanType(input, needle); // humanType tự clear trước khi gõ
  await sleep(700); // chờ debounce + ChatGPT re-query server
  try {
    // Row XUẤT HIỆN trong 5s → server vẫn trả member = chưa xoá. Không thấy → đã xoá.
    await waitFor(() => findMemberRow(email), 5000, 250);
    console.warn(`${LOG} re-verify: ${email} VẪN còn sau khi lọc lại từ server`);
    return false;
  } catch {
    console.log(`${LOG} re-verify: ${email} đã biến mất sau khi lọc lại từ server → đã xoá`);
    return true;
  }
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
  // Render-wait + click nút "Người dùng". `waitForButtonMs=12000`: tab vừa F5/
  // navigate (ensureAdminTab tái dùng tab) → thanh tab có thể CHƯA render → tra 1
  // lần sẽ trượt → kẹt ở tab hiện tại. Cùng cơ chế sync-member/revoke. TRƯỚC đây
  // không truyền waitForButtonMs → nếu tab còn ?tab=invites (action trước để lại)
  // thì không kịp click về Người dùng → lọc nhầm tab Lời mời (bug 2026-06-29).
  await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    undefined,
    12_000,
  );

  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${email} bằng ô lọc...` },
    true,
  );
  // REMOVE dùng ô lọc làm nguồn sự thật: search không ra email thì DỪNG, không
  // lật trang (pageThrough=false). Tránh quét chậm/ồn khi email vốn không có
  // trong tab Người dùng (yêu cầu user 2026-06-21).
  const row = await locateMemberRow(email, { pageThrough: false });
  if (!row) {
    // GUARD chống mark-removed OAN (bug user 2026-06-29): chỉ kết luận "đã rời
    // business" khi CHẮC CHẮN đang ở tab "Người dùng". URL là nguồn sự thật —
    // tab Người dùng KHÔNG có ?tab=invites/requests. Nếu URL còn ?tab=invites
    // (action trước để lại + reload giữ param, hoặc click tab về Người dùng thất
    // bại) thì ô lọc đang lọc danh sách LỜI MỜI → member active không có ở đó là
    // ĐƯƠNG NHIÊN, TUYỆT ĐỐI không được mark removed. Trả UI_ELEMENT_NOT_FOUND
    // (FAILED, member CÒN) → task thử lại thay vì xoá oan khỏi dashboard.
    if (/[?&]tab=(invites|requests)/.test(location.search)) {
      return {
        ok: false,
        error_code: "UI_ELEMENT_NOT_FOUND",
        error_message:
          `Đang ở tab "${location.search}" chứ KHÔNG phải "Người dùng" khi tìm ${email} → ` +
          `bỏ qua để TRÁNH đánh dấu removed oan. Mở chatgpt.com/admin/members (tab Người dùng) rồi thử lại.`,
      };
    }
    // Ô lọc (filter server-side của ChatGPT) không ra row → email KHÔNG còn trong
    // tab Người dùng = không còn trong business. Trả MEMBER_NOT_IN_WORKSPACE để
    // backend mark removed ở dashboard luôn (không cần SYNC). Dùng code RIÊNG, KHÔNG
    // phải UI_ELEMENT_NOT_FOUND — code đó dành cho "member có nhưng menu/nút lỗi".
    return {
      ok: false,
      error_code: "MEMBER_NOT_IN_WORKSPACE",
      error_message: `Không tìm thấy ${email} khi lọc trong tab Người dùng → coi như đã rời business; đánh dấu removed ở dashboard.`,
    };
  }

  const menuBtn = findRowMenuButton(row);
  if (!menuBtn) {
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
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
      error_code: "FAILED_UI_CHANGED",
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
      error_code: "FAILED_UI_CHANGED",
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
    // Nới 10s→15s: ChatGPT xoá qua server round-trip + refetch, mạng chậm có thể
    // >10s — timeout sớm → VERIFY_FAILED oan dù đã xoá xong (bug user 2026-06-29).
    await waitFor(() => (findMemberRow(email) ? null : document.body), 15_000);
    verifyOk = true;
  } catch {
    // Path nhanh (theo dõi list filter sẵn) timeout → có thể list optimistic chưa
    // refetch. Hỏi lại SERVER dứt khoát bằng cách lọc lại email: không còn = đã xoá.
    verifyOk = await reverifyRemovedViaFilter(email);
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
