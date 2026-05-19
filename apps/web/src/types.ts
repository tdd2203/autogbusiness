export type BillingInvoice = {
  date: string; // ISO datetime
  amount_vnd: number;
  status: string; // "paid" | "unpaid" | "unknown"
};

export type Workspace = {
  id: string;
  name: string;
  chatgpt_id: string | null;
  plan: string | null;
  seat_total: number | null;
  seat_used: number | null;
  last_synced_at: string | null;
  chatgpt_user_email: string | null;
  chatgpt_user_name: string | null;
  last_extension_seen_at: string | null;
  billing_status: "PAID" | "UNPAID" | "UNKNOWN" | null;
  renewal_date: string | null;
  last_billing_synced_at: string | null;
  billing_invoices: BillingInvoice[] | null;
  created_at: string;
  updated_at: string;
};

export const SEAT_TOTAL_MAX = 999;

export type WorkspaceWithKey = Workspace & { extension_api_key: string };

export type WorkspaceSettings = {
  workspace_id: string;
  rate_limit_invite_ms: number;
  rate_limit_role_ms: number;
  rate_limit_remove_ms: number;
  dry_run_mode: boolean;
};

export type Member = {
  id: string;
  workspace_id: string;
  email: string;
  name: string | null;
  chatgpt_role: "owner" | "admin" | "member" | null;
  status: "active" | "pending" | "removed";
  invited_by_user_id: string | null;
  joined_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  /** Số tháng subscription admin set khi invite. NULL = không giới hạn. */
  subscription_months: number | null;
  /** Ngày hết hạn = created_at + months × 30. NULL nếu unlimited. */
  subscription_end_at: string | null;
};

export type QueueProgress = {
  phase?: string;
  current?: number;
  total?: number;
  message?: string;
  [k: string]: unknown;
};

export type QueueItem = {
  id: string;
  type: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  progress: QueueProgress | null;
  error_code: string | null;
  error_message: string | null;
  workspace_id: string | null;
  created_by_id: string | null;
  created_at: string;
  picked_at: string | null;
  completed_at: string | null;
};
