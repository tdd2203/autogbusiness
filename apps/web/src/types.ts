export type BillingInvoice = {
  date: string; // ISO datetime
  amount_vnd: number;
  status: string; // "paid" | "unpaid" | "void" | "unknown"
  // Chi tiết đọc chính xác từ trang hoá đơn Stripe (detail_scraped=true).
  // Optional để tương thích ngược với hoá đơn cũ (chỉ date/amount_vnd/status).
  detail_scraped?: boolean;
  detail_url?: string | null;
  quantity?: number | null; // số seat trên hoá đơn
  unit_price_vnd?: number | null; // đơn giá/seat pre-VAT ("Mỗi X đ")
  subtotal_vnd?: number | null; // Tổng phụ (pre-VAT)
  vat_vnd?: number | null;
  total_vnd?: number | null; // Số tiền đến hạn
  period_start?: string | null; // ISO date — đầu chu kỳ dịch vụ
  period_end?: string | null; // ISO date — cuối chu kỳ = renewal
  invoice_number?: string | null;
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
  /** Ngân sách tín dụng/tháng admin cấp cho sub-admin này trong workspace này (0 = chưa cấp). */
  credit_budget: number;
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
  /** Ngày hết hạn (Model B 2026-07-06): = subscription_purchased_at (mốc gia hạn) +
   *  months×30 ngày CHÍNH XÁC tới giây (KHÔNG chốt cuối ngày, KHÔNG −1). Gia hạn = hạn
   *  cũ + months×30. Chế độ "ngày cụ thể" đặt thẳng giá trị này. NULL = vô thời hạn. */
  subscription_end_at: string | null;
  /** "Ngày mua" (mốc neo) admin đặt trong modal Đổi hạn. NULL = chưa đặt → UI mặc định
   *  về ngày thêm log (last_invited_at ?? created_at). Hạn = ngày mua + months×30. */
  subscription_purchased_at: string | null;
  /** Giới hạn tín dụng/tháng đặt cho member (NULL = chưa đặt; 0 = chặn). */
  usage_limit_credits: number | null;
  /** Theo dõi thanh toán (Dashboard-only), duyệt 2 bước:
   *  "unpaid" → "requested" (sub-admin gửi yêu cầu) → "paid" (admin xác nhận). */
  payment_status: "unpaid" | "requested" | "paid";
  /** Thời điểm sub-admin gửi yêu cầu duyệt (bước 1). NULL nếu chưa gửi. */
  payment_requested_at: string | null;
  /** Thời điểm super-admin xác nhận thanh toán (bước 2). NULL nếu chưa. */
  paid_at: string | null;
  /** Duyệt đổi hạn dùng: "none" | "requested" (sub-admin gửi, chờ admin duyệt). */
  subscription_request_status: "none" | "requested";
  /** Giá trị đề xuất chờ duyệt (chỉ có khi status="requested"). */
  pending_subscription_months: number | null;
  pending_subscription_end_at: string | null;
  subscription_requested_at: string | null;
  /** [DEPRECATED] cột cũ của tính năng đồng bộ ngày thêm ChatGPT — đã gỡ, không dùng. */
  add_date_corrected_at: string | null;
};

/** 1 dòng lịch sử audit của 1 member (panel chi tiết khi click email).
 *  Khớp `AuditLogOut` backend — xem members/activity.py. */
export type MemberLog = {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  result: string;
  target_type: string | null;
  target_id: string | null;
  data: Record<string, unknown> | null;
};

/** 1 chu kỳ gia hạn của member — lịch sử + trạng thái thanh toán theo kỳ.
 *  Khớp SubscriptionCycleOut backend. */
export type SubscriptionCycle = {
  id: string;
  cycle_number: number;
  months: number | null;
  start_at: string | null;
  end_at: string | null;
  /** Thanh toán RIÊNG cho từng chu kỳ: "unpaid" → "requested" → "paid". */
  payment_status: "unpaid" | "requested" | "paid";
  payment_requested_at: string | null;
  paid_at: string | null;
};

/** 1 dòng trong tab "Email đã add" — Member gom xuyên workspace, kèm tên workspace. */
export type AddedMember = Member & {
  workspace_name: string | null;
  /** Username chủ sở hữu (sub-admin/admin). null = email còn lại (chưa chủ). */
  invited_by_username: string | null;
  /** Lịch sử chu kỳ gia hạn (sắp theo cycle_number). Rỗng nếu chưa gia hạn lần nào. */
  cycles: SubscriptionCycle[];
};

/** 1 thông báo "chờ duyệt thanh toán" cho super-admin (dropdown chuông). */
export type PaymentRequestNotice = {
  member_id: string;
  email: string;
  workspace_name: string | null;
  /** Người gửi yêu cầu (sub-admin). null nếu dữ liệu cũ thiếu. */
  requested_by_username: string | null;
  requested_at: string | null;
};

/** 1 thông báo "chờ duyệt đổi hạn dùng" cho admin. Khớp SubscriptionRequestNotice BE. */
export type SubscriptionRequestNotice = {
  member_id: string;
  email: string;
  workspace_name: string | null;
  requested_by_username: string | null;
  requested_at: string | null;
  /** Hạn hiện tại (đang áp dụng) và hạn đề xuất chờ duyệt — để admin so sánh. */
  current_end_at: string | null;
  requested_end_at: string | null;
  requested_months: number | null;
};

/** 1 mốc chuyển phase do backend ghi (giờ server ISO-8601). Xem update_progress. */
type PhaseMark = {
  phase: string;
  at: string;
};

type QueueProgress = {
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
  // Duyệt lệnh: null = không cần duyệt; "pending" = chờ super-admin; "approved";
  // "rejected". Chỉ task sub-admin tạo cần duyệt (vd SET_USAGE_LIMIT) mới != null.
  approval_status?: "pending" | "approved" | "rejected" | null;
  approved_at?: string | null;
  created_at: string;
  picked_at: string | null;
  completed_at: string | null;
};
