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

export async function bulkUpsertMembers(
  config: ExtensionConfig,
  workspaceId: string,
  members: Array<{
    email: string;
    name?: string | null;
    chatgpt_role?: "owner" | "admin" | "member" | null;
    status?: "active" | "pending" | "removed";
  }>,
  options?: { scrapedStatuses?: Array<"active" | "pending"> },
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
      }),
    },
  );
}
