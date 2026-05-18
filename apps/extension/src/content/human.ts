/**
 * Anti-detection helpers — simulate human input.
 *
 * Spec yêu cầu:
 * - Delay random 1.5-4s giữa các thao tác (theo Invite_Member.md)
 * - KHÔNG dùng .click() trực tiếp, phải mousedown → mouseup → click
 * - Nhập liệu gõ từng ký tự (keypress events)
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(minMs = 1500, maxMs = 4000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(delay);
}

export function microDelay(): Promise<void> {
  return sleep(60 + Math.floor(Math.random() * 80));
}

export async function humanClick(el: HTMLElement): Promise<void> {
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
  };

  el.dispatchEvent(new MouseEvent("mouseover", opts));
  await microDelay();
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  await microDelay();
  el.dispatchEvent(new MouseEvent("mouseup", opts));
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

  for (const ch of text) {
    nativeSetter?.call(input, input.value + ch);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    await sleep(40 + Math.floor(Math.random() * 80));
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
