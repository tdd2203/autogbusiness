import type { ExtensionConfig, QueueItem, Workspace } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

async function request<T>(
  config: ExtensionConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("X-API-KEY", config.apiKey);

  const res = await fetch(`${config.apiBaseUrl}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, data?.detail ?? data ?? res.statusText);
  }
  return data as T;
}

export async function whoami(config: ExtensionConfig): Promise<Workspace> {
  return request<Workspace>(config, "/api/v1/workspaces/whoami");
}

export async function updateExtensionInfo(
  config: ExtensionConfig,
  info: { email?: string | null; name?: string | null },
): Promise<void> {
  await request(config, "/api/v1/workspaces/extension-info", {
    method: "POST",
    body: JSON.stringify(info),
  });
}

export async function countPendingTasks(
  config: ExtensionConfig,
): Promise<number> {
  const resp = await request<{ count: number }>(
    config,
    "/api/v1/queue/pending-count",
  );
  return resp.count;
}

export type ActiveTaskInfo = {
  in_progress: {
    id: string;
    type: string;
    status: string;
    progress: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    error_code: string | null;
    error_message: string | null;
    created_at: string | null;
    picked_at: string | null;
    completed_at: string | null;
  } | null;
  pending_count: number;
  recent_completed: ActiveTaskInfo["in_progress"];
  workspace_id: string;
};

export async function fetchActiveTask(
  config: ExtensionConfig,
): Promise<ActiveTaskInfo> {
  return request<ActiveTaskInfo>(config, "/api/v1/queue/active");
}

/**
 * Popup trigger SYNC_BILLING task để refresh workspace.seat_used từ ChatGPT
 * /admin/billing. Backend dedup nếu đã có SYNC_BILLING PENDING/IN_PROGRESS.
 */
export async function triggerSyncBilling(
  config: ExtensionConfig,
): Promise<{ queue_item_id: string; status: string; deduplicated: boolean }> {
  return request<{
    queue_item_id: string;
    status: string;
    deduplicated: boolean;
  }>(config, "/api/v1/queue/sync-billing", { method: "POST" });
}

export async function pickNextTask(
  config: ExtensionConfig,
): Promise<QueueItem | null> {
  return request<QueueItem | null>(config, "/api/v1/queue/next");
}

export async function updateTask(
  config: ExtensionConfig,
  itemId: string,
  body: {
    status: "COMPLETED" | "FAILED";
    result?: Record<string, unknown> | null;
    error_code?: string | null;
    error_message?: string | null;
  },
): Promise<void> {
  await request(config, `/api/v1/queue/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function updateProgress(
  config: ExtensionConfig,
  itemId: string,
  progress: Record<string, unknown>,
): Promise<void> {
  await request(config, `/api/v1/queue/${itemId}/progress`, {
    method: "PATCH",
    body: JSON.stringify({ progress }),
  });
}

export async function pushBillingSync(
  config: ExtensionConfig,
  billing: {
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
  },
): Promise<Workspace> {
  return request<Workspace>(config, "/api/v1/workspaces/billing-sync", {
    method: "POST",
    body: JSON.stringify(billing),
  });
}

export async function postHarvestLabels(
  config: ExtensionConfig,
  body: {
    locale: "vi" | "en" | "zh";
    pages: Array<{
      page: string;
      labels: Array<{
        control_key: string;
        label_text?: string | null;
        aria_label?: string | null;
      }>;
    }>;
  },
): Promise<{ locale: string; total: number; pages: Record<string, number> }> {
  return request(config, "/api/v1/ui-labels/harvest", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function bulkUpsertMembers(
  config: ExtensionConfig,
  workspaceId: string,
  members: Array<{
    email: string;
    name?: string | null;
    chatgpt_role?: "owner" | "admin" | "member" | null;
    status?: "active" | "pending" | "removed";
  }>,
  options?: {
    scrapedStatuses?: Array<"active" | "pending">;
    /**
     * `false` = chỉ upsert members trong payload, KHÔNG reconcile/mark removed
     * cho members ngoài payload. Bắt buộc dùng `false` khi scrape kết quả của
     * 1 thao tác cụ thể (vd verify-pending sau INVITE) để tránh xoá nhầm
     * members khác cùng status. Default true (sync full).
     */
    isFullSync?: boolean;
  },
): Promise<{
  created: number;
  updated: number;
  total: number;
  rogue_pending_emails?: string[];
}> {
  return request(
    config,
    `/api/v1/workspaces/${workspaceId}/members/bulk-upsert`,
    {
      method: "POST",
      body: JSON.stringify({
        members,
        scraped_statuses: options?.scrapedStatuses,
        is_full_sync: options?.isFullSync !== false,
      }),
    },
  );
}
