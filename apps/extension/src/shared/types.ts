export type ExtensionConfig = {
  apiBaseUrl: string;
  /** Khoá API của workspace ChatGPT. Giữ nguyên tên cũ — mọi code nhánh GPT đọc
   *  trường này, đổi tên là phải sửa cả runner 3.7k dòng cho không được gì. */
  apiKey: string;
  /** Khoá API của team CANVA (user 2026-09-01: một Chrome chạy cả hai nhánh).
   *  Vắng mặt = máy này không chạy Canva; nhánh ChatGPT hoạt động y như trước. */
  canvaApiKey?: string;
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
    | "SYNC_MEMBER"
    | "SYNC_MEMBERS_BATCH"
    | "CHANGE_ROLE"
    | "CHANGE_LICENSE_TYPE"
    | "SET_USAGE_LIMIT"
    | "EXPORT_MEMBER_DATA"
    | "DELETE_MEMBER_DATA"
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
