import { humanClick, sleep, waitFor } from "../../human";

const PAGE_INDICATOR_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;

/** Hard cap — đủ cho workspace lớn, tránh loop vô hạn. */
export const MAX_PAGINATION_PAGES = 200;

export type PaginationState = {
  current: number;
  total: number;
  container: HTMLElement;
  prevButton: HTMLElement | null;
  nextButton: HTMLElement | null;
};

// ChatGPT đôi khi render nút mũi tên prev/next KHÔNG phải <button> mà là
// <div role="button"> hoặc <a>. Bắt cả 3 để bộ dò không trượt.
const CLICKABLE_SELECTOR = 'button, [role="button"], a[role]';

export function isDisabled(btn: HTMLElement): boolean {
  const button = btn as HTMLButtonElement;
  return (
    button.disabled === true ||
    btn.getAttribute("aria-disabled") === "true" ||
    btn.classList.contains("disabled")
  );
}

function findButtonsNearIndicator(indicatorEl: Node): {
  prev: HTMLElement | null;
  next: HTMLElement | null;
} {
  const start =
    indicatorEl instanceof Element
      ? indicatorEl
      : indicatorEl.parentElement;
  if (!start) return { prev: null, next: null };

  let container: HTMLElement | null = start.parentElement;
  for (let depth = 0; depth < 6 && container; depth++) {
    const buttons = Array.from(
      container.querySelectorAll<HTMLElement>(CLICKABLE_SELECTOR),
    ).filter((b) => b.offsetParent !== null || b.getClientRects().length > 0);

    if (buttons.length >= 2) {
      const byAria = pickByAriaLabel(buttons);
      // Bù vị trí cho nút mà aria-label không khớp pattern (vd next của
      // ChatGPT VI ghi "Trang tiếp theo", không chứa "next"/"sau"):
      // prev = nút đầu, next = nút cuối trong thanh.
      return {
        prev: byAria.prev ?? buttons[0],
        next: byAria.next ?? buttons[buttons.length - 1],
      };
    }
    container = container.parentElement;
  }
  return { prev: null, next: null };
}

function pickByAriaLabel(buttons: HTMLElement[]): {
  prev: HTMLElement | null;
  next: HTMLElement | null;
} {
  const prevPatterns = /previous|prev|trước|lùi|上一页|上一頁|前一页/i;
  const nextPatterns = /next|sau|tiếp|kế|下一页|下一頁|后一页/i;
  let prev: HTMLElement | null = null;
  let next: HTMLElement | null = null;
  for (const btn of buttons) {
    const label = `${btn.getAttribute("aria-label") ?? ""} ${btn.title ?? ""}`;
    if (!prev && prevPatterns.test(label)) prev = btn;
    if (!next && nextPatterns.test(label)) next = btn;
  }
  return { prev, next };
}

/** Dựng PaginationState từ một phần tử "neo" (chứa chỉ số trang) + giá trị N/M. */
function buildState(
  anchor: Element,
  current: number,
  total: number,
): PaginationState | null {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    total < 2 ||
    total > MAX_PAGINATION_PAGES ||
    current < 1 ||
    current > total
  ) {
    return null;
  }

  const { prev, next } = findButtonsNearIndicator(anchor);
  if (!prev && !next) return null;

  let container: HTMLElement | null = anchor.parentElement;
  for (let i = 0; i < 6 && container?.parentElement; i++) {
    if (container.querySelectorAll(CLICKABLE_SELECTOR).length >= 2) break;
    container = container.parentElement;
  }
  if (!container) return null;

  return { current, total, container, prevButton: prev, nextButton: next };
}

/**
 * Tìm thanh phân trang ChatGPT admin members (vd "‹ 1/2 ›").
 * Trả null nếu không có hoặc chỉ 1 trang.
 *
 * Hai pass:
 *  1) Text node đơn "N / M" (fast path, UI cũ).
 *  2) Phần tử nhỏ có textContent gộp = "N/M" — xử lý khi ChatGPT tách chỉ số
 *     thành nhiều node con (vd <span>1</span>/<span>2</span>) khiến pass 1 trượt.
 */
export function findPaginationState(): PaginationState | null {
  // Pass 1: từng text node.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    const match = PAGE_INDICATOR_RE.exec(text);
    if (!match || !node.parentElement) continue;
    const state = buildState(
      node.parentElement,
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
    );
    if (state) return state;
  }

  // Pass 2: phần tử nhỏ có textContent = "N/M" (chỉ số bị tách node con).
  // Giới hạn độ dài ≤ 12 + yêu cầu có ≥2 nút lân cận (trong buildState) để
  // tránh khớp nhầm các chuỗi "x/y" khác trên trang.
  const els = document.querySelectorAll<HTMLElement>("nav, div, span, p, li");
  for (const el of Array.from(els)) {
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 12) continue;
    const match = PAGE_INDICATOR_RE.exec(text);
    if (!match) continue;
    const state = buildState(
      el,
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
    );
    if (state) return state;
  }

  return null;
}

export function hasMorePages(state: PaginationState): boolean {
  if (state.current >= state.total) return false;
  if (!state.nextButton) return false;
  return !isDisabled(state.nextButton);
}

/** Về trang 1 trước khi scrape nhiều trang (kể cả đang ở trang N). */
export async function goToFirstPage(): Promise<void> {
  for (let guard = 0; guard < MAX_PAGINATION_PAGES; guard++) {
    const state = findPaginationState();
    if (!state || state.current <= 1) return;
    if (!state.prevButton || isDisabled(state.prevButton)) return;

    const from = state.current;
    await humanClick(state.prevButton);
    await sleep(400);
    try {
      await waitFor(
        () => {
          const s = findPaginationState();
          return s && s.current < from ? s : null;
        },
        6000,
        150,
      );
    } catch {
      return;
    }
  }
}

export async function clickNextPage(state: PaginationState): Promise<boolean> {
  if (!state.nextButton || isDisabled(state.nextButton)) return false;
  if (state.current >= state.total) return false;
  await humanClick(state.nextButton);
  return true;
}

/** Đợi indicator tăng so với `fromPage` (sau click next). */
export async function waitForPageAdvance(fromPage: number): Promise<boolean> {
  try {
    await waitFor(
      () => {
        const s = findPaginationState();
        return s && s.current > fromPage ? s : null;
      },
      8000,
      200,
    );
    return true;
  } catch {
    return false;
  }
}
