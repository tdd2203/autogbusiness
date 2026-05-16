export type Workspace = {
  id: string;
  name: string;
  chatgpt_id: string | null;
  plan: string | null;
  seat_total: number | null;
  seat_used: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

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
};

export type QueueItem = {
  id: string;
  type: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  workspace_id: string | null;
  created_by_id: string | null;
  created_at: string;
  picked_at: string | null;
  completed_at: string | null;
};
