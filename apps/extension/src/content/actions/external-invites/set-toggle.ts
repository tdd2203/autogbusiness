import { humanClick, sleep } from "../../human";
import { findExternalInvitesToggle } from "./finders/find-toggle";
import { navigateTo } from "./navigate";

const IDENTITY_PATH = "/admin/identity";

function getToggleState(el: HTMLElement): boolean {
  if (el.tagName === "INPUT") {
    return (el as HTMLInputElement).checked;
  }
  // button[role="switch"]: aria-checked="true" | "false"
  const aria = el.getAttribute("aria-checked");
  if (aria === "true") return true;
  if (aria === "false") return false;
  // Fallback: data-state="checked" (Radix UI)
  const ds = el.getAttribute("data-state");
  if (ds === "checked") return true;
  if (ds === "unchecked") return false;
  console.warn(
    "[autogpt-external-invites] không xác định được state, fallback false",
  );
  return false;
}

/**
 * Set toggle về `target`. Trả về:
 *   - prev: state trước khi đổi (true|false), hoặc null nếu không tìm thấy toggle
 *   - changed: boolean — có thực sự click hay không
 *   - confirmed: boolean — trạng thái CUỐI đã được xác nhận = `target`. Caller
 *     dùng cờ này để quyết định có an toàn invite hay không (vd email ngoài
 *     domain BẮT BUỘC confirmed=true mới được mời).
 */
export async function setExternalInvites(
  target: boolean,
): Promise<{ prev: boolean | null; changed: boolean; confirmed: boolean }> {
  const ok = await navigateTo(IDENTITY_PATH, () => !!findExternalInvitesToggle());
  if (!ok) {
    return { prev: null, changed: false, confirmed: false };
  }
  const toggle = findExternalInvitesToggle();
  if (!toggle) return { prev: null, changed: false, confirmed: false };

  const prev = getToggleState(toggle);
  if (prev === target) {
    console.log(
      `[autogpt-external-invites] toggle đã ở trạng thái mong muốn (${target}), skip`,
    );
    return { prev, changed: false, confirmed: true };
  }

  console.log(
    `[autogpt-external-invites] click toggle: ${prev} → ${target}`,
  );
  await humanClick(toggle);
  // Đợi UI/backend update — ChatGPT có thể fire PATCH /api/... để lưu
  await sleep(800);

  // Verify trạng thái cuối thực sự khớp target chưa.
  let confirmed = false;
  const after = findExternalInvitesToggle();
  if (after) {
    const newState = getToggleState(after);
    confirmed = newState === target;
    if (!confirmed) {
      console.warn(
        `[autogpt-external-invites] toggle KHÔNG đổi như mong đợi (vẫn ${newState})`,
      );
    } else {
      console.log(`[autogpt-external-invites] OK, state = ${newState}`);
    }
  }

  return { prev, changed: true, confirmed };
}
