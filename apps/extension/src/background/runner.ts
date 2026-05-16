import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
} from "../shared/messages";
import {
  ApiError,
  bulkUpsertMembers,
  pickNextTask,
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

async function sendToContent(
  tabId: number,
  request: ExecuteActionRequest,
): Promise<ExecuteActionResponse> {
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error_code: "UNKNOWN",
      error_message: `Lỗi gửi message tới content script: ${msg}`,
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
      return null; // Tuần 7
    default:
      return null;
  }
}

async function reportToBackend(
  config: ExtensionConfig,
  task: QueueItem,
  response: ExecuteActionResponse,
): Promise<void> {
  if (response.ok) {
    // Special case: SYNC_DATA mang theo members → bulk-upsert trước khi báo COMPLETED.
    if (task.type === "SYNC_DATA" && task.workspace_id) {
      const data = response.data as { members?: Array<Record<string, unknown>> } | undefined;
      const members = (data?.members ?? []) as Array<{
        email: string;
        name?: string | null;
        chatgpt_role?: "owner" | "admin" | "member" | null;
        status?: "active" | "pending" | "removed";
      }>;
      try {
        await bulkUpsertMembers(config, task.workspace_id, members);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateTask(config, task.id, {
          status: "FAILED",
          error_code: "BULK_UPSERT_FAILED",
          error_message: msg,
        });
        return;
      }
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

export async function runOnce(): Promise<{ status: string; detail?: string }> {
  const config = await getConfig();
  if (!config) return { status: "no-config" };

  let task: QueueItem | null;
  try {
    task = await pickNextTask(config);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      return { status: "unauthorized", detail: "API key sai" };
    }
    return { status: "network-error", detail: String(e) };
  }
  if (!task) return { status: "idle" };

  console.log(`[autogpt] task ${task.type} ${task.id}`);

  const request = taskToRequest(task);
  if (!request) {
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "UNKNOWN",
      error_message: `Loại task chưa support: ${task.type}`,
    });
    return { status: "task-not-supported", detail: task.type };
  }

  const tab = await findAdminTab();
  if (!tab || tab.id === undefined) {
    await updateTask(config, task.id, {
      status: "FAILED",
      error_code: "NOT_LOGGED_IN_CHATGPT",
      error_message:
        "Không tìm thấy tab nào đang mở chatgpt.com/admin/*. Hãy mở admin page rồi thử lại.",
    });
    return { status: "no-admin-tab" };
  }

  await applyRateLimit();
  const response = await sendToContent(tab.id, request);
  state.lastTaskAt = Date.now();
  state.tasksInBatch += 1;

  await reportToBackend(config, task, response);
  return {
    status: response.ok ? "done" : "task-failed",
    detail: response.ok ? undefined : response.error_code,
  };
}
