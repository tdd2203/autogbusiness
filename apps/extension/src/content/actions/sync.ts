import type {
  ChatGPTRole,
  ExecuteActionResponse,
  ScrapedMember,
} from "../../shared/messages";
import { humanClick, queryByText, querySelectorFirst, sleep } from "../human";
import { reportProgress } from "../progress";
import { getChatGPTUserInfo } from "../scrapers/user";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";

function parseRole(raw: string | null | undefined): ChatGPTRole | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (t.includes("owner")) return "owner";
  if (t.includes("admin")) return "admin";
  if (t.includes("member")) return "member";
  return null;
}

/**
 * DOM concatenate text từ nhiều element không có space giữa email và role.
 * Ví dụ: "abc@gmail.com" + "Thành viên" → textContent = "abc@gmail.comThành viên"
 * → regex greedy ăn cả "comTh" thành TLD sai.
 *
 * Fix: match email + tld-chunk, rồi check prefix thuộc TLD whitelist.
 */
const EMAIL_RE = /([a-z0-9._%+\-]+@[a-z0-9.\-]+\.)([a-zA-Z]+)/i;

const KNOWN_TLDS = new Set([
  "com", "net", "org", "info", "biz", "edu", "gov", "mil",
  "io", "co", "ai", "app", "dev", "xyz", "me", "tv", "us",
  "vn", "cn", "uk", "jp", "kr", "de", "fr", "ru", "eu", "asia",
  "in", "sg", "hk", "tw", "au", "ca", "br", "mx", "ph", "th", "id", "my",
  "name", "pro", "tech", "online", "store", "site", "blog", "shop",
]);

function extractEmail(text: string): string | null {
  const m = text.match(EMAIL_RE);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const tldChunk = m[2].toLowerCase();
  // Tìm prefix TLD dài nhất nằm trong whitelist
  for (let len = Math.min(tldChunk.length, 6); len >= 2; len--) {
    const tld = tldChunk.slice(0, len);
    if (KNOWN_TLDS.has(tld)) {
      return prefix + tld;
    }
  }
  return null;
}

/**
 * Tìm tab button theo text (Tailwind class chứ không phải role="tab" thực sự).
 * Match cả khi tab đang active (border-b) lẫn inactive (text-token-text-tertiary).
 */
function findTabButton(texts: string[]): HTMLElement | null {
  for (const text of texts) {
    const btn = queryByText("button", text);
    if (btn) return btn;
  }
  return null;
}

/**
 * Click tab + đợi DOM render. Trả true nếu tab tồn tại, false nếu không.
 *
 * Trang /admin/members có 3 tab:
 *   - Người dùng (active members)
 *   - Lời mời đang chờ xử lý (pending invites)
 *   - Yêu cầu đang chờ xử lý (pending requests)
 *
 * Tab buttons là plain <button> Tailwind, không có role="tab" / aria-selected.
 * → Detect "active" qua presence của border class hoặc text color, nhưng đơn giản
 *   nhất là cứ click rồi đợi.
 */
async function clickTabAndWait(
  tabTexts: string[],
  postClickWaitMs = 1500,
): Promise<boolean> {
  const btn = findTabButton(tabTexts);
  if (!btn) {
    console.warn(`[autogpt-sync] tab not found: ${tabTexts[0]}`);
    return false;
  }
  console.log(`[autogpt-sync] clicking tab: ${tabTexts[0]}`);
  await humanClick(btn);
  await sleep(postClickWaitMs);
  return true;
}

function scrapeAllRows(): ScrapedMember[] {
  const members: ScrapedMember[] = [];
  const seen = new Set<string>();

  // 1) Thử selectors có cấu trúc
  for (const sel of SELECTORS.memberRow) {
    const rows = document.querySelectorAll<HTMLElement>(sel);
    if (rows.length === 0) continue;
    for (const row of Array.from(rows)) {
      const emailEl = querySelectorFirst<HTMLElement>(
        SELECTORS.memberRowEmail,
        row,
      );
      const nameEl = querySelectorFirst<HTMLElement>(
        SELECTORS.memberRowName,
        row,
      );
      const roleEl = querySelectorFirst<HTMLElement>(
        SELECTORS.memberRowRole,
        row,
      );

      const emailText = (emailEl?.textContent ?? row.textContent ?? "").trim();
      const email = extractEmail(emailText);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      members.push({
        email,
        name: nameEl?.textContent?.trim() ?? null,
        chatgpt_role: parseRole(roleEl?.textContent ?? row.textContent ?? null),
        status: "active",
      });
    }
    if (members.length > 0) return members;
  }

  // 2) Fallback theo email regex — scan tất cả elements
  const allEls = document.querySelectorAll<HTMLElement>(
    "div, tr, li, [role='row'], [role='listitem']",
  );
  const emailToContainer = new Map<string, HTMLElement>();
  for (const el of Array.from(allEls)) {
    // bỏ qua nếu có descendant là chính element khác đã được chọn
    if (el.children.length === 0) continue;
    const text = el.textContent ?? "";
    const email = extractEmail(text);
    if (!email) continue;
    const existing = emailToContainer.get(email);
    // Chọn container nhỏ nhất (innermost) chứa email
    if (!existing || existing.contains(el)) {
      emailToContainer.set(email, el);
    }
  }
  for (const [email, container] of emailToContainer) {
    if (seen.has(email)) continue;
    seen.add(email);
    const text = container.textContent ?? "";
    members.push({
      email,
      name: null,
      chatgpt_role: parseRole(text),
      status: "active",
    });
  }

  return members;
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

const MAX_SYNC_MS = 5 * 60 * 1000; // 5 phút hard cap cho TOÀN BỘ sync (3 tabs)

/**
 * Scrape danh sách member của TAB hiện tại (đã click trước đó).
 * - Scroll xuống cho tới khi không có row mới
 * - Dedup theo email
 * - Gán `status` cho mỗi member
 */
async function scrapeCurrentTab(
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

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(400);

  const totalAfterScroll = await scrollUntilAllLoaded();
  console.log(`[autogpt-sync] [${label}] scroll xong: ~${totalAfterScroll} rows`);

  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(400);

  const collected = new Map<string, ScrapedMember>();
  let scrollPass = 0;
  let timedOut = false;

  for (scrollPass = 0; scrollPass < 200; scrollPass++) {
    if (isOverTime()) {
      timedOut = true;
      break;
    }

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
      message: `[${label}] Đã thu ${collected.size} (pass ${scrollPass + 1})`,
    });

    if (collected.size === before && scrollPass > 3) {
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
      if (atBottom) break;
    }
  }

  return { members: Array.from(collected.values()), timedOut };
}

export async function executeSync(taskId: string): Promise<ExecuteActionResponse> {
  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  const startedAt = Date.now();
  const isOverTime = () => Date.now() - startedAt > MAX_SYNC_MS;

  // Merged result — key theo email. Status từ tab cuối cùng scrape được sẽ
  // override. Thứ tự ưu tiên: active > pending. → Scrape active CUỐI CÙNG
  // để nếu cùng email xuất hiện ở "Lời mời" cũ và "Người dùng" mới thì
  // active thắng. Nhưng thường email pending không trùng với active.
  const merged = new Map<string, ScrapedMember>();

  // ----- Tab 1: Lời mời đang chờ xử lý (pending invites) -----
  if (await clickTabAndWait(TEXT_FALLBACKS.tabPendingInvites)) {
    const { members } = await scrapeCurrentTab(
      taskId,
      "pending",
      "Lời mời",
      isOverTime,
    );
    console.log(`[autogpt-sync] tab Lời mời: ${members.length} entries`);
    for (const m of members) merged.set(m.email, m);
  }

  // ----- Tab 2: Yêu cầu đang chờ xử lý (pending requests) -----
  if (await clickTabAndWait(TEXT_FALLBACKS.tabPendingRequests)) {
    const { members } = await scrapeCurrentTab(
      taskId,
      "pending",
      "Yêu cầu",
      isOverTime,
    );
    console.log(`[autogpt-sync] tab Yêu cầu: ${members.length} entries`);
    for (const m of members) merged.set(m.email, m);
  }

  // ----- Tab 3: Người dùng (active members) — scrape CUỐI để status active
  //         thắng nếu trùng email với 2 tab trên (race condition giữa các sync).
  let tab1Found = false;
  if (await clickTabAndWait(TEXT_FALLBACKS.tabActiveMembers)) {
    tab1Found = true;
    const { members } = await scrapeCurrentTab(
      taskId,
      "active",
      "Người dùng",
      isOverTime,
    );
    console.log(`[autogpt-sync] tab Người dùng: ${members.length} entries`);
    for (const m of members) merged.set(m.email, m);
  } else {
    // Tab buttons không có → có thể trang không phải /admin/members.
    // Fallback: scrape DOM hiện tại như tab "active".
    console.warn(
      "[autogpt-sync] không tìm được tab buttons — scrape DOM hiện tại như Người dùng",
    );
    const { members } = await scrapeCurrentTab(
      taskId,
      "active",
      "DOM hiện tại",
      isOverTime,
    );
    for (const m of members) merged.set(m.email, m);
  }

  const members = Array.from(merged.values());
  const elapsedMs = Date.now() - startedAt;
  const timedOut = isOverTime();

  await reportProgress(
    taskId,
    {
      phase: "uploading",
      current: members.length,
      total: members.length,
      message: `Hoàn tất scrape ${members.length} member (${members.filter((m) => m.status === "active").length} active + ${members.filter((m) => m.status === "pending").length} pending), đang upload...`,
    },
    true,
  );

  if (members.length === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        `Không tìm được row member nào (tab1=${tab1Found}, ${elapsedMs}ms). ` +
        `Kiểm tra selectors.memberRow hoặc URL hiện tại: ${location.pathname}`,
    };
  }

  if (timedOut) {
    return {
      ok: false,
      error_code: "TIMEOUT",
      error_message: `Sync vượt quá ${MAX_SYNC_MS}ms (đã thu được ${members.length} members, không chắc đủ).`,
    };
  }

  const userInfo = getChatGPTUserInfo();
  console.log(
    `[autogpt-sync] DONE: ${members.length} members (active+pending) in ${elapsedMs}ms, user=${userInfo.email}`,
  );
  return {
    ok: true,
    data: {
      members,
      user_info: userInfo,
      elapsed_ms: elapsedMs,
    },
  };
}
