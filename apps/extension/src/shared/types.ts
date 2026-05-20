export type ExtensionConfig = {
  apiBaseUrl: string;
  apiKey: string;
};

export type Workspace = {
  id: string;
  name: string;
  chatgpt_id: string | null;
  plan: string | null;
  seat_total: number | null;
  seat_used: number | null;
  last_synced_at: string | null;
  billing_status: "PAID" | "UNPAID" | "UNKNOWN" | null;
  renewal_date: string | null;
  last_billing_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type QueueItem = {
  id: string;
  type:
    | "INVITE_MEMBER"
    | "REMOVE_MEMBER"
    | "CHANGE_ROLE"
    | "SYNC_DATA"
    | "SYNC_BILLING"
    | "REVOKE_INVITES"
    | "HARVEST_LABELS"
    | "PURCHASE_SEAT";
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  payload: Record<string, unknown>;
  workspace_id: string | null;
  created_at: string;
  picked_at: string | null;
};

export type ConnectionStatus =
  | { state: "disconnected"; message?: string }
  | { state: "checking" }
  | { state: "connected"; workspace: Workspace }
  | { state: "error"; message: string };
