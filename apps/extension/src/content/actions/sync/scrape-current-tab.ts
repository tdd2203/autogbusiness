import type { ScrapedMember } from "../../../shared/messages";
import { humanClick, sleep, waitFor, waitForCountStable } from "../../human";
import { reportProgress } from "../../progress";
import {
  findPaginationState,
  goToFirstPage,
  isDisabled,
  MAX_PAGINATION_PAGES,
} from "./pagination";
import { scrapeAllRows } from "./scrape-all-rows";

// Tổng số member hiển thị ở header, vd "Business · 49 thành viên".
const MEMBER_COUNT_RE =
  /([\d.,]+)\s*(thành viên|members?|miembros|membres|成员|會員|회원)/i;

/** Đọc tổng số member từ header workspace. null nếu không thấy. */
function readHeaderMemberCount(): number | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const match = MEMBER_COUNT_RE.exec((node.nodeValue ?? "").trim());
    if (!match) continue;
    const n = Number.parseInt(match[1].replace(/[.,]/g, ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Chữ ký trang hiện tại = email vài row đầu — để phát hiện trang đã đổi. */
function pageSignature(): string {
  return scrapeAllRows()
    .map((m) => m.email)
    .slice(0, 5)
    .join("|");
}

/** Đợi NỘI DUNG trang đổi so với chữ ký trước (sau khi bấm next). */
async function waitForContentChange(prevSig: string): Promise<boolean> {
  try {
    await waitFor(
      () => {
        const sig = pageSignature();
        return sig && sig !== prevSig ? sig : null;
      },
      8000,
      200,
    );
    return true;
  } catch {
    return false;
  }
}

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

  // Render-aware gate: chờ list member render & ỔN ĐỊNH trước khi scrape lần đầu
  // (thay cho việc tin vào sleep cố định ở click-tab-and-wait). Resolve ngay khi
  // số row ngừng tăng; tối đa 6s fallback. List rỗng → chờ hết 6s rồi đi tiếp.
  // Downstream (scroll/pagination) vẫn re-scrape nên đây chỉ là cổng "đừng scrape
  // lúc DOM chưa paint".
  const stableCount = await waitForCountStable(() => scrapeAllRows().length, {
    timeoutMs: 6000,
    stablePolls: 2,
    pollMs: 300,
  });
  console.log(
    `[autogpt-sync] [${label}] list render ổn định ở ~${stableCount} rows trước khi scrape`,
  );

  const collected = new Map<string, ScrapedMember>();
  let timedOut = false;

  // Tổng kỳ vọng đọc từ header (mốc dừng) — chỉ có ý nghĩa với tab active.
  const expectedTotal = status === "active" ? readHeaderMemberCount() : null;
  if (expectedTotal) {
    console.log(`[autogpt-sync] [${label}] header tổng = ${expectedTotal} member`);
  }

  const pagination = findPaginationState();
  if (pagination && pagination.total > 1) {
    console.log(
      `[autogpt-sync] [${label}] pagination ${pagination.current}/${pagination.total} — lật hết mọi trang (mốc ${expectedTotal ?? "?"})`,
    );
    await goToFirstPage();

    for (let guard = 0; guard < MAX_PAGINATION_PAGES; guard++) {
      if (isOverTime()) {
        timedOut = true;
        break;
      }

      const before = collected.size;
      timedOut = await collectRowsByScrolling(
        taskId,
        status,
        label,
        collected,
        isOverTime,
        `trang ${guard + 1}`,
      );
      if (timedOut) break;
      console.log(
        `[autogpt-sync] [${label}] sau trang ${guard + 1}: ${collected.size} member (mốc ${expectedTotal ?? "?"})`,
      );

      // Đủ tổng kỳ vọng → dừng.
      if (expectedTotal && collected.size >= expectedTotal) {
        console.log(
          `[autogpt-sync] [${label}] đã đủ ${collected.size}/${expectedTotal} — dừng`,
        );
        break;
      }

      // Tìm nút next; hết nút hoặc disabled → hết trang.
      const nextBtn = findPaginationState()?.nextButton ?? null;
      if (!nextBtn || isDisabled(nextBtn)) {
        console.log(`[autogpt-sync] [${label}] không còn nút next — hết trang`);
        break;
      }

      // Bấm next rồi đợi NỘI DUNG trang đổi (không lệ thuộc chỉ số "1/2").
      const sigBefore = pageSignature();
      await humanClick(nextBtn);
      const changed = await waitForContentChange(sigBefore);
      if (!changed) {
        console.warn(
          `[autogpt-sync] [${label}] bấm next nhưng trang không đổi — dừng`,
        );
        break;
      }

      // An toàn: trang mới không thêm member nào (không phải trang đầu) → dừng.
      if (collected.size === before && guard > 0) {
        console.warn(
          `[autogpt-sync] [${label}] trang mới không có member mới — dừng`,
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
