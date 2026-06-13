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

function isDisabled(btn: HTMLElement): boolean {
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
      container.querySelectorAll<HTMLElement>("button"),
    ).filter((b) => b.offsetParent !== null || b.getClientRects().length > 0);

    if (buttons.length >= 2) {
      const byAria = pickByAriaLabel(buttons);
      if (byAria.prev || byAria.next) return byAria;
      return { prev: buttons[0], next: buttons[buttons.length - 1] };
    }
    container = container.parentElement;
  }
  return { prev: null, next: null };
}

function pickByAriaLabel(buttons: HTMLElement[]): {
  prev: HTMLElement | null;
  next: HTMLElement | null;
} {
  const prevPatterns = /previous|prev|trước|上一页|上一頁|前一页/i;
  const nextPatterns = /next|sau|下一页|下一頁|后一页/i;
  let prev: HTMLElement | null = null;
  let next: HTMLElement | null = null;
  for (const btn of buttons) {
    const label = `${btn.getAttribute("aria-label") ?? ""} ${btn.title ?? ""}`;
    if (!prev && prevPatterns.test(label)) prev = btn;
    if (!next && nextPatterns.test(label)) next = btn;
  }
  return { prev, next };
}

/**
 * Tìm thanh phân trang ChatGPT admin members (vd "1 / 2" + nút mũi tên).
 * Trả null nếu không có hoặc chỉ 1 trang.
 */
export function findPaginationState(): PaginationState | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    const match = PAGE_INDICATOR_RE.exec(text);
    if (!match) continue;

    const current = Number.parseInt(match[1], 10);
    const total = Number.parseInt(match[2], 10);
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(total) ||
      total < 2 ||
      total > MAX_PAGINATION_PAGES ||
      current < 1 ||
      current > total
    ) {
      continue;
    }

    const { prev, next } = findButtonsNearIndicator(node);
    if (!prev && !next) continue;

    let container: HTMLElement | null = node.parentElement;
    for (let i = 0; i < 6 && container?.parentElement; i++) {
      const btnCount = container.querySelectorAll("button").length;
      if (btnCount >= 2) break;
      container = container.parentElement;
    }
    if (!container) continue;

    return {
      current,
      total,
      container,
      prevButton: prev,
      nextButton: next,
    };
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
