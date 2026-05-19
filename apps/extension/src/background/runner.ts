import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import {
  ApiError,
  bulkUpsertMembers,
  pickNextTask,
  postHarvestLabels,
  pushBillingSync,
  updateExtensionInfo,
  updateProgress,
  updateTask,
} from "../shared/api";
import { getConfig } from "../shared/storage";
import type { ExtensionConfig, QueueItem } from "../shared/types";

const RATE_LIMIT = {
  /** Min delay giữa 2 task bất kỳ (anti-detection). */
  betweenTasksMs: 5000,
  /** Số task chạy liên tục trước khi nghỉ batch. */
  batchSize: 5,
  /** Sleep min/max giữa 2 batch. */
  batchPauseMinMs: 30_000,
  batchPauseMaxMs: 60_000,
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
 *   Step 2: chrome.tabs.reload (F5 tab) → wait → retry ping ~5s
 *   Step 3: chrome.tabs.remove + chrome.tabs.create (NUCLEAR — tab mới hoàn toàn)
 *           → wait → retry ping ~5s
 *
 * Trả về:
 *   - { ok: true, tabId: N } — content script ready, có thể là tab khác nếu
 *     step 3 recreate. Caller phải dùng tabId mới.
 *   - { ok: false } — cả 3 step thất bại (rất hiếm: ChatGPT không login, hoặc
 *     extension permission bị block).
 */
async function ensureContentInjected(
  tabId: number,
): Promise<{ ok: boolean; tabId: number }> {
  if (await pingContent(tabId)) return { ok: true, tabId };

  // Step 1: executeScript inject loader
  const files = getChatGPTContentScriptFiles();
  if (files.length === 0) {
    console.warn(
      "[autogpt] không tìm thấy content_script chatgpt.com/admin trong manifest",
    );
    return { ok: false, tabId };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (e) {
    console.warn("[autogpt] executeScript failed:", e);
  }
  const RETRY_DELAYS_MS = [250, 500, 700, 800, 800];
  for (const delay of RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    if (await pingContent(tabId)) {
      console.log(`[autogpt] content script ready sau executeScript`);
      return { ok: true, tabId };
    }
  }

  // Step 2: AUTO-RELOAD tab
  console.warn("[autogpt] executeScript fail → AUTO-RELOAD tab...");
  try {
    await chrome.tabs.reload(tabId);
    const reloaded = await waitForTabComplete(tabId, 15_000);
    if (reloaded?.url?.includes("/admin")) {
      const POST_RELOAD_DELAYS_MS = [500, 800, 1000, 1200, 1500];
      for (const delay of POST_RELOAD_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        if (await pingContent(tabId)) {
          console.log(`[autogpt] ✓ content script ready sau AUTO-RELOAD`);
          return { ok: true, tabId };
        }
      }
    } else {
      console.warn(`[autogpt] sau reload tab không ở /admin (url=${reloaded?.url})`);
    }
  } catch (e) {
    console.warn("[autogpt] tabs.reload failed:", e);
  }

  // Step 3 NUCLEAR đã bị LOẠI BỎ trong v0.4.20 — đóng tab user rồi tạo lại
  // làm hỏng SPA state, gây regression INVITE (dialog không mở sau F5 + recreate).
  // Step 1 + Step 2 đã cover 99% case. Trường hợp còn lại (rất hiếm) sẽ trả
  // CONTENT_NOT_INJECTED → user F5 thủ công (rất hiếm sau v0.4.17 retry timing).
  console.warn(
    "[autogpt] Step 1 + Step 2 đều fail — give up. Tab user giữ nguyên.",
  );
  return { ok: false, tabId };
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
    return {
      ok: false,
      error_code: "CONTENT_NOT_INJECTED",
      error_message:
        "Tab chatgpt.com/admin không thể inject content script sau 3 bước fallback (executeScript / reload / recreate tab). " +
        "Có thể: (a) ChatGPT chưa login trong browser, (b) extension permission bị block. " +
        "Dashboard sẽ tự xoá record vừa tạo.",
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
      return {
        kind: "INVITE_MEMBER",
        taskId: task.id,
        emails,
        role: (p.role as "owner" | "admin" | "member") ?? "member",
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
    case "SYNC_DATA": {
      // Dashboard có thể truyền expected_locale ('vi' | 'en' | 'zh') trong
      // payload để extension check locale ChatGPT khớp chưa. Null = không check.
      const rawLocale = p.expected_locale;
      const expectedLocale: "vi" | "en" | "zh" | null =
        rawLocale === "vi" || rawLocale === "en" || rawLocale === "zh"
          ? rawLocale
          : null;
      return {
        kind: "SYNC_DATA",
        taskId: task.id,
        includePending: (p.include_pending as boolean | undefined) !== false,
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
      const includePending =
        (task.payload?.include_pending as boolean | undefined) !== false;
      const scrapedStatuses: Array<"active" | "pending"> = includePending
        ? ["active", "pending"]
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

      let mappedCount = 0;
      if (pending.length > 0) {
        try {
          for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
            const chunk = pending.slice(i, i + CHUNK_SIZE);
            await bulkUpsertMembers(config, task.workspace_id, chunk, {
              scrapedStatuses: ["pending"],
            });
            mappedCount += chunk.length;
          }
          console.log(
            `[autogpt-invite] verify+map: ${mappedCount} verified email được upsert`,
          );
        } catch (e) {
          console.warn(
            "[autogpt-invite] bulk-upsert verified pending FAILED — task vẫn COMPLETED:",
            e,
          );
        }
      }
      if (unverifiedEmails.length > 0) {
        console.warn(
          `[autogpt-invite] ${unverifiedEmails.length} email UNVERIFIED (KHÔNG tìm thấy trong tab Lời mời):`,
          unverifiedEmails,
        );
      }
      await updateTask(config, task.id, {
        status: "COMPLETED",
        result: {
          data: response.data ?? null,
          mapped_pending: mappedCount,
          verified_count: verifiedEmails.length,
          unverified_count: unverifiedEmails.length,
          unverified_emails: unverifiedEmails,
          verify_scrape_failed: verifyScrapeFailed,
        },
      });
      return;
    }

    await updateTask(config, task.id, {
      status: "COMPLETED",
      result: { data: response.data ?? null },
    });
  } else {
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
  const response = await sendToContent(tab.id, request);
  console.log(
    `[autogpt-runner] content script response: ok=${response.ok}`,
    response.ok ? "" : `err=${response.error_code}: ${response.error_message}`,
  );
  state.lastTaskAt = Date.now();
  state.tasksInBatch += 1;

  await reportToBackend(config, task, response);
  return {
    status: response.ok ? "done" : "task-failed",
    detail: response.ok ? undefined : response.error_code,
  };
}
