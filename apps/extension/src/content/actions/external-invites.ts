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
import {
  EXTERNAL_INVITE_EXCLUDE_PATTERNS,
  EXTERNAL_INVITE_LABEL_PATTERNS,
} from "../i18n-ui";
import { dbLabelsFor, reportLabelMismatch } from "../../shared/ui-labels";

const IDENTITY_PATH = "/admin/identity";
const MEMBERS_PATH = "/admin/members";
const SWITCH_SEL = 'button[role="switch"], input[type="checkbox"]';

/**
 * Trả về ancestor LỚN NHẤT của `el` mà vẫn chỉ chứa đúng 1 switch — tức là
 * "row" bao quanh đúng 1 toggle. Dùng để scope text match cho 1 toggle duy
 * nhất, tránh nuốt nhầm label của toggle khác trên cùng trang.
 *
 * Trả về CHÍNH `el` nếu parent đã có nhiều switch — đảm bảo luôn có 1 element
 * để check label (dù chỉ là text của bản thân switch / sibling gần).
 */
function findSingleSwitchRow(el: HTMLElement): HTMLElement {
  let p: HTMLElement | null = el.parentElement;
  let row: HTMLElement | null = null;
  for (let depth = 0; depth < 8 && p; depth++, p = p.parentElement) {
    const switchCount = p.querySelectorAll(SWITCH_SEL).length;
    if (switchCount === 1) {
      row = p;
    } else if (switchCount > 1) {
      break;
    }
  }
  return row ?? el;
}

/**
 * Lấy tất cả "label text" có thể gắn với 1 switch, theo độ đặc trưng giảm dần:
 *   1. aria-labelledby → text của element được tham chiếu (chính xác nhất)
 *   2. aria-label trên chính switch
 *   3. <label for="{switch.id}">
 *   4. closest <label> ancestor
 *   5. text của previous sibling (label thường đứng trước switch)
 *   6. text của single-switch row (fallback rộng nhất, có thể nuốt nhầm)
 *
 * Concat tất cả → lowercase → dùng cho includes() check pattern + exclude.
 */
function extractSwitchLabel(el: HTMLElement): string {
  const parts: string[] = [];
  const seen = new Set<HTMLElement>();
  const addText = (node: HTMLElement | null) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const t = (node.textContent ?? "").trim();
    if (t) parts.push(t);
  };

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const lbl = document.getElementById(id);
      if (lbl) addText(lbl);
    }
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) parts.push(ariaLabel);
  if (el.id) {
    const lblFor = document.querySelector<HTMLElement>(
      `label[for="${CSS.escape(el.id)}"]`,
    );
    addText(lblFor);
  }
  addText(el.closest("label"));
  // Previous siblings (limit 3 — đủ cho structure <h3>label</h3><p>desc</p><switch/>)
  let prev = el.previousElementSibling as HTMLElement | null;
  for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling as HTMLElement | null) {
    addText(prev);
  }
  addText(findSingleSwitchRow(el));

  return parts.join(" | ").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Tìm toggle "Allow External Domain Invites" bằng multi-strategy:
 *   1. Lấy tất cả switch/checkbox trên trang
 *   2. Với mỗi switch, extract label text từ aria-labelledby / aria-label /
 *      label[for] / closest label / prev siblings / single-switch row
 *   3. Loại các switch có label chứa EXCLUDE pattern (vd "Automatic Account Creation")
 *   4. Cho điểm = length của longest matching pattern → chọn switch điểm cao nhất
 *
 * Log diagnostic chi tiết để user debug khi DOM ChatGPT đổi.
 */
function findExternalInvitesToggle(): HTMLElement | null {
  const dbLabels = dbLabelsFor("toggle_external_invites", "/admin/identity").map(
    (s) => s.toLowerCase(),
  );
  const patterns =
    dbLabels.length > 0
      ? [...dbLabels, ...EXTERNAL_INVITE_LABEL_PATTERNS]
      : EXTERNAL_INVITE_LABEL_PATTERNS;

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(SWITCH_SEL),
  );

  console.log(
    `[autogpt-external-invites] scan ${candidates.length} switch(es) on ${location.pathname}`,
  );

  let bestEl: HTMLElement | null = null;
  let bestScore = 0;
  let bestPattern = "";
  const diagnostic: Array<{ idx: number; label: string; matched: string | null; excluded: string | null }> = [];

  candidates.forEach((el, idx) => {
    const label = extractSwitchLabel(el);
    const excluded =
      EXTERNAL_INVITE_EXCLUDE_PATTERNS.find((p) => label.includes(p)) ?? null;
    if (excluded) {
      diagnostic.push({ idx, label: label.slice(0, 100), matched: null, excluded });
      return;
    }
    let longest = 0;
    let matchedPat: string | null = null;
    for (const p of patterns) {
      if (label.includes(p) && p.length > longest) {
        longest = p.length;
        matchedPat = p;
      }
    }
    diagnostic.push({ idx, label: label.slice(0, 100), matched: matchedPat, excluded: null });
    if (longest > bestScore) {
      bestScore = longest;
      bestEl = el;
      bestPattern = matchedPat ?? "";
    }
  });

  console.table(diagnostic);

  if (bestEl) {
    console.log(
      `[autogpt-external-invites] toggle matched via "${bestPattern}" (score=${bestScore})`,
    );
    return bestEl;
  }

  if (dbLabels.length > 0) {
    reportLabelMismatch("toggle_external_invites", dbLabels[0], "/admin/identity");
  }
  console.warn(
    "[autogpt-external-invites] không tìm thấy toggle — DOM ChatGPT có thể đã đổi. Patterns kỳ vọng:",
    patterns,
    "Exclude patterns:",
    EXTERNAL_INVITE_EXCLUDE_PATTERNS,
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

/**
 * Navigate SPA tới pathname, đợi predicate trả truthy (page mới render xong).
 *
 * Ưu tiên click `<a href="{pathname}">` trong sidebar — Next.js router sẽ bắt
 * sự kiện click và navigate đúng cách (history.pushState alone nhiều khi không
 * trigger re-render). Fallback pushState + popstate nếu không tìm thấy anchor.
 */
function findNavLinkByPath(pathname: string): HTMLAnchorElement | null {
  const all = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  // Khớp href tuyệt đối hoặc tương đối kết thúc bằng pathname (chấp nhận cả /xyz/ trailing)
  for (const a of all) {
    const href = a.getAttribute("href") ?? "";
    if (
      href === pathname ||
      href === pathname + "/" ||
      a.pathname === pathname ||
      a.pathname === pathname + "/"
    ) {
      return a;
    }
  }
  return null;
}

async function navigateTo(
  pathname: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (location.pathname !== pathname) {
    const link = findNavLinkByPath(pathname);
    if (link) {
      console.log(
        `[autogpt-external-invites] click <a href="${link.getAttribute("href")}"> ${location.pathname} → ${pathname}`,
      );
      link.click();
    } else {
      console.log(
        `[autogpt-external-invites] không tìm thấy sidebar link, pushState fallback ${location.pathname} → ${pathname}`,
      );
      history.pushState({}, "", pathname);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(500);
  }
  if (location.pathname !== pathname) {
    console.warn(
      `[autogpt-external-invites] nav timeout: vẫn ở ${location.pathname}, target ${pathname}`,
    );
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

  // Navigate về /admin/members để taskFn chạy invite. Đợi predicate:
  //   - URL đổi sang /admin/members
  //   - VÀ có ít nhất 1 element h1/main render (page content visible)
  // Tăng timeout lên 10s vì SPA cần thời gian render content sau khi đổi route
  // từ /admin/identity. Trước đây chỉ chờ URL → invite gọi findInviteOpenButton
  // ngay khi DOM chưa render → UI_ELEMENT_NOT_FOUND.
  await navigateTo(
    MEMBERS_PATH,
    () => {
      if (!location.pathname.includes(MEMBERS_PATH)) return false;
      // Page rendered khi có main content + ít nhất 1 button-like control
      const main = document.querySelector("main, [role='main']");
      const hasButtons = document.querySelectorAll("button").length > 2;
      return !!main && hasButtons;
    },
    10_000,
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
