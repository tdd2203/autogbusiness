import type {
  ExecuteActionResponse,
  LicenseType,
} from "../../../shared/messages";
import { humanClick, randomDelay, sleep, waitFor } from "../../human";
import {
  findLicenseTypeOption,
  findMenuItemByKey,
  TEXT_FALLBACKS,
} from "../../i18n-ui";
import { reportProgress } from "../../progress";
import { findRowMenuButton } from "../member-row";
import { clickTabAndWait } from "../sync";
import { clearMemberFilter } from "../remove/member-filter";
import { locateMemberRow } from "../remove/locate-member";

const LOG = "[autogpt-license]";

/** Dump text mọi menu item đang mở → console để debug DOM thật. */
function dumpOpenMenus(tag: string): string[] {
  const items = document.querySelectorAll<HTMLElement>(
    '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], ' +
      '[role="menu"] [role="option"], [role="menuitem"], [role="menuitemradio"], ' +
      '[role="option"]',
  );
  const texts = Array.from(items)
    .map((e) => (e.textContent ?? "").trim())
    .filter(Boolean);
  console.log(`${LOG} ${tag} — menu items:`, JSON.stringify(texts));
  return texts;
}

/** Mở submenu trigger bằng nhiều cách (Radix Sub mở theo pointer/hover/keyboard). */
async function openSubmenu(trigger: HTMLElement): Promise<void> {
  for (const type of ["pointerover", "pointerenter", "mouseover", "mousemove"]) {
    trigger.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true }),
    );
  }
  await sleep(250);
  try {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  } catch {
    /* noop */
  }
  await sleep(200);
  await humanClick(trigger);
  await sleep(400);
}

/** Tìm nút xác nhận trong dialog (nếu ChatGPT hỏi trước khi đổi). */
function findConfirmButton(): HTMLElement | null {
  const texts = ["change", "confirm", "switch", "update", "đổi", "xác nhận", "确认", "更改"];
  const btns = document.querySelectorAll<HTMLElement>(
    '[role="dialog"] button, [role="alertdialog"] button',
  );
  for (const b of Array.from(btns)) {
    const t = (b.textContent ?? "").trim().toLowerCase();
    if (t && texts.some((x) => t === x || t.startsWith(x))) return b;
  }
  return null;
}

/**
 * Đổi loại suất cấp phép (ChatGPT/Codex) của 1 member trên /admin/members.
 *
 * Flow (theo đúng thao tác user mô tả):
 *   1. Đảm bảo đang tab "Người dùng".
 *   2. LỌC THEO TÊN bằng email → list co lại 1 row (list 100+ member phân
 *      trang/ảo: không lọc thì findMemberRow không thấy row → đây là lý do
 *      v0.7.0–0.7.2 fail). Tái dùng locateMemberRow của REMOVE.
 *   3. Click nút "..." trên row.
 *   4. Menu hiện "Thay đổi loại giấy phép" → ChatGPT / Codex → click target.
 *   5. Xác nhận dialog nếu có → clear filter.
 */
export async function executeChangeLicenseType(
  taskId: string,
  email: string,
  newLicenseType: LicenseType,
  oldLicenseType: LicenseType | null = null,
): Promise<ExecuteActionResponse> {
  console.log(
    `${LOG} START email=${email} new=${newLicenseType} old=${oldLicenseType}`,
  );

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}).`,
    };
  }

  if (oldLicenseType && oldLicenseType === newLicenseType) {
    console.log(`${LOG} old===new → skip`);
    return {
      ok: true,
      data: { email, new_license_type: newLicenseType, skipped: "same" },
    };
  }

  // 1) Tab Người dùng (đổi giấy phép chỉ làm trên active list).
  await reportProgress(
    taskId,
    { phase: "navigating", message: "Chuyển tab Người dùng..." },
    true,
  );
  await clickTabAndWait("tab_active_members", TEXT_FALLBACKS.tabActiveMembers, 800);

  // 2) Lọc theo email → định vị row (lật trang nếu cần).
  await reportProgress(
    taskId,
    { phase: "searching", message: `Lọc theo tên: ${email}...` },
    true,
  );
  const row = await locateMemberRow(email);
  if (!row) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy ${email} sau khi lọc + lật mọi trang. Chạy SYNC để đối chiếu.`,
    };
  }
  console.log(`${LOG} row found via filter`);

  // 3) Click nút "..." trên row.
  await reportProgress(
    taskId,
    { phase: "opening-menu", message: `Mở menu "..." của ${email}...` },
    true,
  );
  const menuBtn = findRowMenuButton(row);
  if (!menuBtn) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm thấy nút "..." trong row của ${email}.`,
    };
  }
  await randomDelay();
  await humanClick(menuBtn);
  await sleep(500);
  dumpOpenMenus("after-open-...-menu");

  // 4) Tìm option ChatGPT/Codex (trực tiếp hoặc qua submenu "Thay đổi giấy phép").
  await reportProgress(
    taskId,
    { phase: "selecting", message: `Chọn giấy phép: ${newLicenseType}...` },
    true,
  );
  let option = findLicenseTypeOption(newLicenseType);
  if (option) {
    console.log(`${LOG} option '${newLicenseType}' tìm thấy TRỰC TIẾP`);
  } else {
    const submenuTrigger = findMenuItemByKey(
      "change_license_type",
      TEXT_FALLBACKS.changeLicenseTypeMenuItem,
      { page: "/admin/members" },
    );
    if (submenuTrigger) {
      console.log(
        `${LOG} submenu trigger="${(submenuTrigger.textContent ?? "").trim()}" → mở`,
      );
      await openSubmenu(submenuTrigger);
      dumpOpenMenus("after-open-submenu");
      // Đợi option xuất hiện (submenu có thể render trễ).
      try {
        option = await waitFor(() => findLicenseTypeOption(newLicenseType), 2500, 200);
      } catch {
        option = null;
      }
    } else {
      console.warn(`${LOG} KHÔNG thấy submenu trigger 'Thay đổi loại giấy phép'`);
    }
  }

  if (!option) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Mở menu "..." nhưng KHÔNG tìm thấy option '${newLicenseType}'. ` +
        `Xem console [autogpt-license] để biết menu items thật.`,
    };
  }

  console.log(`${LOG} clicking option '${newLicenseType}'`);
  await humanClick(option);
  await sleep(500);

  const confirmBtn = findConfirmButton();
  if (confirmBtn) {
    console.log(`${LOG} confirm dialog → "${(confirmBtn.textContent ?? "").trim()}"`);
    await humanClick(confirmBtn);
    await sleep(500);
  }
  await randomDelay(600, 1200);

  // 5) Clear filter để list về đầy đủ.
  await clearMemberFilter();

  console.log(`${LOG} DONE email=${email} → ${newLicenseType}`);
  return {
    ok: true,
    data: {
      email,
      new_license_type: newLicenseType,
      old_license_type: oldLicenseType,
    },
  };
}
