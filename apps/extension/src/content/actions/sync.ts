import type {
  ExecuteActionResponse,
  ScrapedMember,
} from "../../shared/messages";
import { humanClick, sleep } from "../human";
import {
  checkLocaleMatch,
  detectChatGPTLocale,
  findControlByKey,
  parseChatGPTRole,
  type ChatGPTLocale,
} from "../i18n-ui";
import { reportProgress } from "../progress";
import { getChatGPTUserInfo } from "../scrapers/user";
import { SELECTORS, TEXT_FALLBACKS } from "../selectors";

function findTabButton(
  controlKey: string,
  texts: readonly string[],
): HTMLElement | null {
  return findControlByKey(controlKey, texts, { page: "/admin/members" });
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
  controlKey: string,
  tabTexts: readonly string[],
  postClickWaitMs = 1500,
): Promise<boolean> {
  const btn = findTabButton(controlKey, tabTexts);
  if (!btn) {
    console.warn(`[autogpt-sync] tab not found: ${tabTexts[0]}`);
    return false;
  }
  console.log(`[autogpt-sync] clicking tab: ${tabTexts[0]}`);
  await humanClick(btn);
  await sleep(postClickWaitMs);
  return true;
}

/**
 * Email FULL match regex — toàn bộ string phải là email. Dùng cho text node
 * đứng riêng (best case: ChatGPT render email vào <span> riêng).
 */
const EMAIL_FULL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

/**
 * Email EXTRACT regex — substring match. Dùng fallback khi ChatGPT render
 * email cùng text node với tên/avatar (vd "B b yaakovajax0054@outlook.com").
 * Phải tránh false-match từ "x@y.x" trong URLs hay attribute name.
 *
 * Chỉ extract khi:
 *   - Có đúng 1 match trong text (để không nuốt nhiều email vào 1 row)
 *   - text.length < 200 (tránh nuốt cả paragraph)
 */
const EMAIL_EXTRACT_RE_G = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

function extractSingleEmail(text: string): string | null {
  if (text.length > 200) return null;
  const matches = text.match(EMAIL_EXTRACT_RE_G);
  if (!matches || matches.length !== 1) return null;
  return matches[0].toLowerCase();
}

/**
 * Date keyword match — đa ngôn ngữ:
 *   vi: "17 thg 5, 2026" / "17 tháng 5, 2026"
 *   zh: "2026年5月17日"
 *   en: "May 17, 2026"
 */
const DATE_RE =
  /^(?:\d{1,2}\s+(?:thg|tháng)\s+\d{1,2},\s+\d{4}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+\d{1,2},?\s+\d{4})$/i;

/**
 * Tìm trong root 1 TEXT NODE có nodeValue chính xác là email format.
 *
 * Vì sao text node (không phải element)? ChatGPT đôi khi render email như TEXT
 * NODE TRỰC TIẾP của element cha — bên cạnh <span>D</span> avatar. Nếu chỉ check
 * `el.children.length === 0`, parent có cả span và text node sẽ bị skip (children
 * count = 1), còn fallback regex sẽ thấy textContent = "Ddhealth.220@gmail.com"
 * và match toàn bộ → email sai.
 *
 * TreeWalker SHOW_TEXT đi qua text nodes trực tiếp, mỗi node là 1 string độc lập
 * → email luôn tách khỏi avatar text.
 */
function findEmailTextNode(
  root: Node,
): { email: string; parent: HTMLElement } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (!text || text.length > 100) continue;
    if (!EMAIL_FULL_RE.test(text)) continue;
    const parent = (node.parentElement ?? root) as HTMLElement;
    return { email: text.toLowerCase(), parent };
  }
  return null;
}

/**
 * Tìm "Ngày thêm" — walk text nodes trong row tìm format "DD thg M, YYYY".
 * Trả ISO date string hoặc null.
 */
function findJoinedAtInRow(row: HTMLElement): string | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (!DATE_RE.test(text)) continue;
    const iso = parseDateMulti(text);
    if (iso) return iso;
  }
  return null;
}

const EN_MONTHS_SYNC: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function parseDateMulti(text: string): string | null {
  // VI: "17 thg 5, 2026"
  let m = text.match(/^(\d{1,2})\s+(?:thg|tháng)\s+(\d{1,2}),\s+(\d{4})$/i);
  if (m) return buildIso(+m[3], +m[2], +m[1]);
  // ZH: "2026年5月17日"
  m = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
  if (m) return buildIso(+m[1], +m[2], +m[3]);
  // EN: "May 17, 2026"
  m = text.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2}),?\s+(\d{4})$/i,
  );
  if (m) {
    const month = EN_MONTHS_SYNC[m[1].toLowerCase()];
    if (month) return buildIso(+m[3], month, +m[2]);
  }
  return null;
}

function buildIso(year: number, month: number, day: number): string | null {
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Tìm name — walk text nodes trong row, loại trừ email/date/role/license/avatar
 * initial. Trả về first qualifying text node trimmed.
 */
function findNameInRow(row: HTMLElement, email: string): string | null {
  const emailPrefix = email.split("@")[0] ?? "";
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (!text || text.length > 80) continue;
    if (EMAIL_FULL_RE.test(text)) continue;
    if (DATE_RE.test(text)) continue;
    if (parseChatGPTRole(text)) continue;
    const lower = text.toLowerCase();
    if (lower === "chatgpt") continue;
    // Avatar initial thường ≤ 3 ký tự (vd "D", "hai", "HP")
    if (text.length < 2) continue;
    // Skip nếu trùng email prefix (vd "dhealth.220" duplicate text)
    if (lower === emailPrefix.toLowerCase()) continue;
    return text;
  }
  return null;
}

function scrapeAllRows(): ScrapedMember[] {
  const members: ScrapedMember[] = [];
  const seen = new Set<string>();
  let textNodesScanned = 0;
  let fullMatchHits = 0;
  let extractMatchHits = 0;

  // 1) Thử selectors có cấu trúc (data-testid v.v.) — hiện ChatGPT KHÔNG có,
  // sẽ fall qua bước 2. Giữ làm fallback nếu có Future ChatGPT release.
  for (const sel of SELECTORS.memberRow) {
    const rows = document.querySelectorAll<HTMLElement>(sel);
    if (rows.length === 0) continue;
    for (const row of Array.from(rows)) {
      const found = findEmailTextNode(row);
      if (!found || seen.has(found.email)) continue;
      seen.add(found.email);
      members.push({
        email: found.email,
        name: findNameInRow(row, found.email),
        chatgpt_role: parseChatGPTRole(row.textContent ?? null),
        status: "active",
        joined_at: findJoinedAtInRow(row),
      });
    }
    if (members.length > 0) {
      console.log(
        `[autogpt-sync] scrapeAllRows: ${members.length} rows via selector "${sel}"`,
      );
      return members;
    }
  }

  // 2) Fallback: TreeWalker SHOW_TEXT toàn DOM. Hai chiến lược song song:
  //    a) EMAIL_FULL_RE — text node CHỈ chứa email (best case, chính xác).
  //    b) EMAIL_EXTRACT_RE_G — text node chứa email cùng tên/avatar
  //       (vd "B b yaakovajax0054@outlook.com" — UI ChatGPT 2026 đôi khi
  //       concat avatar initial + name + email vào 1 text node).
  //
  // Chiến lược (a) ưu tiên — nếu cùng email match cả 2, dedupe qua `seen`.
  const allCandidates: Array<{ email: string; node: Node }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodesScanned += 1;
    const text = (node.nodeValue ?? "").trim();
    if (!text) continue;
    if (text.length <= 100 && EMAIL_FULL_RE.test(text)) {
      fullMatchHits += 1;
      allCandidates.push({ email: text.toLowerCase(), node });
      continue;
    }
    const extracted = extractSingleEmail(text);
    if (extracted) {
      extractMatchHits += 1;
      allCandidates.push({ email: extracted, node });
    }
  }

  for (const { email, node: textNode } of allCandidates) {
    if (seen.has(email)) continue;
    seen.add(email);

    // Walk up tìm row chứa email; stop khi parent chứa >1 email
    let row: HTMLElement | null = textNode.parentElement;
    for (let i = 0; i < 6 && row?.parentElement; i++) {
      const parent = row.parentElement;
      const emailCountInParent = countEmailsInSubtree(parent);
      if (emailCountInParent > 1) break;
      row = parent;
    }
    if (!row) continue;

    members.push({
      email,
      name: findNameInRow(row, email),
      chatgpt_role: parseChatGPTRole(row.textContent ?? null),
      status: "active",
      joined_at: findJoinedAtInRow(row),
    });
  }

  console.log(
    `[autogpt-sync] scrapeAllRows scanned ${textNodesScanned} text nodes → ` +
      `${fullMatchHits} full-match + ${extractMatchHits} extract-match → ` +
      `${members.length} unique rows`,
  );

  return members;
}

/**
 * Đếm số email-format text nodes trong subtree (không bao gồm root chính nó
 * nếu root chỉ có 1 text node email — vẫn count 1).
 */
function countEmailsInSubtree(root: Node): number {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (EMAIL_FULL_RE.test(text)) count += 1;
    if (count > 1) break;
  }
  return count;
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

/**
 * Quick scrape của tab "Lời mời đang chờ xử lý" — dùng sau khi invite xong để
 * map dữ liệu lên dashboard. KHÔNG navigate (caller phải đảm bảo đã ở
 * /admin/members), KHÔNG scrape các tab khác → ngắn gọn, không đụng tới
 * `status='active'` của dashboard.
 *
 * Trả empty array (không throw) nếu tab không tìm thấy / page sai — caller
 * không nên fail invite nếu mapping thất bại.
 *
 * Hard cap 60s — dài hơn dialog typing nhưng đảm bảo không treo task quá lâu.
 */
export async function scrapePendingInvitesAfterInvite(
  taskId: string,
): Promise<ScrapedMember[]> {
  if (!location.pathname.includes("/admin/members")) {
    console.warn(
      `[autogpt-invite-mapping] không ở /admin/members (${location.pathname}) — skip pending scrape`,
    );
    return [];
  }
  const clicked = await clickTabAndWait(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
  );
  if (!clicked) {
    console.warn("[autogpt-invite-mapping] tab 'Lời mời' không tìm thấy → skip");
    return [];
  }
  const startedAt = Date.now();
  const isOverTime = () => Date.now() - startedAt > 60_000;
  const { members } = await scrapeCurrentTab(
    taskId,
    "pending",
    "Map lời mời",
    isOverTime,
  );
  // Click lại tab "Người dùng" để admin/extension idle ở trang quen thuộc
  await clickTabAndWait("tab_active_members", TEXT_FALLBACKS.tabActiveMembers);
  return members;
}

export async function executeSync(
  taskId: string,
  includePending: boolean = true,
  expectedLocale: ChatGPTLocale | null = null,
): Promise<ExecuteActionResponse> {
  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/members trước.`,
    };
  }

  // Phát hiện ngôn ngữ ChatGPT — log để dashboard FAILED banner show context.
  // Nếu dashboard truyền `expectedLocale` (vd 'vi') và ChatGPT đang locale khác
  // (vd 'en'), TEXT_FALLBACKS multi-pattern thường vẫn match được nên KHÔNG
  // fail-fast. Chỉ log warning. Nếu cuối cùng scrape 0 row → trả error có
  // include locale hint để user biết hướng fix.
  const detectedLocale = detectChatGPTLocale();
  const localeCheck = checkLocaleMatch(expectedLocale);
  console.log(
    `[autogpt-sync] locale check: detected='${detectedLocale}' expected='${expectedLocale ?? "any"}' match=${localeCheck.match}`,
  );
  if (!localeCheck.match) {
    console.warn("[autogpt-sync] LOCALE_MISMATCH:", localeCheck.hint);
  }

  // Tab "Users/Pending invites/Pending requests" chỉ tồn tại trên /admin/members.
  // Nếu admin tab đang ở /admin/billing hay /admin/something-else thì điều
  // hướng tới /admin/members. Ưu tiên click <a href> trong sidebar (Next.js
  // router catches reliably) → fallback pushState nếu không có anchor.
  if (!location.pathname.includes("/admin/members")) {
    console.log(
      `[autogpt-sync] đang ở ${location.pathname}, điều hướng sang /admin/members`,
    );
    await reportProgress(
      taskId,
      { phase: "discover", message: "Điều hướng sang /admin/members..." },
      true,
    );
    const sidebarLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).find((a) => {
      const href = a.getAttribute("href") ?? "";
      return (
        href === "/admin/members" ||
        href === "/admin/members/" ||
        a.pathname === "/admin/members" ||
        a.pathname === "/admin/members/"
      );
    });
    if (sidebarLink) {
      console.log(`[autogpt-sync] click <a href="${sidebarLink.getAttribute("href")}">`);
      sidebarLink.click();
    } else {
      console.log("[autogpt-sync] không tìm thấy sidebar link, pushState fallback");
      history.pushState({}, "", "/admin/members");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    // Đợi SPA route + render tab buttons (best-effort polling)
    let tabReady = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (findTabButton("tab_active_members", TEXT_FALLBACKS.tabActiveMembers)) {
        tabReady = true;
        break;
      }
    }
    if (!tabReady) {
      return {
        ok: false,
        error_code: "PAGE_NOT_ADMIN",
        error_message:
          `Không điều hướng được sang /admin/members sau 10s (path hiện tại: ${location.pathname}, ChatGPT locale='${detectedLocale ?? "unknown"}'). ` +
          `Mở tab chatgpt.com/admin/members thủ công và thử lại.` +
          (localeCheck.match ? "" : ` ${localeCheck.hint}`),
      };
    }
  }

  const startedAt = Date.now();
  const isOverTime = () => Date.now() - startedAt > MAX_SYNC_MS;

  // Merged result — key theo email. Status từ tab cuối cùng scrape được sẽ
  // override. Thứ tự ưu tiên: active > pending. → Scrape active CUỐI CÙNG
  // để nếu cùng email xuất hiện ở "Lời mời" cũ và "Người dùng" mới thì
  // active thắng. Nhưng thường email pending không trùng với active.
  const merged = new Map<string, ScrapedMember>();

  if (includePending) {
    // ----- Tab 1: Lời mời đang chờ xử lý (pending invites) -----
    if (await clickTabAndWait("tab_pending_invites", TEXT_FALLBACKS.tabPendingInvites)) {
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
    if (await clickTabAndWait("tab_pending_requests", TEXT_FALLBACKS.tabPendingRequests)) {
      const { members } = await scrapeCurrentTab(
        taskId,
        "pending",
        "Yêu cầu",
        isOverTime,
      );
      console.log(`[autogpt-sync] tab Yêu cầu: ${members.length} entries`);
      for (const m of members) merged.set(m.email, m);
    }
  } else {
    console.log(
      "[autogpt-sync] includePending=false → bỏ qua Lời mời + Yêu cầu, chỉ scrape Người dùng",
    );
  }

  // ----- Tab 3: Người dùng (active members) — scrape CUỐI để status active
  //         thắng nếu trùng email với 2 tab trên (race condition giữa các sync).
  let tab1Found = false;
  if (await clickTabAndWait("tab_active_members", TEXT_FALLBACKS.tabActiveMembers)) {
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
    const localeHint = localeCheck.match
      ? ""
      : ` LANGUAGE_MISMATCH: ${localeCheck.hint}`;
    return {
      ok: false,
      error_code: localeCheck.match ? "UI_ELEMENT_NOT_FOUND" : "LANGUAGE_MISMATCH",
      error_message:
        `Không tìm được row member nào (tab1=${tab1Found}, ${elapsedMs}ms, ChatGPT locale='${detectedLocale ?? "unknown"}'). ` +
        `URL hiện tại: ${location.pathname}.${localeHint}`,
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
