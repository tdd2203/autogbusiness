import type { ScrapedMember } from "../../../shared/messages";
import { sleep } from "../../human";
import { reportProgress } from "../../progress";
import {
  clickNextPage,
  findPaginationState,
  goToFirstPage,
  hasMorePages,
  MAX_PAGINATION_PAGES,
  waitForPageAdvance,
} from "./pagination";
import { scrapeAllRows } from "./scrape-all-rows";

/** Scroll tới đáy, lặp lại tới khi số row không tăng nữa (xử lý virtualized list). */
async function scrollUntilAllLoaded(maxIterations = 200): Promise<number> {
  let lastCount = 0;
  let stableTicks = 0;

  // Tìm scrollable container — đôi khi list không scroll bằng window mà bằng inner div
  const scrollContainers: Array<HTMLElement | Window> = [window];
  document.querySelectorAll<HTMLElement>("div, main, section").forEach((el) => {
    const style = window.getComputedStyle(el);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight + 100
    ) {
      scrollContainers.push(el);
    }
  });

  for (let i = 0; i < maxIterations; i++) {
    for (const c of scrollContainers) {
      if (c === window) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
      } else {
        (c as HTMLElement).scrollTop = (c as HTMLElement).scrollHeight;
      }
    }
    await sleep(300 + Math.floor(Math.random() * 200));

    const currentCount = scrapeAllRows().length;
    if (currentCount === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 3) break; // 3 lần liên tiếp không tăng → đã hết
    } else {
      stableTicks = 0;
      lastCount = currentCount;
    }
  }
  return lastCount;
}

export const MAX_SYNC_MS = 5 * 60 * 1000; // 5 phút hard cap cho TOÀN BỘ sync (3 tabs)

/**
 * Scrape danh sách member của TAB hiện tại (đã click trước đó).
 * - Scroll xuống cho tới khi không có row mới
 * - Dedup theo email
 * - Gán `status` cho mỗi member
 */
async function collectRowsByScrolling(
  taskId: string,
  status: "active" | "pending",
  label: string,
  collected: Map<string, ScrapedMember>,
  isOverTime: () => boolean,
  pageLabel?: string,
): Promise<boolean> {
  const tag = pageLabel ? `${label} ${pageLabel}` : label;

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(400);

  const totalAfterScroll = await scrollUntilAllLoaded();
  console.log(`[autogpt-sync] [${tag}] scroll xong: ~${totalAfterScroll} rows`);

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(400);

  for (let scrollPass = 0; scrollPass < 200; scrollPass++) {
    if (isOverTime()) return true;

    const visible = scrapeAllRows();
    for (const m of visible) collected.set(m.email, { ...m, status });

    const before = collected.size;
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: "auto" });
    await sleep(250 + Math.floor(Math.random() * 200));

    const after = scrapeAllRows();
    for (const m of after) collected.set(m.email, { ...m, status });

    await reportProgress(taskId, {
      phase: "scraping",
      current: collected.size,
      message: `[${tag}] Đã thu ${collected.size} (pass ${scrollPass + 1})`,
    });

    if (collected.size === before && scrollPass > 3) {
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
      if (atBottom) break;
    }
  }

  return false;
}

export async function scrapeCurrentTab(
  taskId: string,
  status: "active" | "pending",
  label: string,
  isOverTime: () => boolean,
): Promise<{ members: ScrapedMember[]; timedOut: boolean }> {
  await reportProgress(
    taskId,
    { phase: "discover", message: `[${label}] Đang quét...` },
    true,
  );

  const collected = new Map<string, ScrapedMember>();
  let timedOut = false;

  const pagination = findPaginationState();
  if (pagination && pagination.total > 1) {
    console.log(
      `[autogpt-sync] [${label}] pagination ${pagination.current}/${pagination.total} — lật hết mọi trang`,
    );
    await goToFirstPage();

    const visitedPages = new Set<number>();
    for (let guard = 0; guard < MAX_PAGINATION_PAGES; guard++) {
      if (isOverTime()) {
        timedOut = true;
        break;
      }

      const state = findPaginationState();
      if (!state) {
        console.warn(`[autogpt-sync] [${label}] mất pagination indicator — dừng`);
        break;
      }

      if (visitedPages.has(state.current)) {
        console.warn(
          `[autogpt-sync] [${label}] trang ${state.current} đã scrape — tránh loop`,
        );
        break;
      }
      visitedPages.add(state.current);

      timedOut = await collectRowsByScrolling(
        taskId,
        status,
        label,
        collected,
        isOverTime,
        `trang ${state.current}/${state.total}`,
      );
      if (timedOut) break;

      const afterScrape = findPaginationState();
      if (!afterScrape || !hasMorePages(afterScrape)) {
        console.log(
          `[autogpt-sync] [${label}] hết trang (${afterScrape?.current ?? "?"}/${afterScrape?.total ?? "?"})`,
        );
        break;
      }

      const fromPage = afterScrape.current;
      const clicked = await clickNextPage(afterScrape);
      if (!clicked) {
        console.warn(
          `[autogpt-sync] [${label}] không lật được từ trang ${fromPage}`,
        );
        break;
      }

      const loaded = await waitForPageAdvance(fromPage);
      if (!loaded) {
        console.warn(
          `[autogpt-sync] [${label}] timeout chờ trang sau ${fromPage}`,
        );
        break;
      }
      await sleep(400);
    }
  } else {
    timedOut = await collectRowsByScrolling(
      taskId,
      status,
      label,
      collected,
      isOverTime,
    );
  }

  return { members: Array.from(collected.values()), timedOut };
}
