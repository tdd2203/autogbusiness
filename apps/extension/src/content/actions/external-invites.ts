/**
 * Toggle "Cho phép lời mời từ miền bên ngoài" trên /admin/identity.
 *
 * Workspace setting bảo mật: khi BẬT, mọi member trong workspace có thể mời
 * người ở bất kỳ domain nào (rất rủi ro nếu để ON lâu dài). Khi TẮT, chỉ mời
 * được người trong các domain đã verify.
 *
 * Use case: dashboard cần invite một email ngoài domain → tự bật ON ngay
 * trước khi invite, restore về trạng thái ban đầu (thường OFF) sau khi invite
 * xong, kể cả invite FAIL.
 *
 * Hàm chính: `withExternalInvitesEnabled(taskFn)`:
 *   1. Navigate /admin/identity, đọc state toggle hiện tại
 *   2. Nếu OFF → bật ON, đợi update xong
 *   3. Navigate về /admin/members
 *   4. Chạy taskFn() (vd invite)
 *   5. try/finally: nếu state ban đầu là OFF → navigate /admin/identity tắt lại
 *
 * Selectors heuristic (ChatGPT có thể đổi UI):
 *   - Toggle là `button[role="switch"]` hoặc `input[type="checkbox"]`
 *   - Label text gần đó chứa "Cho phép lời mời từ miền bên ngoài" / "external"
 *   - State đọc qua `aria-checked` hoặc `.checked`
 */

import { humanClick, sleep } from "../human";
import { EXTERNAL_INVITE_LABEL_PATTERNS } from "../i18n-ui";
import { dbLabelsFor, reportLabelMismatch } from "../../shared/ui-labels";

const IDENTITY_PATH = "/admin/identity";
const MEMBERS_PATH = "/admin/members";

/**
 * Tìm toggle "external invites" bằng heuristic:
 *   1. Tìm element chứa text label
 *   2. Walk up tới container chung
 *   3. Tìm button[role="switch"] hoặc input[type="checkbox"] trong container
 */
function findExternalInvitesToggle(): HTMLElement | null {
  const dbLabels = dbLabelsFor("toggle_external_invites", "/admin/identity").map((s) =>
    s.toLowerCase(),
  );
  const patterns =
    dbLabels.length > 0
      ? [...dbLabels, ...EXTERNAL_INVITE_LABEL_PATTERNS]
      : EXTERNAL_INVITE_LABEL_PATTERNS;
  // Strategy 1: tìm tất cả switches/checkboxes, check label gần đó
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button[role="switch"], input[type="checkbox"]',
    ),
  );

  for (const el of candidates) {
    // Walk up tới 5 level tìm text match
    let p: HTMLElement | null = el;
    for (let depth = 0; depth < 5 && p; depth++, p = p.parentElement) {
      const t = (p.textContent ?? "").toLowerCase();
      for (const pattern of patterns) {
        if (t.includes(pattern)) {
          console.log(
            `[autogpt-external-invites] toggle matched via "${pattern}" (depth ${depth})`,
          );
          return el;
        }
      }
    }
  }

  if (dbLabels.length > 0) {
    reportLabelMismatch("toggle_external_invites", dbLabels[0], "/admin/identity");
  }
  console.warn(
    "[autogpt-external-invites] không tìm thấy toggle — DOM ChatGPT có thể đã đổi. Patterns:",
    patterns,
  );
  return null;
}

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

/** Navigate SPA tới pathname, đợi predicate trả truthy (page mới render xong). */
async function navigateTo(
  pathname: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (location.pathname !== pathname) {
    console.log(`[autogpt-external-invites] điều hướng ${location.pathname} → ${pathname}`);
    history.pushState({}, "", pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(500);
  }
  return predicate();
}

/**
 * Set toggle về `target`. Trả về:
 *   - prev: state trước khi đổi (true|false), hoặc null nếu không tìm thấy toggle
 *   - changed: boolean — có thực sự click hay không
 */
async function setExternalInvites(
  target: boolean,
): Promise<{ prev: boolean | null; changed: boolean }> {
  const ok = await navigateTo(IDENTITY_PATH, () => !!findExternalInvitesToggle());
  if (!ok) {
    return { prev: null, changed: false };
  }
  const toggle = findExternalInvitesToggle();
  if (!toggle) return { prev: null, changed: false };

  const prev = getToggleState(toggle);
  if (prev === target) {
    console.log(
      `[autogpt-external-invites] toggle đã ở trạng thái mong muốn (${target}), skip`,
    );
    return { prev, changed: false };
  }

  console.log(
    `[autogpt-external-invites] click toggle: ${prev} → ${target}`,
  );
  await humanClick(toggle);
  // Đợi UI/backend update — ChatGPT có thể fire PATCH /api/... để lưu
  await sleep(800);

  // Verify
  const after = findExternalInvitesToggle();
  if (after) {
    const newState = getToggleState(after);
    if (newState !== target) {
      console.warn(
        `[autogpt-external-invites] toggle KHÔNG đổi như mong đợi (vẫn ${newState})`,
      );
    } else {
      console.log(`[autogpt-external-invites] OK, state = ${newState}`);
    }
  }

  return { prev, changed: true };
}

/**
 * Wrapper: tạm bật external invites → chạy taskFn → restore state cũ.
 *
 * GUARANTEE: nếu taskFn throw hoặc trả ok=false, vẫn restore state trong
 * finally để không để ChatGPT ở trạng thái "external invites = ON" sau khi
 * extension làm xong.
 *
 * Nếu không tìm thấy toggle (DOM đổi, prev=null) → skip toàn bộ wrap, chạy
 * taskFn trực tiếp (không phá invite flow).
 */
export async function withExternalInvitesEnabled<T>(
  taskFn: () => Promise<T>,
): Promise<T> {
  const setResult = await setExternalInvites(true);

  if (setResult.prev === null) {
    console.warn(
      "[autogpt-external-invites] không control được toggle — chạy invite mà KHÔNG bật external invites. Nếu email ngoài domain, invite có thể fail.",
    );
    // Navigate về members trước khi chạy taskFn
    await navigateTo(
      MEMBERS_PATH,
      () => location.pathname.includes(MEMBERS_PATH),
      5_000,
    );
    return await taskFn();
  }

  // Navigate về /admin/members để taskFn chạy invite
  await navigateTo(
    MEMBERS_PATH,
    () => location.pathname.includes(MEMBERS_PATH),
    5_000,
  );

  try {
    return await taskFn();
  } finally {
    // Restore state cũ (thường là OFF) — chạy KỂ CẢ khi taskFn throw.
    // Sau khi tắt xong, navigate về /admin/members để extension idle ở trang
    // quen thuộc (dashboard poll member list / extension status từ đây).
    if (setResult.changed && setResult.prev !== null) {
      console.log(
        `[autogpt-external-invites] restore toggle về ${setResult.prev}`,
      );
      try {
        await setExternalInvites(setResult.prev);
      } catch (e) {
        console.warn(
          "[autogpt-external-invites] restore FAILED — ChatGPT vẫn ở trạng thái external invites = ON. Tắt thủ công nếu cần.",
          e,
        );
      }
    }
    // Luôn navigate về /admin/members khi kết thúc invite (dù toggle có đổi
    // hay không, dù invite success/fail) — UX nhất quán cho user và để task
    // sau (SYNC_DATA, REMOVE_MEMBER, ...) khởi động ở đúng trang.
    try {
      await navigateTo(
        MEMBERS_PATH,
        () => location.pathname.includes(MEMBERS_PATH),
        5_000,
      );
    } catch (e) {
      console.warn(
        "[autogpt-external-invites] navigate về /admin/members fail",
        e,
      );
    }
  }
}
