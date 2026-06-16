import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import {
  ApiError,
  bulkUpsertMembers,
  countPendingTasks,
  pickNextTask,
  postHarvestLabels,
  pushBillingSync,
  reconcileAfterInvite,
  updateExtensionInfo,
  updateProgress,
  updateTask,
} from "../shared/api";
import { getConfig } from "../shared/storage";
import type { ExtensionConfig, QueueItem } from "../shared/types";
import { runPaymentChain } from "./payment-chain";

const RATE_LIMIT = {
  /** Min delay giữa 2 task bất kỳ (anti-detection). 5000→2000→1200→840 (-30%). */
  betweenTasksMs: 840,
  /** Số task chạy liên tục trước khi nghỉ batch. Tăng 5→10. */
  batchSize: 10,
  /** Sleep min/max giữa 2 batch. 30-60s → 10-20s → 6-12s (-40%). */
  batchPauseMinMs: 6_000,
  batchPauseMaxMs: 12_000,
};

const CHATGPT_TAB_MATCH = "https://chatgpt.com/admin/*";
const CHATGPT_ADMIN_URL = "https://chatgpt.com/admin/members";
const TAB_LOAD_TIMEOUT_MS = 30_000;

type RunnerState = {
  lastTaskAt: number;
  tasksInBatch: number;
};

const state: RunnerState = { lastTaskAt: 0, tasksInBatch: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Key lưu CHỮ KÝ BUILD (danh sách file content-script kèm hash) của lần self-heal
 * reload gần nhất. chrome.storage.local sống sót qua chrome.runtime.reload() (chỉ
 * mất khi uninstall) → SW mới đọc lại để so sánh.
 *
 * Mục đích: reload (pop chrome://extensions) ĐÚNG MỘT LẦN cho mỗi build mới thật
 * sự. Nếu sau reload VẪN stale với ĐÚNG sig đã reload → Chrome chưa nạp build mới
 * / build hỏng → KHÔNG reload lại (tránh loop). Chỉ reload khi sig KHÁC = đĩa có
 * build mới khác hẳn lần trước.
 */
const STALE_RELOAD_SIG_KEY = "autogpt.lastStaleReloadSig";

/**
 * Số lần đã chrome.runtime.reload() cho ĐÚNG build signature ở STALE_RELOAD_SIG_KEY.
 * Reset về 0 khi sig đổi (= đĩa có build mới khác). Dùng làm guard chống loop:
 * cho phép tối đa MAX_RELOADS_PER_SIG lần reload cho mỗi build stale rồi bỏ cuộc.
 *
 * Trước đây guard chặn CỨNG sau đúng 1 reload (lastSig === sig → không reload nữa).
 * Nhược điểm: nếu chrome.runtime.reload() lần đầu KHÔNG kéo được build mới vào
 * (Chrome chậm áp dụng unpacked build) thì manifest đang chạy kẹt ở hash cũ, sig
 * không bao giờ đổi → guard chặn vĩnh viễn → mọi task fail CONTENT_NOT_INJECTED
 * tới khi reload tay. Đếm lần (cho thêm 1 lần thử) khắc phục case kẹt tạm thời mà
 * vẫn bound được loop khi build hỏng thật.
 */
const STALE_RELOAD_COUNT_KEY = "autogpt.staleReloadCount";
const MAX_RELOADS_PER_SIG = 2;

/**
 * Chữ ký build = danh sách (đã sort) các file js content-script trong manifest
 * đang chạy. Tên file chứa hash (vd index.ts-loader-<hash>.js) nên sig đổi ⟺
 * build đổi. Dùng làm "đã reload cho build này rồi" để không pop lặp lại.
 */
function manifestBuildSig(): string {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{ js?: string[] }>;
  return scripts
    .flatMap((cs) => cs.js ?? [])
    .sort()
    .join("|");
}

/**
 * Phát hiện "stale build": manifest đang load (trong RAM của SW) trỏ tới file
 * content-script đã bị xoá khỏi đĩa. Xảy ra khi `vite build` sinh hash mới
 * (vd index.ts-loader-<hash>.js) nhưng Chrome chưa reload extension → SW cũ vẫn
 * giữ manifest cũ → executeScript / auto-injection "Could not load file" →
 * CONTENT_NOT_INJECTED, mọi task fail tới khi reload tay.
 *
 * Cách check: fetch từng file js mà manifest tham chiếu qua chrome.runtime.getURL.
 * SW fetch resource cùng origin của chính extension → đọc thẳng từ đĩa, không cần
 * web_accessible_resources. File còn → 200; file đã xoá → 404/throw → stale.
 */
async function isExtensionStale(): Promise<boolean> {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{ js?: string[] }>;
  const files = scripts.flatMap((cs) => cs.js ?? []);
  for (const file of files) {
    try {
      const resp = await fetch(chrome.runtime.getURL(file));
      if (!resp.ok) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * chrome.runtime.reload() để Chrome đọc lại manifest+file MỚI từ đĩa (extension
 * unpacked), tự sửa hash. SW hiện tại bị kill ngay; SW mới boot lại sẽ thấy file
 * hợp lệ và drain queue bình thường.
 *
 * Guard chống loop bằng (CHỮ KÝ BUILD + số lần đã reload): chỉ reload tối đa
 * MAX_RELOADS_PER_SIG lần cho mỗi build stale. Nếu vẫn stale sau ngần ấy lần với
 * cùng sig → Chrome không nạp được build mới / build hỏng thật → bỏ cuộc, để user
 * reload tay. sig đổi (đĩa có build khác) → count reset, được reload lại.
 *
 * Trả về true nếu đã trigger reload (caller nên dừng ngay, SW sắp chết); false
 * nếu guard chặn (đã thử tối đa).
 */
async function reloadForStaleBuild(reason: string): Promise<boolean> {
  const sig = manifestBuildSig();
  const stored = await chrome.storage.local.get([
    STALE_RELOAD_SIG_KEY,
    STALE_RELOAD_COUNT_KEY,
  ]);
  const lastSig = stored[STALE_RELOAD_SIG_KEY] as string | undefined;
  const prevCount =
    lastSig === sig ? Number(stored[STALE_RELOAD_COUNT_KEY] ?? 0) : 0;
  if (prevCount >= MAX_RELOADS_PER_SIG) {
    console.error(
      `[autogpt-selfheal] đã reload ${prevCount} lần cho CÙNG build signature mà VẪN stale ` +
        `(${reason}) — Chrome không nạp được build mới hoặc \`dist\` thiếu file content-script ` +
        `(build hỏng?). KHÔNG reload nữa để tránh loop pop chrome://extensions. ` +
        `Reload tay tại chrome://extensions + chạy lại \`npm run build\`.`,
    );
    return false;
  }

  await chrome.storage.local.set({
    [STALE_RELOAD_SIG_KEY]: sig,
    [STALE_RELOAD_COUNT_KEY]: prevCount + 1,
  });
  console.warn(
    `[autogpt-selfheal] stale build (${reason}) → chrome.runtime.reload() lần ` +
      `${prevCount + 1}/${MAX_RELOADS_PER_SIG} để Chrome đọc lại từ đĩa.`,
  );
  chrome.runtime.reload();
  return true;
}

/**
 * Nếu phát hiện stale build → reload extension (qua reloadForStaleBuild).
 *
 * Gọi TRƯỚC pickNextTask để không claim task rồi bỏ dở khi SW restart.
 * Trả về true nếu đã trigger reload (caller nên dừng ngay, SW sắp chết).
 */
async function selfHealIfStale(): Promise<boolean> {
  if (!(await isExtensionStale())) return false;

  // GATE: chỉ reload khi THỰC SỰ có task PENDING đang chờ. Lúc rảnh thì im lặng —
  // không pop chrome://extensions, không mở tab ChatGPT thừa. Cần config (API key)
  // để hỏi backend; chưa có key thì cũng chẳng có gì để chạy → skip.
  const config = await getConfig();
  if (!config) {
    console.log(
      "[autogpt-selfheal] stale build nhưng chưa có API key — skip (không có việc để làm).",
    );
    return false;
  }
  let pending = 0;
  try {
    pending = await countPendingTasks(config);
  } catch (e) {
    console.warn(
      "[autogpt-selfheal] không lấy được pending-count — skip self-heal lần này:",
      e,
    );
    return false;
  }
  if (pending <= 0) {
    console.log(
      "[autogpt-selfheal] stale build nhưng 0 task PENDING — chờ, không reload lúc rảnh.",
    );
    return false;
  }

  return reloadForStaleBuild("phát hiện ở vòng drain (có task PENDING)");
}

async function findAdminTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: CHATGPT_TAB_MATCH });
  return tabs[0] ?? null;
}

/**
 * Đợi tab load xong (status='complete') hoặc timeout.
 * Cần thiết sau khi tabs.create / tabs.update để content script kịp inject
 * và DOM admin page render.
 */
function waitForTabComplete(
  tabId: number,
  timeoutMs: number,
): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (id !== tabId) return;
      if (info.status !== "complete") return;
      cleanup();
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (resolved) return;
      cleanup();
      chrome.tabs.get(tabId).then(resolve).catch(() => resolve(null));
    }, timeoutMs);
  });
}

/**
 * Đảm bảo có tab chatgpt.com/admin/* đang mở.
 * Logic:
 *   1. Có tab khớp → trả ngay
 *   2. Không có → tự mở tab MỚI tới chatgpt.com/admin/members (background tab,
 *      không steal focus), đợi load xong
 *   3. Sau khi load, verify URL vẫn ở /admin (nếu bị redirect tới login = chưa
 *      đăng nhập ChatGPT trong browser này) → trả null
 *
 * Trả về tab khớp hoặc null nếu user chưa đăng nhập ChatGPT.
 */
async function ensureAdminTab(): Promise<chrome.tabs.Tab | null> {
  const existing = await findAdminTab();
  if (existing) return existing;

  console.log(
    `[autogpt-runner] không có admin tab — tự mở ${CHATGPT_ADMIN_URL} (background)`,
  );
  const created = await chrome.tabs.create({
    url: CHATGPT_ADMIN_URL,
    active: false,
  });
  if (created.id === undefined) return null;

  const loaded = await waitForTabComplete(created.id, TAB_LOAD_TIMEOUT_MS);
  if (!loaded || !loaded.url) {
    console.warn("[autogpt-runner] tab vừa tạo không load được");
    return null;
  }
  // ChatGPT chưa đăng nhập sẽ redirect tới /auth/login hoặc /
  if (!loaded.url.includes("/admin")) {
    console.warn(
      `[autogpt-runner] tab bị redirect khỏi /admin: ${loaded.url} — user chưa login ChatGPT trong browser này`,
    );
    return null;
  }
  console.log(
    `[autogpt-runner] admin tab mới tạo OK: tab ${created.id} ${loaded.url}`,
  );
  return loaded;
}

async function pingContent(tabId: number): Promise<boolean> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { kind: "PING" });
    return Boolean(resp?.ok);
  } catch {
    return false;
  }
}

/**
 * Lấy JS files của content script chạy trên chatgpt.com/admin từ manifest.
 * Sau khi vite build, source `.ts` được rename thành `assets/index.ts-<hash>.js`
 * — hash đổi mỗi build nên KHÔNG hardcode được. Đọc manifest runtime.
 */
function getChatGPTContentScriptFiles(): string[] {
  const manifest = chrome.runtime.getManifest();
  const scripts = (manifest.content_scripts ?? []) as Array<{
    matches?: string[];
    js?: string[];
  }>;
  const entry = scripts.find((cs) =>
    (cs.matches ?? []).some((m) => m.includes("chatgpt.com/admin")),
  );
  return entry?.js ?? [];
}

/**
 * Đảm bảo content script đã inject ở tab `tabId`. KHÔNG bao giờ yêu cầu user
 * thao tác — tự động qua 3 step fallback:
 *
 *   Step 1: chrome.scripting.executeScript inject loader → retry ping ~3s
 *   Step 2: chrome.tabs.reload (F5 tab) → executeScript lần 2 → retry ping ~9s
 *   Step 3 NUCLEAR: chrome.tabs.remove + chrome.tabs.create tab mới hoàn toàn
 *           → wait load → executeScript → retry ping ~6s
 *
 * v0.6.3 re-thêm Step 3 NUCLEAR (đã bị bỏ ở v0.4.20). Lý do an toàn lại: sau
 * v0.6.2, INVITE_MEMBER tách thành Phase 1 (submit) + Phase 2 (F5 + verify).
 * Step 3 NUCLEAR ở Phase 1 không phá dialog vì dialog chưa mở; nếu cần ở
 * Phase 2 thì verify scrape là idempotent.
 *
 * Trả về:
 *   - { ok: true, tabId: N } — content script ready, có thể là tab khác nếu
 *     Step 3 recreate. Caller phải dùng tabId mới.
 *   - { ok: false } — cả 3 step thất bại (rất hiếm: ChatGPT không login, hoặc
 *     extension permission bị block).
 */
async function ensureContentInjected(
  tabId: number,
): Promise<{ ok: boolean; tabId: number; diag: string[]; stale?: boolean }> {
  // v0.6.7: thu thập diag chi tiết step-by-step. Trước đây 3 step fail thầm
  // chỉ in console.warn → user mở DevTools service worker mới biết step nào
  // hỏng. Giờ collect array → propagate vào error_message của task → dashboard
  // hiển thị thẳng. KHÔNG thay đổi logic 3 step, chỉ thêm visibility.
  const diag: string[] = [];
  const t0 = Date.now();
  const log = (msg: string): void => {
    const elapsed = Date.now() - t0;
    const line = `+${elapsed}ms ${msg}`;
    console.log(`[autogpt-ensure] ${line}`);
    diag.push(line);
  };

  // Snapshot tab state ngay đầu — biết URL/status hiện tại để phân biệt:
  // (a) tab đã logout về /auth/login, (b) tab đang loading, (c) tab healthy
  try {
    const tab = await chrome.tabs.get(tabId);
    log(`tab ${tabId} state: status=${tab.status} url=${tab.url ?? "?"}`);
    if (tab.url && !tab.url.includes("/admin")) {
      log(`⚠ tab URL không chứa /admin — có thể đã logout/redirect`);
    }
  } catch (e) {
    log(`chrome.tabs.get(${tabId}) THREW: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (await pingContent(tabId)) {
    log("initial ping OK — content script đã sẵn sàng");
    return { ok: true, tabId, diag };
  }
  log("initial ping fail — content script chưa response");

  // STALE-BUILD SHORT-CIRCUIT: nếu manifest đang chạy trỏ tới file content-script
  // đã bị xoá khỏi đĩa (rebuild đổi hash, Chrome chưa reload) thì executeScript ở
  // CẢ 3 step dưới CHẮC CHẮN ném "Could not load file" — vô ích + phí ~23s + phá
  // tab (Step 3 NUCLEAR). Phát hiện sớm → bỏ qua 3 step, báo stale lên caller để
  // mark task FAILED rồi reloadForStaleBuild() (self-heal đúng cách = reload
  // EXTENSION, không phải reload TAB).
  if (await isExtensionStale()) {
    log(
      "⚠ extension STALE (manifest trỏ file content-script đã xoá khỏi đĩa) — " +
        "bỏ qua 3 step executeScript (chắc chắn fail 'Could not load file'). Caller sẽ self-heal reload.",
    );
    return { ok: false, tabId, diag, stale: true };
  }

  // Step 1: executeScript inject loader
  const files = getChatGPTContentScriptFiles();
  if (files.length === 0) {
    log("⚠ manifest KHÔNG có content_script cho chatgpt.com/admin — abort");
    return { ok: false, tabId, diag };
  }
  log(`Step 1: executeScript files=[${files.join(", ")}]`);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    log("Step 1 executeScript resolved");
  } catch (e) {
    log(`Step 1 executeScript THREW: ${e instanceof Error ? e.message : String(e)}`);
  }
  const RETRY_DELAYS_MS = [250, 500, 700, 800, 800];
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    if (await pingContent(tabId)) {
      log(`Step 1 ping ${i + 1}/${RETRY_DELAYS_MS.length} OK — ready`);
      return { ok: true, tabId, diag };
    }
  }
  log(`Step 1 ping fail toàn bộ ${RETRY_DELAYS_MS.length} retry`);

  // Step 2: AUTO-RELOAD tab + executeScript LẦN 2 (belt-and-suspenders)
  log("Step 2: tabs.reload + executeScript lại");
  try {
    await chrome.tabs.reload(tabId);
    const reloaded = await waitForTabComplete(tabId, 15_000);
    log(`Step 2 reload done, url=${reloaded?.url ?? "?"} status=${reloaded?.status ?? "?"}`);
    if (reloaded?.url?.includes("/admin")) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files });
        log("Step 2 executeScript resolved");
      } catch (e) {
        log(`Step 2 executeScript THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
      const POST_RELOAD_DELAYS_MS = [500, 800, 1000, 1200, 1500, 2000, 2000];
      for (let i = 0; i < POST_RELOAD_DELAYS_MS.length; i++) {
        await new Promise((r) => setTimeout(r, POST_RELOAD_DELAYS_MS[i]));
        if (await pingContent(tabId)) {
          log(`Step 2 ping ${i + 1}/${POST_RELOAD_DELAYS_MS.length} OK — ready`);
          return { ok: true, tabId, diag };
        }
      }
      log(`Step 2 ping fail toàn bộ ${POST_RELOAD_DELAYS_MS.length} retry`);
    } else {
      log(`⚠ Step 2 ABORT: sau reload tab redirect khỏi /admin (url=${reloaded?.url}) — likely logged out`);
    }
  } catch (e) {
    log(`Step 2 tabs.reload THREW: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Step 3 NUCLEAR: tab cũ stuck → tạo tab mới hoàn toàn
  log("Step 3 NUCLEAR: tabs.remove + tabs.create");
  let newTabId = tabId;
  try {
    try {
      await chrome.tabs.remove(tabId);
      log("Step 3 tabs.remove resolved");
    } catch (e) {
      log(`Step 3 tabs.remove THREW (tab có thể đã đóng): ${e instanceof Error ? e.message : String(e)}`);
    }
    const created = await chrome.tabs.create({
      url: CHATGPT_ADMIN_URL,
      active: false,
    });
    if (created.id === undefined) {
      log("⚠ Step 3 tabs.create KHÔNG trả tabId");
      return { ok: false, tabId, diag };
    }
    newTabId = created.id;
    log(`Step 3 created tab ${newTabId}, đợi load...`);
    const recreated = await waitForTabComplete(newTabId, 20_000);
    log(`Step 3 wait load done, url=${recreated?.url ?? "?"} status=${recreated?.status ?? "?"}`);
    if (!recreated?.url?.includes("/admin")) {
      log(`⚠ Step 3 ABORT: tab mới redirect khỏi /admin → user chưa login ChatGPT trong browser này`);
      return { ok: false, tabId: newTabId, diag };
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: newTabId }, files });
      log("Step 3 executeScript resolved");
    } catch (e) {
      log(`Step 3 executeScript THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
    const POST_RECREATE_DELAYS_MS = [800, 1200, 1500, 2000, 2000];
    for (let i = 0; i < POST_RECREATE_DELAYS_MS.length; i++) {
      await new Promise((r) => setTimeout(r, POST_RECREATE_DELAYS_MS[i]));
      if (await pingContent(newTabId)) {
        log(`Step 3 ping ${i + 1}/${POST_RECREATE_DELAYS_MS.length} OK — ready (tab ${newTabId})`);
        return { ok: true, tabId: newTabId, diag };
      }
    }
    log(`Step 3 ping fail toàn bộ ${POST_RECREATE_DELAYS_MS.length} retry`);
  } catch (e) {
    log(`Step 3 unexpected THREW: ${e instanceof Error ? e.message : String(e)}`);
  }

  log(`Cả 3 step đều fail — give up. tab=${newTabId}`);
  return { ok: false, tabId: newTabId, diag };
}

async function sendToContent(
  tabId: number,
  request: ExecuteActionRequest,
): Promise<ExecuteActionResponse> {
  const ready = await ensureContentInjected(tabId);
  // QUAN TRỌNG: nếu Step 3 NUCLEAR recreate đổi tabId, dùng tabId MỚI để gửi
  // message — không gửi tabId cũ đã bị remove.
  const effectiveTabId = ready.tabId;
  if (!ready.ok) {
    // v0.6.7: propagate diag step-by-step vào error_message để dashboard hiển
    // thị thẳng — không bắt user mở DevTools service worker mới biết lỗi gì.
    const diagText = ready.diag.length > 0
      ? "\n\nChi tiết từng bước:\n" + ready.diag.join("\n")
      : "";
    // STALE_BUILD: extension chạy build cũ (manifest trỏ file đã xoá khỏi đĩa).
    // error_code riêng để runOnce biết mark FAILED xong thì reloadForStaleBuild()
    // → SW restart, các task sau chạy lại bình thường (không cần user reload tay).
    if (ready.stale) {
      return {
        ok: false,
        error_code: "STALE_BUILD",
        error_message:
          "Extension đang chạy build CŨ (manifest trỏ file content-script đã bị xoá khỏi đĩa sau rebuild). " +
          "Đang tự reload extension để Chrome nạp build mới — task này sẽ chạy lại ở lần kế. " +
          "Nếu lặp lại nhiều lần: chrome://extensions/ → reload AutoGPT thủ công + chạy lại `npm run build`." +
          diagText,
      };
    }
    return {
      ok: false,
      error_code: "CONTENT_NOT_INJECTED",
      error_message:
        "Tab chatgpt.com/admin không thể inject content script sau 3 bước fallback (executeScript / reload / recreate tab). " +
        "Cách khắc phục thường gặp: (1) F5 ChatGPT tab thủ công, (2) chrome://extensions/ → reload AutoGPT, " +
        "(3) đảm bảo extension + ChatGPT cùng browser profile + đã login." +
        diagText,
    };
  }
  try {
    return await chrome.tabs.sendMessage(effectiveTabId, request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: `Lỗi gửi message tới content script: ${msg}.`,
    };
  }
}

/**
 * Báo progress lifecycle từ background (trước cả khi content script chạy).
 * Dùng cho task long-op (HARVEST_LABELS, SYNC_DATA) để dashboard không bị
 * "đứng yên" trong 5-30s mở tab + inject content script + rate-limit.
 * Best-effort: silent fail.
 */
async function reportRunnerProgress(
  config: ExtensionConfig,
  taskId: string,
  progress: { phase: string; message: string; current?: number; total?: number },
): Promise<void> {
  try {
    await updateProgress(config, taskId, progress);
  } catch (e) {
    console.warn("[autogpt-runner] reportRunnerProgress failed", e);
  }
}

function taskToRequest(task: QueueItem): ExecuteActionRequest | null {
  const p = task.payload;
  switch (task.type) {
    case "INVITE_MEMBER": {
      // Backward-compat: payload.email (single) hoặc payload.emails (batch).
      // Cả 2 đều convert thành emails: string[] cho extension action.
      const rawEmails = p.emails;
      let emails: string[] = [];
      if (Array.isArray(rawEmails)) {
        emails = rawEmails.filter((e): e is string => typeof e === "string");
      } else if (typeof p.email === "string") {
        emails = [p.email];
      }
      const verifiedDomain =
        typeof p.verified_domain === "string" ? p.verified_domain : null;
      return {
        kind: "INVITE_MEMBER",
        taskId: task.id,
        emails,
        role: (p.role as "owner" | "admin" | "member") ?? "member",
        verifiedDomain,
      };
    }
    case "REMOVE_MEMBER":
      return {
        kind: "REMOVE_MEMBER",
        taskId: task.id,
        email: String(p.email ?? ""),
      };
    case "CHANGE_ROLE":
      return {
        kind: "CHANGE_ROLE",
        taskId: task.id,
        email: String(p.email ?? ""),
        new_role: (p.new_role as "owner" | "admin" | "member") ?? "member",
        old_role: (p.old_role as "owner" | "admin" | "member" | null) ?? null,
      };
    case "CHANGE_LICENSE_TYPE":
      return {
        kind: "CHANGE_LICENSE_TYPE",
        taskId: task.id,
        email: String(p.email ?? ""),
        new_license_type:
          (p.new_license_type as "ChatGPT" | "Codex") ?? "ChatGPT",
        old_license_type:
          (p.old_license_type as "ChatGPT" | "Codex" | null) ?? null,
      };
    case "SYNC_DATA": {
      // Dashboard có thể truyền expected_locale ('vi' | 'en' | 'zh') trong
      // payload để extension check locale ChatGPT khớp chưa. Null = không check.
      const rawLocale = p.expected_locale;
      const expectedLocale: "vi" | "en" | "zh" | null =
        rawLocale === "vi" || rawLocale === "en" || rawLocale === "zh"
          ? rawLocale
          : null;
      const rawScope = p.sync_scope;
      const scope: "members" | "invites" | "both" =
        rawScope === "members" || rawScope === "invites" || rawScope === "both"
          ? rawScope
          : (p.include_pending as boolean | undefined) !== false
            ? "both"
            : "members";
      return {
        kind: "SYNC_DATA",
        taskId: task.id,
        scope,
        expectedLocale,
      };
    }
    case "SYNC_BILLING":
      return { kind: "SYNC_BILLING", taskId: task.id };
    case "REVOKE_INVITES": {
      const rawEmails = (task.payload?.emails as unknown) ?? [];
      const emails = Array.isArray(rawEmails)
        ? rawEmails.filter((e): e is string => typeof e === "string")
        : [];
      return { kind: "REVOKE_INVITES", taskId: task.id, emails };
    }
    case "HARVEST_LABELS": {
      const rawLocale = String(task.payload?.locale ?? "").toLowerCase();
      const locale: "vi" | "en" | "zh" =
        rawLocale === "vi" || rawLocale === "zh" ? rawLocale : "en";
      return { kind: "HARVEST_LABELS", taskId: task.id, locale };
    }
    case "PURCHASE_SEAT": {
      const rawQty = Number(p.quantity);
      const quantity = Number.isFinite(rawQty) && rawQty > 0 ? Math.floor(rawQty) : 1;
      const skipToPayment = p.skip_to_payment === true;
      return { kind: "PURCHASE_SEAT", taskId: task.id, quantity, skipToPayment };
    }
    default:
      return null;
  }
}

const CHUNK_SIZE = 200;

async function reportToBackend(
  config: ExtensionConfig,
  task: QueueItem,
  response: ExecuteActionResponse,
): Promise<void> {
  if (response.ok) {
    // Special case: SYNC_BILLING mang theo billing → PATCH workspace billing fields.
    if (task.type === "SYNC_BILLING") {
      const data = response.data as
        | {
            billing?: {
              plan?: string | null;
              seat_total?: number | null;
              seat_used?: number | null;
              billing_status?: "PAID" | "UNPAID" | "UNKNOWN" | null;
              renewal_date?: string | null;
              invoices?: Array<{
                date: string;
                amount_vnd: number;
                status: string;
              }>;
            };
          }
        | undefined;
      const billing = data?.billing;
      if (!billing) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "UI_ELEMENT_NOT_FOUND",
          error_message: "Extension không trả billing data",
        });
        return;
      }
      try {
        const updated = await pushBillingSync(config, billing);
        await updateTask(config, task.id, {
          status: "COMPLETED",
          result: {
            seat_total: updated.seat_total,
            seat_used: updated.seat_used,
            plan: updated.plan,
            billing_status: updated.billing_status,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "BILLING_SYNC_FAILED",
          error_message: msg,
        });
      }
      return;
    }

    // Special case: HARVEST_LABELS mang theo labels → POST /ui-labels/harvest.
    if (task.type === "HARVEST_LABELS") {
      const data = response.data as
        | {
            harvest?: {
              locale: "vi" | "en" | "zh";
              pages: Array<{
                page: string;
                labels: Array<{
                  control_key: string;
                  label_text?: string | null;
                  aria_label?: string | null;
                }>;
              }>;
            };
            total?: number;
          }
        | undefined;
      const harvest = data?.harvest;
      if (!harvest) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "UI_ELEMENT_NOT_FOUND",
          error_message: "Extension không trả harvest payload",
        });
        return;
      }
      try {
        const result = await postHarvestLabels(config, harvest);
        await updateTask(config, task.id, {
          status: "COMPLETED",
          result: {
            locale: result.locale,
            total: result.total,
            pages: result.pages,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "HARVEST_UPSERT_FAILED",
          error_message: msg,
        });
      }
      return;
    }

    // Special case: SYNC_DATA mang theo members → chunked bulk-upsert.
    if (task.type === "SYNC_DATA" && task.workspace_id) {
      // Đọc include_pending từ task.payload để báo backend scope reconcile:
      //   - true (default) → scraped active+pending tab → backend reconcile cả 2
      //   - false → chỉ scraped active → backend chỉ reconcile active, KHÔNG
      //     đụng tới pending (giữ trạng thái pending từ sync trước)
      const rawScope = task.payload?.sync_scope as string | undefined;
      const scope: "members" | "invites" | "both" =
        rawScope === "members" || rawScope === "invites" || rawScope === "both"
          ? rawScope
          : (task.payload?.include_pending as boolean | undefined) !== false
            ? "both"
            : "members";
      // Báo backend đúng scope reconcile: chỉ reconcile status đã thực sự scrape.
      const scrapedStatuses: Array<"active" | "pending"> =
        scope === "both"
          ? ["active", "pending"]
          : scope === "invites"
            ? ["pending"]
            : ["active"];
      const data = response.data as
        | {
            members?: Array<Record<string, unknown>>;
            user_info?: { email?: string | null; name?: string | null };
          }
        | undefined;
      const members = (data?.members ?? []) as Array<{
        email: string;
        name?: string | null;
        chatgpt_role?: "owner" | "admin" | "member" | null;
        license_type?: "ChatGPT" | "Codex" | null;
        status?: "active" | "pending" | "removed";
      }>;

      // Update workspace's connected ChatGPT user nếu scrape được
      if (data?.user_info && (data.user_info.email || data.user_info.name)) {
        try {
          await updateExtensionInfo(config, data.user_info);
        } catch (e) {
          console.warn("[autogpt] updateExtensionInfo failed:", e);
        }
      }

      let totalCreated = 0;
      let totalUpdated = 0;
      const rogueEmailsAggregated: string[] = [];
      try {
        for (let i = 0; i < members.length; i += CHUNK_SIZE) {
          const chunk = members.slice(i, i + CHUNK_SIZE);
          const result = (await bulkUpsertMembers(
            config,
            task.workspace_id,
            chunk,
            { scrapedStatuses },
          )) as {
            created: number;
            updated: number;
            rogue_pending_emails?: string[];
          };
          totalCreated += result.created;
          totalUpdated += result.updated;
          if (Array.isArray(result.rogue_pending_emails)) {
            rogueEmailsAggregated.push(...result.rogue_pending_emails);
          }
          console.log(
            `[autogpt-sync-upsert] chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(
              members.length / CHUNK_SIZE,
            )}: +${result.created} ~${result.updated}`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "BULK_UPSERT_FAILED",
          error_message: msg,
        });
        return;
      }

      // Rogue emails (invite trên ChatGPT mà KHÔNG có Member record trong DB)
      // được đẩy vào task.result để dashboard hiển thị + hỏi admin xác nhận.
      // KHÔNG auto-revoke ở đây — admin chọn trên dashboard.
      if (rogueEmailsAggregated.length > 0) {
        console.log(
          `[autogpt-sync] phát hiện ${rogueEmailsAggregated.length} rogue pending invite(s):`,
          rogueEmailsAggregated,
        );
      }

      await updateTask(config, task.id, {
        status: "COMPLETED",
        result: {
          total: members.length,
          created: totalCreated,
          updated: totalUpdated,
          chunks: Math.ceil(members.length / CHUNK_SIZE),
          rogue_pending_emails: rogueEmailsAggregated,
        },
      });
      return;
    }

    // Special case: INVITE_MEMBER. Sau khi click invite + verify dialog success,
    // extension đã scrape tab "Lời mời đang chờ xử lý" + tách verified vs
    // unverified emails. Chỉ verified members được bulk-upsert (scope='pending')
    // → dashboard không update records cho email mà ChatGPT KHÔNG nhận.
    if (task.type === "INVITE_MEMBER" && task.workspace_id) {
      const data = response.data as
        | {
            emails?: string[];
            pending_members?: Array<Record<string, unknown>>;
            verified_emails?: string[];
            unverified_emails?: string[];
            verify_scrape_failed?: boolean;
          }
        | undefined;
      const pending = (data?.pending_members ?? []) as Array<{
        email: string;
        name?: string | null;
        chatgpt_role?: "owner" | "admin" | "member" | null;
        status?: "active" | "pending" | "removed";
      }>;
      const verifiedEmails = data?.verified_emails ?? [];
      const unverifiedEmails = data?.unverified_emails ?? [];
      const verifyScrapeFailed = data?.verify_scrape_failed === true;
      // Tổng email đã mời (từ verify data, fallback ghép verified+unverified).
      const emails =
        data?.emails ?? [...verifiedEmails, ...unverifiedEmails];

      let mappedCount = 0;
      if (pending.length > 0) {
        try {
          for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
            const chunk = pending.slice(i, i + CHUNK_SIZE);
            // v0.6.4 fix: isFullSync=false + bỏ scrapedStatuses → backend chỉ
            // upsert email trong chunk, KHÔNG reconcile/mark removed cho pending
            // members khác. Trước đây dùng scrapedStatuses=["pending"] gây bug:
            // verify g12 cùng giây với invite a12, scrape chưa thấy a12 → backend
            // reconcile → a12 bị mark "removed" oan. Lưu ý: việc reconcile thật
            // sự thuộc về SYNC_DATA task chuyên dụng, KHÔNG phải verify sau invite.
            await bulkUpsertMembers(config, task.workspace_id, chunk, {
              isFullSync: false,
            });
            mappedCount += chunk.length;
          }
          console.log(
            `[autogpt-invite] verify+map: ${mappedCount} verified email được upsert (no-reconcile)`,
          );
        } catch (e) {
          console.warn(
            "[autogpt-invite] bulk-upsert verified pending FAILED — task vẫn COMPLETED:",
            e,
          );
        }
      }
      // DỌN PHANTOM: email vừa mời nhưng KHÔNG có trong tab "Lời mời" (scrape OK)
      // → báo backend mark Member pending tương ứng 'removed'. Chỉ chạy khi scrape
      // KHÔNG fail (nếu fail thì giữ nguyên, SYNC_DATA sau sẽ reconcile chuẩn).
      // Đây là fix bug "đã add nhưng không có trong pending vẫn hiện trên web".
      let reconciledRemoved = 0;
      if (unverifiedEmails.length > 0) {
        console.warn(
          `[autogpt-invite] ${unverifiedEmails.length} email UNVERIFIED (KHÔNG tìm thấy trong tab Lời mời):`,
          unverifiedEmails,
        );
        if (!verifyScrapeFailed) {
          try {
            const r = await reconcileAfterInvite(config, task.workspace_id, {
              verifiedEmails,
              unverifiedEmails,
              verifyScrapeFailed,
            });
            reconciledRemoved = r.removed;
            console.log(
              `[autogpt-invite] reconcile-after-invite: ${r.removed} phantom pending member(s) đã mark removed`,
            );
          } catch (e) {
            console.warn(
              "[autogpt-invite] reconcile-after-invite FAILED — phantom members có thể còn:",
              e,
            );
          }
        }
      }

      // Quyết định status task: nếu scrape OK nhưng 0 email vào pending → FAILED
      // (để user thấy rõ invite không thành công), đã dọn phantom ở trên. Nếu
      // scrape fail → COMPLETED (benefit-of-doubt, giữ records). Có ≥1 verified
      // → COMPLETED.
      const totalMissScrapeOk =
        !verifyScrapeFailed && verifiedEmails.length === 0 && emails.length > 0;
      const resultPayload = {
        data: response.data ?? null,
        mapped_pending: mappedCount,
        verified_count: verifiedEmails.length,
        unverified_count: unverifiedEmails.length,
        unverified_emails: unverifiedEmails,
        verify_scrape_failed: verifyScrapeFailed,
        reconciled_removed: reconciledRemoved,
      };
      if (totalMissScrapeOk) {
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "VERIFY_FAILED",
          error_message:
            `Đã submit ${emails.length} email + F5 verify nhưng KHÔNG email nào xuất hiện trong tab ` +
            `'Lời mời đang chờ xử lý'. Có thể: (a) toggle 'mời ngoài tên miền' chưa bật, ` +
            `(b) email đã là thành viên, (c) ChatGPT từ chối. Đã gỡ ${reconciledRemoved} bản ghi tạm khỏi dashboard. ` +
            `Email: ` +
            unverifiedEmails.slice(0, 5).join(", ") +
            (unverifiedEmails.length > 5
              ? ` +${unverifiedEmails.length - 5}`
              : ""),
          result: resultPayload,
        });
      } else {
        await updateTask(config, task.id, {
          status: "COMPLETED",
          result: resultPayload,
        });
      }
      return;
    }

    await updateTask(config, task.id, {
      status: "COMPLETED",
      result: { data: response.data ?? null },
    });
  } else {
    // INVITE_MEMBER fail vì KHÔNG bật được toggle external invites → extension đã
    // KHÔNG submit invite (xem execute-invite.ts). Backend đã pre-create Member
    // pending lúc bấm mời → phải DỌN để không hiện phantom "đang chờ".
    if (
      task.type === "INVITE_MEMBER" &&
      task.workspace_id &&
      response.error_code === "EXTERNAL_TOGGLE_FAILED"
    ) {
      const p = (task.payload ?? {}) as Record<string, unknown>;
      const payloadEmails: string[] = Array.isArray(p.emails)
        ? (p.emails as string[])
        : typeof p.email === "string"
          ? [p.email]
          : [];
      if (payloadEmails.length > 0) {
        try {
          const r = await reconcileAfterInvite(config, task.workspace_id, {
            verifiedEmails: [],
            unverifiedEmails: payloadEmails,
            verifyScrapeFailed: false,
          });
          console.log(
            `[autogpt-invite] EXTERNAL_TOGGLE_FAILED → dọn ${r.removed} phantom pending member(s)`,
          );
        } catch (e) {
          console.warn(
            "[autogpt-invite] reconcile sau EXTERNAL_TOGGLE_FAILED thất bại:",
            e,
          );
        }
      }
    }
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: response.error_code,
      error_message: response.error_message,
    });
  }
}

async function applyRateLimit(): Promise<void> {
  const sinceLast = Date.now() - state.lastTaskAt;
  if (state.lastTaskAt > 0 && sinceLast < RATE_LIMIT.betweenTasksMs) {
    await sleep(RATE_LIMIT.betweenTasksMs - sinceLast);
  }

  if (state.tasksInBatch >= RATE_LIMIT.batchSize) {
    const pause =
      RATE_LIMIT.batchPauseMinMs +
      Math.floor(
        Math.random() *
          (RATE_LIMIT.batchPauseMaxMs - RATE_LIMIT.batchPauseMinMs),
      );
    console.log(`[autogpt] batch reached ${RATE_LIMIT.batchSize}, nghỉ ${pause}ms`);
    await sleep(pause);
    state.tasksInBatch = 0;
  }
}

let runUntilIdleInFlight: Promise<{
  processed: number;
  lastStatus: string;
  lastDetail?: string;
}> | null = null;

export function runUntilIdle(): Promise<{
  processed: number;
  lastStatus: string;
  lastDetail?: string;
}> {
  if (runUntilIdleInFlight) return runUntilIdleInFlight;
  runUntilIdleInFlight = doRunUntilIdle().finally(() => {
    runUntilIdleInFlight = null;
  });
  return runUntilIdleInFlight;
}

async function doRunUntilIdle(): Promise<{
  processed: number;
  lastStatus: string;
  lastDetail?: string;
}> {
  // SELF-HEAL: trước khi đụng tới queue, kiểm tra extension có "stale" không
  // (rebuild đổi hash file nhưng Chrome chưa reload). Nếu có → tự reload từ đĩa.
  // Chạy TRƯỚC pickNextTask nên không task nào bị claim rồi bỏ dở khi SW restart.
  //
  // ⚠ GATE bằng pending-count (v0.7.5): chrome.runtime.reload() khiến Chrome bật
  // chrome://extensions + sau khi SW boot lại sẽ mở tab ChatGPT mới. Trước đây
  // self-heal chạy ở MỌI nhịp drain — kể cả poll 5s / alarm 1 phút lúc RẢNH —
  // nên nếu build đang stale (vd user đang dev/rebuild liên tục) thì cứ vài giây
  // lại reload → chrome://extensions nhấp nháy + tab thừa, rất khó chịu dù không
  // có việc gì để làm. Giờ chỉ tự phục hồi khi THỰC SỰ có task PENDING đang chờ;
  // rảnh thì im lặng. isExtensionStale() (fetch file local) check trước để case
  // bình thường (không stale) KHÔNG tốn request mạng nào.
  const config = await getConfig();
  if (config && (await isExtensionStale())) {
    let pending = 0;
    try {
      pending = await countPendingTasks(config);
    } catch (e) {
      console.warn(
        "[autogpt-selfheal] không đếm được pending-count — hoãn self-heal:",
        e,
      );
    }
    if (pending > 0) {
      if (await selfHealIfStale()) {
        return { processed: 0, lastStatus: "self-heal-reloading" };
      }
    } else {
      console.log(
        "[autogpt-selfheal] build stale nhưng 0 task PENDING → KHÔNG reload " +
          "(tránh bật chrome://extensions + mở tab ChatGPT thừa lúc rảnh)",
      );
    }
  }

  let processed = 0;
  for (let i = 0; i < 50; i++) {
    const r = await runOnce();
    if (r.status === "idle") {
      return { processed, lastStatus: r.status, lastDetail: r.detail };
    }
    if (
      r.status === "no-config" ||
      r.status === "unauthorized" ||
      r.status === "network-error" ||
      r.status === "no-admin-tab"
    ) {
      // Lỗi setup → dừng, không cố thử tiếp
      return { processed, lastStatus: r.status, lastDetail: r.detail };
    }
    processed += 1;
  }
  return { processed, lastStatus: "max-iterations" };
}

/**
 * Skip Phase 1+2 (modal chatgpt.com) — chỉ chạy Phase 3 (tab Hóa đơn scrape) +
 * Phase 4 (Stripe + Link payment chain). Background execute inline qua
 * chrome.scripting.executeScript thay vì depend on content script — tránh hẳn
 * vấn đề CRXJS loader fail sau extension reload.
 */
async function handlePurchaseSeatSkipMode(
  config: ExtensionConfig,
  task: QueueItem,
): Promise<{ status: string; detail?: string }> {
  const taskId = task.id;
  const reportPhase = async (phase: string, message: string) => {
    try {
      await updateProgress(config, taskId, { phase, message });
    } catch {}
  };

  await reportPhase("opening_tab", "Đang mở tab chatgpt.com/admin/billing?tab=invoices...");

  const tab = await ensureAdminTab();
  if (!tab || tab.id === undefined) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "NOT_LOGGED_IN_CHATGPT",
      error_message:
        "Không mở được tab chatgpt.com/admin — user chưa đăng nhập ChatGPT trong browser này.",
    });
    return { status: "no-admin-tab" };
  }
  const tabId = tab.id;

  // Navigate tab tới /admin/billing?tab=invoices nếu chưa
  if (!tab.url?.includes("billing") || !tab.url?.includes("tab=invoices")) {
    await chrome.tabs.update(tabId, {
      url: "https://chatgpt.com/admin/billing?tab=invoices",
      active: false,
    });
    await waitForTabComplete(tabId, 20_000);
    await sleep(2500);
  }

  await reportPhase("scrape_invoice", "Đang scrape invoice 'Đến hạn'...");

  // executeScript inline scrape — KHÔNG depend on content script
  let scraped: { url?: string; amount?: string; error?: string } | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        // Đợi anchor invoice.stripe.com xuất hiện (SPA mất 1-2s render)
        const deadline = Date.now() + 18_000;
        while (Date.now() < deadline) {
          const anchors = Array.from(
            document.querySelectorAll<HTMLAnchorElement>(
              'a[href*="invoice.stripe.com"]',
            ),
          );
          for (const a of anchors) {
            let row: HTMLElement | null = a;
            for (let i = 0; i < 6 && row; i++) {
              const rowText = (row.textContent ?? "").toLowerCase();
              const isDue =
                /đến\s*hạn|đến\s*ngày|due|unpaid|past\s*due|chưa\s*thanh\s*toán|未\s*付款|未支付|逾期/i.test(
                  rowText,
                );
              const isPaid = /đã\s*thanh\s*toán|paid|已\s*付款|已支付/i.test(rowText);
              if (isDue && !isPaid) {
                const amountMatch = (row.textContent ?? "").match(
                  /(\d{1,3}(?:[.,]\d{3}){1,3}(?:[.,]\d{1,2})?)\s*[₫đ]/i,
                );
                return {
                  url: a.href,
                  amount: amountMatch ? amountMatch[0].trim() : undefined,
                };
              }
              row = row.parentElement;
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return { error: "Timeout 18s — không tìm thấy invoice 'Đến hạn'" };
      },
    });
    scraped = results[0]?.result as typeof scraped;
  } catch (e) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "UNKNOWN",
      error_message: `executeScript scrape failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { status: "task-failed", detail: "scrape-exec-fail" };
  }

  if (!scraped?.url) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message:
        scraped?.error ?? "Không scrape được invoice 'Đến hạn' từ tab Hóa đơn.",
    });
    return { status: "task-failed", detail: "no-invoice" };
  }
  if (!scraped.amount) {
    await updateTask(config, taskId, {
      status: "FAILED",
      error_code: "VERIFY_FAILED",
      error_message: `Tìm thấy URL Stripe ${scraped.url} nhưng KHÔNG scrape được amount → không chain để tránh charge sai.`,
    });
    return { status: "task-failed", detail: "no-amount" };
  }

  console.log(
    `[autogpt-runner-skip] scraped: url=${scraped.url}, amount=${scraped.amount}`,
  );
  await reportPhase(
    "payment_chain",
    `Mở Stripe + Link checkout cho invoice ${scraped.amount}...`,
  );

  const chain = await runPaymentChain({
    taskId,
    stripeInvoiceUrl: scraped.url,
    expectedAmountText: scraped.amount,
  });

  await updateTask(config, taskId, {
    status: chain.ok ? "COMPLETED" : "FAILED",
    error_code: chain.ok ? undefined : chain.error_code,
    error_message: chain.ok ? undefined : chain.error_message,
    result: {
      data: {
        mode: "skip_to_payment_background",
        stripe_invoice_url: scraped.url,
        charge_amount_text: scraped.amount,
        payment_chain_stage: chain.stage,
        payment_chain_ok: chain.ok,
        payment_chain_stripe: chain.stripe_result?.ok ? chain.stripe_result.data ?? null : null,
        payment_chain_link: chain.link_result?.ok ? chain.link_result.data ?? null : null,
        payment_chain_stripe_error:
          chain.stripe_result && !chain.stripe_result.ok ? chain.stripe_result.error_message : null,
        payment_chain_link_error:
          chain.link_result && !chain.link_result.ok ? chain.link_result.error_message : null,
      },
    },
  });
  return {
    status: chain.ok ? "done" : "task-failed",
    detail: chain.ok ? undefined : chain.error_code,
  };
}

export async function runOnce(): Promise<{ status: string; detail?: string }> {
  console.log("[autogpt-runner] runOnce: starting");
  const config = await getConfig();
  if (!config) {
    console.warn("[autogpt-runner] runOnce: no-config (chưa save API key trong popup)");
    return { status: "no-config" };
  }

  let task: QueueItem | null;
  try {
    task = await pickNextTask(config);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      console.warn("[autogpt-runner] runOnce: 401 unauthorized");
      return { status: "unauthorized", detail: "API key sai" };
    }
    console.warn("[autogpt-runner] runOnce: pickNextTask network error", e);
    return { status: "network-error", detail: String(e) };
  }
  if (!task) {
    console.log("[autogpt-runner] runOnce: idle (no task)");
    return { status: "idle" };
  }

  console.log(`[autogpt-runner] picked task ${task.type} ${task.id}`);

  // ─── SHORT-CIRCUIT: PURCHASE_SEAT skip_to_payment mode ─────────────────
  // Mode này bypass content script chatgpt.com (vốn không reliable với CRXJS
  // loader sau khi extension reload). Background tự executeScript inline để
  // scrape invoice URL + amount → rồi chain Stripe + Link như bình thường.
  if (
    task.type === "PURCHASE_SEAT" &&
    (task.payload?.skip_to_payment as boolean | undefined) === true
  ) {
    return await handlePurchaseSeatSkipMode(config, task);
  }

  // Long-op task: báo progress lifecycle ngay từ background để dashboard biết
  // extension đã nhận task (không bị đứng yên trong khi mở tab + inject content).
  const isLongOp =
    task.type === "HARVEST_LABELS" || task.type === "SYNC_DATA";
  if (isLongOp) {
    await reportRunnerProgress(config, task.id, {
      phase: "queued",
      message: "Extension đã nhận task — đang chuẩn bị tab ChatGPT...",
      current: 0,
      total: task.type === "HARVEST_LABELS" ? 18 : 100,
    });
  }

  const request = taskToRequest(task);
  if (!request) {
    console.warn(`[autogpt-runner] task type chưa support: ${task.type}`);
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "UNKNOWN",
      error_message: `Loại task chưa support: ${task.type}`,
    });
    return { status: "task-not-supported", detail: task.type };
  }

  if (isLongOp) {
    await reportRunnerProgress(config, task.id, {
      phase: "opening_tab",
      message: "Đang tìm/mở tab chatgpt.com/admin...",
      current: 0,
      total: task.type === "HARVEST_LABELS" ? 18 : 100,
    });
  }
  const tab = await ensureAdminTab();
  if (!tab || tab.id === undefined) {
    console.warn(
      "[autogpt-runner] NOT_LOGGED_IN_CHATGPT — không mở được admin tab (chưa login ChatGPT trong browser này)",
    );
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "NOT_LOGGED_IN_CHATGPT",
      error_message:
        "Đã thử mở chatgpt.com/admin/members nhưng bị redirect — user chưa đăng nhập ChatGPT trong browser này. Hãy login rồi thử lại.",
    });
    return { status: "no-admin-tab" };
  }
  console.log(`[autogpt-runner] using admin tab ${tab.id} ${tab.url}`);

  if (isLongOp) {
    await reportRunnerProgress(config, task.id, {
      phase: "rate_limit",
      message: "Đang chờ rate-limit + inject content script...",
      current: 0,
      total: task.type === "HARVEST_LABELS" ? 18 : 100,
    });
  }
  await applyRateLimit();
  console.log(`[autogpt-runner] sending ${request.kind} to content script...`);
  let response = await sendToContent(tab.id, request);
  console.log(
    `[autogpt-runner] content script response: ok=${response.ok}`,
    response.ok ? "" : `err=${response.error_code}: ${response.error_message}`,
  );
  state.lastTaskAt = Date.now();
  state.tasksInBatch += 1;

  // ─── PHASE 2 INVITE: F5 + VERIFY ──────────────────────────────────────────
  // Content's Phase 1 (submit) trả `awaiting_reload_verify: true` → background
  // chrome.tabs.reload(tab) để ChatGPT BUỘC fetch lại pending list từ server
  // (KHÔNG cache React Query). Sau khi load xong + content re-inject, gửi
  // VERIFY_PENDING_INVITE → content scrape pending → trả về verify result.
  // Merge result → reportToBackend như invite COMPLETED bình thường.
  if (
    response.ok &&
    task.type === "INVITE_MEMBER" &&
    (response.data as { awaiting_reload_verify?: boolean } | undefined)?.awaiting_reload_verify === true &&
    request.kind === "INVITE_MEMBER"
  ) {
    console.log(`[autogpt-runner] invite submit OK — F5 tab ${tab.id} để verify pending list`);
    await reportRunnerProgress(config, task.id, {
      phase: "f5-verify",
      message: "Submit invite OK — F5 trang admin để ChatGPT load lại pending list...",
    });
    try {
      await chrome.tabs.reload(tab.id);
      const reloaded = await waitForTabComplete(tab.id, 20_000);
      if (!reloaded?.url?.includes("/admin")) {
        console.warn(
          `[autogpt-runner] F5 sau invite: tab redirect khỏi /admin (url=${reloaded?.url}) — verify skipped`,
        );
        // Vẫn coi như invite OK (submit thành công), nhưng đánh dấu scrape failed
        response = {
          ok: true,
          data: {
            ...((response as { ok: true; data?: Record<string, unknown> }).data ?? {}),
            verified_emails: [],
            unverified_emails: request.emails,
            pending_members: [],
            verify_scrape_failed: true,
          },
        };
      } else {
        // Re-inject content script vào tab vừa load
        const ready = await ensureContentInjected(tab.id);
        if (!ready.ok) {
          console.warn("[autogpt-runner] sau F5: content inject failed → verify skipped");
          response = {
            ok: true,
            data: {
              ...((response as { ok: true; data?: Record<string, unknown> }).data ?? {}),
              verified_emails: [],
              unverified_emails: request.emails,
              pending_members: [],
              verify_scrape_failed: true,
            },
          };
        } else {
          const verifyResp = await chrome.tabs.sendMessage(ready.tabId, {
            kind: "VERIFY_PENDING_INVITE",
            taskId: task.id,
            emails: request.emails,
            role: request.role,
          } satisfies ExecuteActionRequest);
          console.log(
            `[autogpt-runner] verify response: ok=${verifyResp?.ok}`,
            verifyResp?.ok ? "" : `err=${verifyResp?.error_code}: ${verifyResp?.error_message}`,
          );
          // Verify response thay thế response submit (đã merge emails/count/role)
          response = verifyResp as ExecuteActionResponse;
        }
      }
    } catch (e) {
      console.warn("[autogpt-runner] F5+verify FAILED — fallback ok với scrape failed:", e);
      response = {
        ok: true,
        data: {
          ...((response as { ok: true; data?: Record<string, unknown> }).data ?? {}),
          verified_emails: [],
          unverified_emails: request.emails,
          pending_members: [],
          verify_scrape_failed: true,
        },
      };
    }
  }

  await reportToBackend(config, task, response);

  // STALE_BUILD: task vừa được mark FAILED (immediate, không kẹt 5 phút). Giờ
  // self-heal reload EXTENSION để Chrome nạp build mới từ đĩa → task kế chạy được
  // ngay, không cần user reload tay. Đặt SAU reportToBackend để tránh limbo
  // IN_PROGRESS. reloadForStaleBuild() có guard count chống loop khi build hỏng.
  if (
    !response.ok &&
    (response as { error_code?: string }).error_code === "STALE_BUILD"
  ) {
    await reloadForStaleBuild("phát hiện khi gửi task tới content script");
    // reload kill SW ngay — return dưới có thể không chạy tới.
  }

  return {
    status: response.ok ? "done" : "task-failed",
    detail: response.ok ? undefined : (response as { error_code?: string }).error_code,
  };
}
