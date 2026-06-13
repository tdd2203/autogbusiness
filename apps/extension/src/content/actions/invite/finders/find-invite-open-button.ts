import { dbLabelsFor } from "../../../../shared/ui-labels";
import { SELECTORS, TEXT_FALLBACKS } from "../../../selectors";

/**
 * Filter: loại trừ button là switch/toggle/tab/menu — chỉ giữ button "action"
 * thực sự (vd "Mời thành viên"). Toggle có role="switch", tab có role="tab",
 * menu item có role="menuitem", v.v.
 */
function isToggleOrSwitchOrTab(el: HTMLElement): boolean {
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  if (role === "switch" || role === "tab" || role === "menuitem" || role === "menuitemcheckbox") {
    return true;
  }
  // Radix UI Switch dùng data-state checked/unchecked
  const ds = el.getAttribute("data-state");
  if (ds === "checked" || ds === "unchecked") return true;
  return false;
}

export function findInviteOpenButton(): HTMLElement | null {
  // Chỉ scan trong main content / không scan sidebar (sidebar links có thể
  // match aria-label / text). Ưu tiên main[role="main"] hoặc <main>.
  const root = document.querySelector('main, [role="main"]') ?? document;

  // Try CSS selectors first
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(SELECTORS.inviteButtonOpen.join(", ")),
  );
  for (const el of candidates) {
    if (isToggleOrSwitchOrTab(el)) continue;
    console.log("[autogpt-invite] open button matched via CSS selector");
    return el;
  }

  // Fallback text search — queryByAnyText("button", texts) + filter
  const dbLabels = dbLabelsFor("invite_button_open", "/admin/members");
  const merged =
    dbLabels.length > 0
      ? [...dbLabels, ...TEXT_FALLBACKS.inviteButtonOpen]
      : TEXT_FALLBACKS.inviteButtonOpen;
  for (const text of merged) {
    const buttons = Array.from(root.querySelectorAll<HTMLElement>("button"));
    for (const btn of buttons) {
      if (isToggleOrSwitchOrTab(btn)) continue;
      const btnText = (btn.textContent ?? "").trim();
      if (btnText.includes(text)) {
        console.log(
          `[autogpt-invite] open button matched via text "${text}" → btn text="${btnText.slice(0, 60)}"`,
        );
        return btn;
      }
    }
  }
  return null;
}
