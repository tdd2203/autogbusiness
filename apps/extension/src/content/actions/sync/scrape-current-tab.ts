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

/**
 * MỌI lần đọc dòng trong file này đều phải đi qua đây.
 *
 * CA THẬT (auto-sync 25/8 → 3/9/2026, GPT1 + CHATGPT PRO): bấm sang tab "Lời
 * mời đang chờ" xong, React vẫn giữ nguyên bảng tab "Người dùng" trong DOM ở
 * dạng ẩn. `scrapeAllRows()` trần quét thẳng `document` nên đọc trúng cả bảng
 * ẩn đó, rồi `collectRowsByScrolling` gắn nhãn theo tab mà nó TƯỞNG đang đứng ⇒
 * 100 thành viên đang hoạt động của GPT1 bị ghi nhãn `pending` (workspace này
 * chỉ có 3 lời mời chờ thật), và bộ lật trang bám vào thanh phân trang 13 trang
 * của bảng ẩn nên mẻ quét cày hết trang này tới trang khác cho tới lúc hết giờ.
 * Bảy mẻ auto-sync hỏng `CONTENT_TIMEOUT`/`TIMEOUT` trong 14 ngày đều từ đây.
 *
 * Luồng mời đã bịt lỗ này từ 30/8 (`visibleOnly`), riêng bộ quét của SYNC thì
 * chưa — nên đưa hẳn vào một cửa duy nhất, khỏi lần sau lại quên một chỗ.
 */
function visibleRows(): ScrapedMember[] {
  return scrapeAllRows({ visibleOnly: true });
}

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
export function pageSignature(): string {
  return visibleRows()
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

/**
 * Tìm mọi khung cuộn khả dĩ (window + inner div overflow). PHẢI scan lại mỗi
 * vòng lặp: lúc "cold start" list mới render vài row → chưa tràn → div cuộn nội
 * bộ CHƯA lộ ra (scrollHeight ≈ clientHeight). Sau khi vài row đầu tải xong,
 * container mới xuất hiện → phải scan lại mới bắt được. Đây là gốc bug
 * "đồng bộ lần 1 chỉ ra 2 member": trước đây scan MỘT LẦN lúc mới vào (chỉ thấy
 * `window`), window.scrollTo không nhích list cuộn-nội-bộ → không tải thêm row.
 */
function findScrollContainers(): Array<HTMLElement | Window> {
  const containers: Array<HTMLElement | Window> = [window];
  document
    .querySelectorAll<HTMLElement>("div, main, section, ul, ol")
    .forEach((el) => {
      const style = window.getComputedStyle(el);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 20
      ) {
        containers.push(el);
      }
    });
  return containers;
}

/**
 * Scroll tới đáy, lặp lại tới khi số row không tăng nữa (xử lý virtualized list).
 * `expectedTotal` = tổng member header ChatGPT báo (nếu biết): còn thiếu so với
 * mốc này thì KIÊN NHẪN hơn (list chạy tab nền bị Chrome throttle, tải chậm) —
 * chỉ bỏ cuộc khi đã kẹt nhiều tick liên tiếp; đạt mốc thì dừng ngay.
 *
 * `isOverTime` là BẮT BUỘC: vòng này ngủ 300-500ms mỗi nhịp × 200 nhịp ~ 80s và
 * chạy lại cho TỪNG TRANG. Trước đây nó không hề soi đồng hồ nên ngân sách
 * `MAX_SYNC_MS` chỉ được kiểm ở ngoài, giữa các pass — một workspace 13 trang
 * mà list không render nổi thì tiêu 9 phút ở đây trong khi trần của background
 * là 330s (ca 25/8/2026: quét tab "Người dùng" 567s rồi trả về 0 dòng).
 */
async function scrollUntilAllLoaded(
  isOverTime: () => boolean,
  maxIterations = 200,
  expectedTotal: number | null = null,
): Promise<number> {
  let lastCount = 0;
  let stableTicks = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (isOverTime()) break;
    for (const c of findScrollContainers()) {
      if (c === window) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
      } else {
        (c as HTMLElement).scrollTop = (c as HTMLElement).scrollHeight;
      }
    }
    await sleep(300 + Math.floor(Math.random() * 200));

    const currentCount = visibleRows().length;
    if (expectedTotal && currentCount >= expectedTotal) return currentCount;

    if (currentCount > lastCount) {
      stableTicks = 0;
      lastCount = currentCount;
    } else {
      stableTicks += 1;
      // Chưa đủ mốc header → chờ lâu hơn (8 tick ~ 3.6s không tăng) trước khi bỏ;
      // đã đủ/không có mốc → 3 tick là đủ kết luận "hết row".
      const patience = expectedTotal && lastCount < expectedTotal ? 8 : 3;
      if (stableTicks >= patience) break;
    }
  }
  return lastCount;
}

/**
 * Trần cho phần QUÉT của một mẻ sync (mọi tab cộng lại), đo từ lúc `executeSync`
 * bắt đầu chứ không phải từ lúc quét tab đầu.
 *
 * BA TRẦN PHẢI LỒNG NHAU, trong nhỏ hơn ngoài — trước 3/9/2026 thì không:
 *   quét 240s + đọc suất ≤30s (`SEAT_READ_MAX_MS`) ≈ 270s
 *     < 330s (`CONTENT_TIMEOUTS.SYNC_DATA` của background)
 *       < 360s (ngưỡng treo của backend)
 *
 * Bản cũ để 300s và ĐO SAU cả nhịp chờ thanh tab render (tới 10s), rồi còn đọc
 * số suất (~28s) SAU khi đồng hồ đã chốt ⇒ tổng thực tế tới ~338s > 330s. Nên
 * ngay cả mẻ chậm hợp lệ cũng bị background chém trước, trả `CONTENT_TIMEOUT`
 * mơ hồ thay vì để content tự trả `TIMEOUT` kèm số dòng đã thu được.
 *
 * 240s vẫn rộng: 41 mẻ SYNC_DATA thành công trong 14 ngày có trung bình 50s,
 * p90 96s, dài nhất 148s (workspace 343 thành viên, 13 trang).
 */
export const MAX_SYNC_MS = 240_000;

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
  expectedTotal: number | null = null,
): Promise<boolean> {
  const tag = pageLabel ? `${label} ${pageLabel}` : label;
  if (isOverTime()) return true;

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(400);

  const totalAfterScroll = await scrollUntilAllLoaded(
    isOverTime,
    200,
    expectedTotal,
  );
  if (isOverTime()) return true;
  console.log(
    `[autogpt-sync] [${tag}] scroll xong: ~${totalAfterScroll} rows` +
      (expectedTotal ? ` (mốc header ${expectedTotal})` : ""),
  );

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(400);

  let stalledPasses = 0;
  for (let scrollPass = 0; scrollPass < 200; scrollPass++) {
    if (isOverTime()) return true;

    const before = collected.size;

    const visible = visibleRows();
    for (const m of visible) collected.set(m.email, { ...m, status });

    window.scrollBy({ top: window.innerHeight * 0.8, behavior: "auto" });
    await sleep(250 + Math.floor(Math.random() * 200));

    const after = visibleRows();
    for (const m of after) collected.set(m.email, { ...m, status });

    await reportProgress(taskId, {
      phase: "scraping",
      current: collected.size,
      message: `[${tag}] Đã thu ${collected.size} (pass ${scrollPass + 1})`,
    });

    stalledPasses = collected.size === before ? stalledPasses + 1 : 0;

    const atBottom =
      window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
    const reachedTarget = !expectedTotal || collected.size >= expectedTotal;
    // Dừng khi: tới đáy + vài pass liên tiếp không thêm row mới + (đã đủ mốc
    // header HOẶC đã kẹt quá lâu dù chưa đủ — escape tránh treo vô hạn khi mốc
    // header không bao giờ đạt được). Chưa tới đáy/chưa đủ mốc → cứ cuộn tiếp.
    if (
      atBottom &&
      stalledPasses >= 3 &&
      (reachedTarget || stalledPasses >= 12)
    ) {
      break;
    }

    // Chưa đủ mốc mà đã kẹt ở đáy → nhảy lên đầu để kích virtualized list
    // render lại từ trên xuống (bắt các row bị unmount khi cuộn nhanh).
    if (!reachedTarget && atBottom && stalledPasses > 0 && stalledPasses % 4 === 0) {
      window.scrollTo({ top: 0, behavior: "auto" });
      await sleep(400);
    }
  }

  return false;
}

export async function scrapeCurrentTab(
  taskId: string,
  status: "active" | "pending",
  label: string,
  isOverTime: () => boolean,
): Promise<{
  members: ScrapedMember[];
  timedOut: boolean;
  expectedTotal: number | null;
}> {
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
  const stableCount = await waitForCountStable(() => visibleRows().length, {
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
    await goToFirstPage(isOverTime);

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
    // List cuộn vô hạn (không phân trang): truyền mốc header để scroll KIÊN NHẪN
    // tới khi đủ, không dừng sớm ở vài row đầu (fix bug "lần 1 chỉ ra 2 member").
    timedOut = await collectRowsByScrolling(
      taskId,
      status,
      label,
      collected,
      isOverTime,
      undefined,
      expectedTotal,
    );
  }

  return { members: Array.from(collected.values()), timedOut, expectedTotal };
}
