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
  verified_domain: string | null;
  created_at: string;
  updated_at: string;
};

export const SEAT_TOTAL_MAX = 999;

export type WorkspaceWithKey = Workspace & { extension_api_key: string };

/** 1 sub-admin được gán (sở hữu) 1 workspace. */
export type WorkspaceAssignment = {
  user_id: string;
  email: string;
  username: string;
  is_active: boolean;
  created_at: string;
};

/** Thống kê member workspace cho user được gán (xem GET .../members/stats). */
export type WorkspaceMemberStats = {
  total: number;
  active: number;
  pending: number;
  seat_total: number | null;
  seat_used: number | null;
  own_count: number;
};

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
  /** Loại suất cấp phép ChatGPT: "ChatGPT" | "Codex". null nếu chưa scrape. */
  license_type: "ChatGPT" | "Codex" | null;
  status: "active" | "pending" | "removed";
  invited_by_user_id: string | null;
  joined_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  /** Lần CUỐI invite/re-invite qua dashboard. NULL nếu member chỉ từ SYNC.
   *  Cột "Ngày thêm" hiển thị last_invited_at ?? created_at để khớp Queue. */
  last_invited_at: string | null;
  /** Số tháng subscription admin set khi invite. NULL = không giới hạn. */
  subscription_months: number | null;
  /** Ngày hết hạn = created_at + months × 30. NULL nếu unlimited. */
  subscription_end_at: string | null;
  /** Theo dõi thanh toán (Dashboard-only): "unpaid" | "paid". */
  payment_status: "unpaid" | "paid";
  /** Thời điểm duyệt thanh toán. NULL nếu chưa thanh toán. */
  paid_at: string | null;
};

/** 1 dòng trong tab "Email đã add" — Member gom xuyên workspace, kèm tên workspace. */
export type AddedMember = Member & {
  workspace_name: string | null;
  /** Username chủ sở hữu (sub-admin/admin). null = email còn lại (chưa chủ). */
  invited_by_username: string | null;
};

/** 1 mốc chuyển phase do backend ghi (giờ server ISO-8601). Xem update_progress. */
export type PhaseMark = {
  phase: string;
  at: string;
};

export type QueueProgress = {
  phase?: string;
  current?: number;
  total?: number;
  message?: string;
  // Timeline các phase đã chạy (chỉ append khi phase đổi) → dashboard tính thời
  // lượng từng giai đoạn. Backend (update_progress) duy trì, không cần migration.
  history?: PhaseMark[];
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
  // Tên người tạo task — chỉ super-admin nhận giá trị; sub-admin luôn null (ẩn).
  created_by_username: string | null;
  // Người xem hiện tại có quyền huỷ task này không (super OR creator). Backend tính.
  can_cancel?: boolean;
  created_at: string;
  picked_at: string | null;
  completed_at: string | null;
};
