/**
 * Anti-detection helpers — simulate human input.
 *
 * Spec gốc: delay 1.5-4s giữa thao tác. User 2026-05-19 giảm 70% (→0.30) vì
 * extension chạy chậm; 2026-06-16 giảm thêm 40% (0.30→0.18). Tất cả
 * `randomDelay`, `microDelay`, và per-character typing đều scale qua hằng số
 * này — đổi 1 chỗ áp dụng toàn bộ.
 *
 * - KHÔNG dùng .click() trực tiếp, phải mousedown → mouseup → click
 * - Nhập liệu gõ từng ký tự (keypress events) — vẫn realistic nhưng nhanh hơn
 */

const DELAY_MULTIPLIER = 0.18;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(minMs = 1500, maxMs = 4000): Promise<void> {
  const min = Math.max(50, Math.floor(minMs * DELAY_MULTIPLIER));
  const max = Math.max(min + 50, Math.floor(maxMs * DELAY_MULTIPLIER));
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(delay);
}

export function microDelay(): Promise<void> {
  const base = Math.floor(60 * DELAY_MULTIPLIER);
  const span = Math.floor(80 * DELAY_MULTIPLIER);
  return sleep(base + Math.floor(Math.random() * span));
}

export async function humanClick(el: HTMLElement): Promise<void> {
  // QUAN TRỌNG: scroll element vào viewport TRƯỚC khi click. Khi danh sách
  // member dài, nút action có thể bị scroll out, gây click không trigger
  // được handler. scrollIntoView({ block: 'center' }) cho cả element + tránh
  // header sticky che mất. behavior: "instant" để click ngay không chờ animation.
  try {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  } catch {
    el.scrollIntoView();
  }
  await microDelay();

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    composed: true,
  };
  const pointerOpts = { ...opts, pointerType: "mouse", isPrimary: true };

  // ChatGPT 2026 dùng Radix UI — một số component (DialogTrigger, Select)
  // lắng nghe POINTER events thay vì mouse events. Dispatch cả 2 set.
  try {
    el.dispatchEvent(new PointerEvent("pointerover", pointerOpts));
    el.dispatchEvent(new PointerEvent("pointerenter", pointerOpts));
  } catch {
    // Older browser without PointerEvent constructor
  }
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mouseenter", opts));
  await microDelay();
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  } catch {}
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  await microDelay();
  try {
    el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  } catch {}
  el.dispatchEvent(new MouseEvent("mouseup", opts));

  // CLICK: chỉ dùng MỘT cơ chế để tránh double-fire.
  // Trước v0.6.1: dispatch synthetic 'click' + gọi el.click() → ChatGPT nhận
  // 2 click event cho mỗi humanClick → 2 toast (toggle external domain, invite
  // submit), 2 lần thực thi handler. Bug user-reported 2026-05-20.
  // Sau v0.6.1: chỉ gọi el.click() native — Radix UI / React onClick đều catch
  // được; các pointer/mouse down+up phía trên đã handle hover/active state.
  if (typeof el.click === "function") {
    try {
      el.click();
      return;
    } catch (e) {
      console.warn("[autogpt-human] el.click() throw, fallback synthetic:", e);
    }
  }
  // Fallback chỉ khi el.click không tồn tại / throw (rất hiếm)
  el.dispatchEvent(new MouseEvent("click", opts));
}

export async function humanType(input: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  input.focus();
  await microDelay();
  // Clear existing
  const nativeSetter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    "value",
  )?.set;

  nativeSetter?.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));

  const typeBase = Math.max(8, Math.floor(40 * DELAY_MULTIPLIER));
  const typeSpan = Math.max(12, Math.floor(80 * DELAY_MULTIPLIER));
  for (const ch of text) {
    nativeSetter?.call(input, input.value + ch);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    await sleep(typeBase + Math.floor(Math.random() * typeSpan));
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs = 10_000,
  pollMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(pollMs);
  }
  throw new Error(`Timeout sau ${timeoutMs}ms`);
}

/**
 * NHẬN BIẾT RENDER XONG (thay cho `sleep` cố định khi chờ SPA render).
 *
 * Chờ tới khi 1 giá trị đếm (vd số row đã render) > 0 và GIỮ NGUYÊN qua
 * `stablePolls` lần poll liên tiếp = nội dung đã render xong & ngừng thay đổi.
 *
 * - Máy nhanh: resolve ngay khi list ổn định (thường < 1s) → nhanh hơn sleep cố định.
 * - Máy chậm: chờ tới khi render kịp → an toàn hơn (không thao tác/scrape sớm).
 * - KHÔNG throw: hết `timeoutMs` thì trả về count cuối (fallback — không chặn
 *   flow; downstream vẫn re-scrape/scroll). List rỗng (luôn 0) → chờ hết timeout.
 */
export async function waitForCountStable(
  getCount: () => number,
  {
    timeoutMs = 6000,
    stablePolls = 2,
    pollMs = 300,
  }: { timeoutMs?: number; stablePolls?: number; pollMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableHits = 0;
  while (Date.now() < deadline) {
    const c = getCount();
    if (c > 0 && c === last) {
      stableHits += 1;
      if (stableHits >= stablePolls) return c;
    } else {
      stableHits = 0;
      last = c;
    }
    await sleep(pollMs);
  }
  return Math.max(last, 0);
}

export function querySelectorFirst<T extends Element = Element>(
  selectors: string[],
  root: ParentNode = document,
): T | null {
  for (const sel of selectors) {
    const el = root.querySelector<T>(sel);
    if (el) return el;
  }
  return null;
}

/** Chuẩn hóa text trước khi so khớp — bỏ dấu tiếng Việt, gom whitespace. */
export function normalizeMatchText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function queryByText(
  selector: string,
  text: string,
  root: ParentNode = document,
): HTMLElement | null {
  const needle = normalizeMatchText(text);
  const all = root.querySelectorAll<HTMLElement>(selector);
  for (const el of Array.from(all)) {
    const hay = normalizeMatchText(el.textContent ?? "");
    if (hay === needle || hay.includes(needle)) return el;
  }
  return null;
}

export function queryByAnyText(
  selector: string,
  texts: readonly string[],
  root: ParentNode = document,
): HTMLElement | null {
  for (const text of texts) {
    const el = queryByText(selector, text, root);
    if (el) return el;
  }
  return null;
}
