import type { ChatGPTRole } from "../../../shared/messages";
import { humanClick, querySelectorFirst, randomDelay } from "../../human";
import { findRoleOption } from "../../i18n-ui";
import { SELECTORS } from "../../selectors";

export async function setRole(role: ChatGPTRole): Promise<void> {
  // ChatGPT mặc định role = 'member' trong dialog Mời thành viên.
  // Nếu cần role = 'member' thì không cần click — vừa nhanh hơn vừa giảm
  // pattern bot (mỗi click thêm là một interaction có thể bị detect).
  if (role === "member") {
    console.log("[autogpt-invite] role='member' = default, không click role select");
    return;
  }
  const selectEl = querySelectorFirst<HTMLSelectElement>(
    SELECTORS.inviteRoleSelect,
  );
  if (!selectEl) {
    console.log("[autogpt-invite] role select not found — assume default 'member'");
    return;
  }
  if (selectEl.tagName === "SELECT") {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(selectEl, role);
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    console.log(`[autogpt-invite] role set to ${role} via native select`);
  } else {
    // Combobox custom (Radix UI) — click rồi tìm option theo text.
    console.log(`[autogpt-invite] role combobox detected, clicking to open...`);
    await humanClick(selectEl);
    await randomDelay(500, 1200);
    const opt = findRoleOption(role);
    if (opt) {
      await humanClick(opt);
      console.log(`[autogpt-invite] role option clicked: ${role}`);
    } else {
      console.warn(`[autogpt-invite] role option not found for ${role}, leaving default`);
    }
  }
}
