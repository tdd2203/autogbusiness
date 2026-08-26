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
  /** Chỉ có ở `invite_fee`: true ⇔ phí đã được hoàn (lượt mời hỏng). */
  reversed?: boolean;
  created_at: string;
};

/** Báo cáo 1 ngày (giờ VN) của chính user — GET /api/v1/wallet/daily-summary. */
export type WalletDailyKind = {
  kind: WalletTxnKind | string;
  count: number;
  /** Tổng tiền CÓ DẤU của loại bút toán này trong ngày. */
  amount: number;
};

export type WalletDailySummary = {
  date: string; // YYYY-MM-DD
  /** Email thêm trong ngày và CÒN trong team. */
  emails_added: number;
  /** Email thêm trong ngày nhưng đã rời (mời hỏng, thu hồi, bị xoá…). */
  emails_removed: number;
  txn_count: number;
  /** Tổng phí mời + gia hạn phát sinh trong ngày (số dương), KỂ CẢ lượt đã hoàn. */
  fee_total: number;
  /** Phần `fee_total` đã hoàn lại vì mời hỏng — không tính là tiêu. */
  fee_refunded: number;
  /** THỰC CHI trong ngày = fee_total − fee_refunded. */
  fee_net: number;
  /** Phần thực chi trả thẳng qua hoá đơn (không trừ số dư ví). */
  fee_from_invoice: number;
  /** Phần thực chi trừ từ số dư ví. */
  fee_from_balance: number;
  invite_count: number;
  /** Số lượt mời trong ngày bị hỏng và đã hoàn phí. */
  refunded_invite_count: number;
  renew_count: number;
  /** Tiền nạp vào ví qua chuyển khoản trong ngày. */
  topup_total: number;
  /** Tiền hoàn do mời thất bại. */
  refund_total: number;
  by_kind: WalletDailyKind[];
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
  /** Số hoá đơn trong kỳ chưa có chi tiết (period_*) nên chưa vào CHI. */
  cost_skipped_invoices: number;
  /** Số tháng có thu mà chi = 0 → lãi tháng đó là ảo (hoá đơn trước mốc bị loại). */
  months_no_cost: number;
  /** Seat-tháng ĐÃ BÁN trong kỳ = Σ months của các chu kỳ thu được tiền. */
  seat_months: number;
  /** Giá BÁN TB mỗi seat/tháng = revenue ÷ seat_months. null khi chưa bán được kỳ nào. */
  avg_price_per_seat: number | null;
  /** Ghế·tháng ChatGPT thu tiền = Σ (subtotal hoá đơn ÷ đơn giá/ghế/tháng), 1 kỳ = 1 tháng. */
  billed_seat_months: number;
  /** Phí seat thực tế mỗi ghế/tháng = tiền hoá đơn ÷ billed_seat_months (đã quy 30 ngày). */
  avg_seat_cost: number | null;
};

/**
 * 1 chu kỳ thanh toán ChatGPT — gộp MỌI hoá đơn cùng `period_end`: hoá đơn gia hạn mở
 * kỳ + các hoá đơn mua thêm suất giữa kỳ. CHI là TRỌN tiền đã trả, không chia ngày.
 */
export type FinancialCycle = {
  workspace: string;
  period_start: string;
  period_end: string;
  days: number;
  days_elapsed: number;
  in_progress: boolean;
  /** Ghế CUỐI kỳ (quantity lớn nhất trong các hoá đơn của kỳ). */
  seats: number | null;
  /** Ghế ĐẦU kỳ (quantity của hoá đơn gia hạn). Khác `seats` = kỳ có mua thêm ghế. */
  seats_start: number | null;
  cost: number;
  revenue: number;
  profit: number;
  /** Công suất đã trả tiền = ghế CUỐI kỳ × ngày ÷ 30. So seat_months ra tỷ lệ lấp đầy. */
  capacity_seat_months: number | null;
  /** Đã BÁN được (Σ seat-ngày có thu ÷ 30). */
  seat_months: number;
};

export type FinancialCycles = {
  cycles: FinancialCycle[];
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
