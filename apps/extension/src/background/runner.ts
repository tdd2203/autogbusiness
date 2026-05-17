import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import {
  ApiError,
  bulkUpsertMembers,
  pickNextTask,
  pushBillingSync,
  updateExtensionInfo,
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

async function pingContent(tabId: number): Promise<boolean> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { kind: "PING" });
    return Boolean(resp?.ok);
  } catch {
    return false;
  }
}

async function ensureContentInjected(tabId: number): Promise<boolean> {
  if (await pingContent(tabId)) return true;
  // Content script chưa có (extension reload sau khi tab đã load).
  // Thử inject manual qua chrome.scripting — file path là từ manifest content_scripts.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/index.ts"],
    });
  } catch (e) {
    console.warn("[autogpt] executeScript failed:", e);
  }
  // Đợi script init
  await new Promise((r) => setTimeout(r, 300));
  return pingContent(tabId);
}

async function sendToContent(
  tabId: number,
  request: ExecuteActionRequest,
): Promise<ExecuteActionResponse> {
  const ready = await ensureContentInjected(tabId);
  if (!ready) {
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message:
        "Content script chưa inject. Hãy REFRESH (F5) tab chatgpt.com/admin và thử lại.",
    };
  }
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: `Lỗi gửi message tới content script: ${msg}. Thử refresh tab chatgpt.com.`,
    };
  }
}

function taskToRequest(task: QueueItem): ExecuteActionRequest | null {
  const p = task.payload;
  switch (task.type) {
    case "INVITE_MEMBER":
      return {
        kind: "INVITE_MEMBER",
        taskId: task.id,
        email: String(p.email ?? ""),
        role: (p.role as "owner" | "admin" | "member") ?? "member",
      };
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
    case "SYNC_DATA":
      return { kind: "SYNC_DATA", taskId: task.id };
    case "SYNC_BILLING":
      return { kind: "SYNC_BILLING", taskId: task.id };
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

    // Special case: SYNC_DATA mang theo members → chunked bulk-upsert.
    if (task.type === "SYNC_DATA" && task.workspace_id) {
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
      try {
        for (let i = 0; i < members.length; i += CHUNK_SIZE) {
          const chunk = members.slice(i, i + CHUNK_SIZE);
          const result = await bulkUpsertMembers(
            config,
            task.workspace_id,
            chunk,
          );
          totalCreated += result.created;
          totalUpdated += result.updated;
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

      await updateTask(config, task.id, {
        status: "COMPLETED",
        result: {
          total: members.length,
          created: totalCreated,
          updated: totalUpdated,
          chunks: Math.ceil(members.length / CHUNK_SIZE),
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

  const tab = await findAdminTab();
  if (!tab || tab.id === undefined) {
    console.warn(
      "[autogpt-runner] NOT_LOGGED_IN_CHATGPT — không có tab khớp chatgpt.com/admin/*",
    );
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "NOT_LOGGED_IN_CHATGPT",
      error_message:
        "Không tìm thấy tab nào đang mở chatgpt.com/admin/*. Hãy mở admin page rồi thử lại.",
    });
    return { status: "no-admin-tab" };
  }
  console.log(`[autogpt-runner] found admin tab ${tab.id} ${tab.url}`);

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
