/**
 * Ví (feature 003-wallet-invite-payment) — kiểu dữ liệu + helper định dạng tiền.
 */

import { ApiError } from "./api";

export type Wallet = {
  balance: number;
  held: number;
  total: number;
  wallet_beta: boolean;
  invite_fee_vnd: number;
};

export type WalletTxnKind =
  | "topup"
  | "order_topup"
  | "invite_fee"
  | "invite_refund"
  | "renew_fee"
  | "withdraw_hold"
  | "withdraw_settle"
  | "withdraw_refund"
  | "adjust";

export type WalletTxn = {
  id: string;
  kind: WalletTxnKind;
  amount: number;
  balance_after: number;
  held_after: number;
  ref_type: string | null;
  ref_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type TopupCreated = {
  id: string;
  ref_code: string;
  amount_vnd: number;
  status: "pending" | "paid" | "expired";
  paid_amount_vnd: number | null;
  created_at: string;
  paid_at: string | null;
  note: string;
  bank_name: string | null;
  account_number: string | null;
  account_name: string | null;
  qr_url: string | null;
};

export type Topup = {
  id: string;
  ref_code: string;
  amount_vnd: number;
  status: "pending" | "paid" | "expired";
  paid_amount_vnd: number | null;
  created_at: string;
  paid_at: string | null;
};

/** Hoá đơn QR trả trong lỗi 402 PAYMENT_QR_REQUIRED (mời/gia hạn khi ví thiếu). */
export type OrderQr = {
  id: string;
  ref_code: string;
  kind: "invite" | "renew" | "subscription";
  amount_vnd: number;
  status: string;
  note: string;
  bank_name: string | null;
  account_number: string | null;
  account_name: string | null;
  qr_url: string | null;
  /** ISO lúc tạo hoá đơn — FE dựng đếm ngược 10 phút (mã QR chỉ tồn tại 10 phút). */
  created_at: string | null;
};

/** Trạng thái hoá đơn (poll). */
export type PaymentOrder = {
  id: string;
  ref_code: string;
  kind: "invite" | "renew" | "subscription";
  amount_vnd: number;
  status: "pending" | "paid" | "cancelled" | "expired";
  paid_amount_vnd: number | null;
  queue_item_id: string | null;
  member_id: string | null;
  fulfillment_error: string | null;
  created_at: string;
  paid_at: string | null;
};

/** Trích hoá đơn QR từ lỗi 402 PAYMENT_QR_REQUIRED (ví thiếu → cần quét QR); null nếu không phải. */
export function getQrOrder(e: unknown): OrderQr | null {
  if (
    e instanceof ApiError &&
    e.status === 402 &&
    e.detail &&
    typeof e.detail === "object"
  ) {
    const d = e.detail as { code?: string; order?: OrderQr };
    if (d.code === "PAYMENT_QR_REQUIRED" && d.order) return d.order;
  }
  return null;
}

export type Withdrawal = {
  id: string;
  amount_vnd: number;
  bank_account: string;
  status: "pending" | "settled" | "rejected";
  note: string | null;
  reject_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
};

export type WithdrawalAdmin = Withdrawal & {
  user_id: string;
  username: string | null;
  user_email: string | null;
};

export type PaymentCodeFlow = {
  key: string;
  label: string;
  prefix: string;
  suffix_min: number;
  suffix_max: number;
  suffix_type: "numeric" | "alphanumeric";
  enabled: boolean;
};

export type SepayAuthMethod = "none" | "apikey" | "hmac";

export type PaymentSettings = {
  invite_fee_vnd: number;
  bank_name: string | null;
  account_number: string | null;
  account_name: string | null;
  code_prefix: string;
  amount_tolerance_vnd: number;
  payment_codes: PaymentCodeFlow[];
  sepay_auth_method: SepayAuthMethod;
  sepay_apikey_configured: boolean;
  sepay_hmac_secret_configured: boolean;
  sepay_webhook_configured: boolean;
  webhook_url: string;
};

export type WalletAdminUser = {
  user_id: string;
  username: string;
  email: string;
  wallet_beta: boolean;
  is_super_admin: boolean;
  balance: number;
  held: number;
  /** Phí mời mặc định RIÊNG của user (đại lý). null = dùng phí mặc định hệ thống. */
  invite_fee_vnd: number | null;
};

// ── Báo cáo tài chính (super-admin) ─────────────────────────────────────────

export type FinancialReportBucket = {
  month: string; // "YYYY-MM"
  revenue: number;
  cost: number;
  profit: number;
};

export type FinancialReportAgent = {
  /** null = nhóm "chưa có chủ" (member không gắn chủ sở hữu). */
  user_id: string | null;
  username: string | null;
  email: string | null;
  revenue: number;
  invite_count: number;
  renew_count: number;
};

export type FinancialReport = {
  from_date: string;
  to_date: string;
  revenue: number;
  revenue_invite: number;
  revenue_renew: number;
  cost: number;
  profit: number;
  monthly: FinancialReportBucket[];
  by_agent: FinancialReportAgent[];
  /** Số workspace chưa đồng bộ hoá đơn → giá vốn (CHI) có thể thiếu. */
  cost_missing_workspaces: number;
  /** Seat-tháng DỒN TÍCH có thu trong kỳ = Σ seat-ngày ÷ 30 (thập phân; mẫu số của giá vốn TB/seat). */
  seat_months: number;
  /** Giá vốn TB mỗi seat/tháng = cost ÷ seat_months. null khi chưa có seat-tháng nào. */
  avg_cost_per_seat: number | null;
};

/** Định dạng VND: 100000 → "100.000 ₫". */
export function formatVnd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(Math.round(amount));
  return `${sign}${abs.toLocaleString("vi-VN")} ₫`;
}

/** Nhãn ngắn cho từng loại giao dịch (fallback nếu chưa có i18n key). */
export const TXN_KIND_LABEL: Record<WalletTxnKind, string> = {
  topup: "Nạp tiền",
  order_topup: "Nạp qua hoá đơn",
  invite_fee: "Phí mời",
  invite_refund: "Hoàn phí mời",
  renew_fee: "Phí gia hạn",
  withdraw_hold: "Giữ rút tiền",
  withdraw_settle: "Rút tiền (đã chi)",
  withdraw_refund: "Hoàn rút tiền",
  adjust: "Điều chỉnh",
};
