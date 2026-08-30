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
  | "cycle_fee"
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
  /** Mã nạp / mã hoá đơn in trên QR — đúng mã hiện trên web. Chỉ bút toán trỏ về
   *  topup_orders / payment_orders mới có; phí mời lấy theo cụm (xem wallet-report). */
  ref_code?: string | null;
  /** Mã giao dịch bên SePay, khớp sao kê ngân hàng. */
  provider_txn_id?: string | null;
  created_at: string;
};

/**
 * Bút toán KÈM dữ liệu đối soát — chỉ endpoint super-admin trả về
 * (GET /wallet/admin/users/{id}/transactions).
 *
 * Trang Ví của người dùng cố ý gom nhóm cho dễ đọc; trang quản trị cần lần được
 * từ khoản tiền ra tận hoá đơn, lệnh trong hàng đợi và người bấm nút. Backend tra
 * sẵn ở `_enrich_txns` (routers/wallet/admin.py) để FE khỏi gọi thêm.
 */
export type WalletTxnAdmin = WalletTxn & {
  /** Khoá sắp xếp thật của sổ cái — `created_at` trùng nhau trong cùng transaction. */
  seq: number;
  /** Email người bấm nút; null ⇔ hệ thống (webhook ngân hàng, job hoàn phí). */
  actor_email: string | null;
  /** Mã in trên nội dung chuyển khoản (mã nạp / mã hoá đơn). */
  ref_code: string | null;
  /** Trạng thái của thứ `ref_id` trỏ tới (hoá đơn paid/expired, task COMPLETED…). */
  ref_status: string | null;
  queue_item_id: string | null;
  queue_item_type: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  member_email: string | null;
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
  /** Email vào đội LẦN ĐẦU trong ngày. Đổi email là thay thế nên vẫn tính 1. */
  added_new_count: number;
  /** Email CŨ trả tiền tiếp: gia hạn thêm tháng, hoặc hết hạn rồi add lại. */
  added_renew_count: number;
  /** Mời lại email còn hạn — miễn phí, không phải add mới lẫn gia hạn. */
  added_free_reinvite_count: number;
  /** TỔNG lời mời tính phí trong ngày, đếm theo EMAIL (dán 5 email = 5 lời mời). */
  invite_count: number;
  /** Số lượt mời trong ngày bị hỏng và đã hoàn phí (phần KHÔNG thành công). */
  refunded_invite_count: number;
  renew_count: number;
  /** Lượt trả tiền thành công cho email CHƯA TỪNG trả tiền lần nào (ô "New"). */
  new_email_count: number;
  /** Lượt trả tiền cho email CŨ: gia hạn, hoặc hết hạn rồi add lại (ô "Renew"). */
  renew_email_count: number;
  /** Tiền nạp vào ví qua chuyển khoản trong ngày. */
  topup_total: number;
  /** Tiền hoàn do mời thất bại. */
  refund_total: number;
  by_kind: WalletDailyKind[];
};

/* ── Đối soát ngân hàng (dữ liệu SePay báo về) ─────────────────────────────── */

/**
 * Kết luận của MỘT giao dịch ngân hàng trong sổ nhận tiền:
 *   credited     — đã cộng vào ví
 *   dup_invoice  — trả trùng hoá đơn, tiền cộng thẳng vào ví
 *   duplicate    — webhook lặp của khoản đã cộng (không cộng lần 2)
 *   declined     — khớp mã nhưng bị từ chối (lệch tiền, hoá đơn không tồn tại…)
 *   unmatched    — nội dung CK không chứa mã nạp/hoá đơn nào
 *   bank_only    — sao kê có, nhưng không thấy vết nào trong ví (webhook chưa từng tới)
 *   ignored      — tiền ra / IPN test
 *   unauthorized — request sai chữ ký (kẻ lạ, hoặc secret đang lệch)
 *   error        — đã cộng ví nhưng bước thực thi lỗi
 */
export type SepayResult =
  | "credited"
  | "dup_invoice"
  | "duplicate"
  | "declined"
  | "unmatched"
  | "bank_only"
  | "ignored"
  | "unauthorized"
  | "error";

export type SepayEvent = {
  id: string;
  /** webhook = SePay bắn tới; userapi = mình kéo sao kê về. */
  source: "webhook" | "userapi" | string;
  provider_txn_id: string | null;
  amount: number;
  content: string | null;
  transfer_type: "in" | "out" | string | null;
  account_number: string | null;
  bank: string | null;
  flow: "topup" | "order" | string | null;
  code: string | null;
  result: SepayResult | string;
  note: string | null;
  /** Giờ ngân hàng ghi nhận; null thì lấy `received_at`. */
  bank_time: string | null;
  received_at: string;
};

export type SepayDay = {
  date: string; // YYYY-MM-DD
  /** Tiền VÀO theo ngân hàng — sự thật bên ngoài để đối chiếu. */
  received_total: number;
  /** Phần đã ghi nhận vào ví. */
  credited_total: number;
  /** Tiền vào ngân hàng nhưng CHƯA vào ví (sai nội dung, lệch tiền, webhook không tới). */
  pending_total: number;
  received_count: number;
  credited_count: number;
  pending_count: number;
  /** Chưa có dòng nào trong sổ ngày này. */
  empty: boolean;
  /** Super-admin đang xem toàn bộ tiền vào (false = chỉ phần của mình). */
  is_admin_view: boolean;
  /** Server có token API SePay → nút kéo sao kê dùng được. */
  can_sync: boolean;
  /** Super-admin nhưng server chưa có token → ngày cũ chưa kéo về được. */
  sync_needs_token: boolean;
  /** Ngày sớm nhất sổ có dữ liệu; null = sổ hoàn toàn trống. */
  ledger_first_date: string | null;
  events: SepayEvent[];
};

export type SepaySyncResult = {
  date_from: string;
  date_to: string;
  fetched: number;
  created: number;
  updated: number;
  /** Số dòng dựng lại được chủ nhân nhờ dò mã giao dịch trong sổ cái ví. */
  matched_to_wallet: number;
  /** Số khoản tiền vào KHÔNG tìm thấy vết trong ví — cần soi tay. */
  bank_only: number;
};

/** Nhãn tiếng Việt cho từng kết luận (dùng chung modal đối soát + tooltip). */
export const SEPAY_RESULT_LABEL: Record<string, string> = {
  credited: "Đã vào ví",
  dup_invoice: "Trả trùng hoá đơn → vào ví",
  duplicate: "Webhook lặp",
  declined: "Bị từ chối",
  unmatched: "Không khớp mã nào",
  bank_only: "Chỉ có ở ngân hàng",
  ignored: "Bỏ qua",
  unauthorized: "Sai xác thực",
  error: "Vào ví nhưng thực thi lỗi",
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

/** Hoá đơn QR trả trong lỗi 402 PAYMENT_QR_REQUIRED (mời/gia hạn/trả kỳ khi ví thiếu). */
export type OrderQr = {
  id: string;
  ref_code: string;
  kind: "invite" | "renew" | "subscription" | "cycle";
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
  kind: "invite" | "renew" | "subscription" | "cycle";
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

// ── Thống kê email add mới / gia hạn (super-admin) ──────────────────────────
// ĐƠN VỊ ĐẾM = 1 EMAIL TRONG 1 NGÀY (giờ VN), không phải 1 lượt thao tác. Cùng một
// email mời đi mời lại nhiều lượt trong ngày vẫn là 1; có lượt nào thành công thì
// ngày đó tính THÀNH CÔNG. Nhờ vậy cộng các ngày ra đúng tổng kỳ.

/** Một ô (ngày, loại, email) đã gộp — đúng 1 đơn vị đếm của bảng. */
export type EmailStatsEmail = {
  email: string;
  date: string; // "YYYY-MM-DD" (giờ VN)
  kind: "new" | "renew";
  ok: boolean;
  /** Ô đã bị một lần ĐỔI EMAIL thay tên: `email` là email cuối chuỗi, `old_email`
   *  là email đứng ở ô lúc đầu. Nhãn: ĐỔI + MỚI (ô add mới), ĐỔI + CŨ (ô gia hạn). */
  changed?: boolean;
  old_email?: string | null;
};

export type EmailStatsAgent = {
  /** null = "Chưa rõ chủ" (không quy được ai bấm mời). */
  user_id: string | null;
  username: string | null;
  email: string | null;
  new_ok: number;
  new_failed: number;
  renew_ok: number;
  /** Gia hạn chưa có đường hỏng → luôn 0. Giữ cột cho bảng đồng dạng. */
  renew_failed: number;
  total: number;
  /** Danh sách email đứng sau các con số, số phần tử luôn bằng `total`. */
  emails: EmailStatsEmail[];
};

export type EmailStatsDay = {
  date: string; // "YYYY-MM-DD" (giờ VN)
  new_ok: number;
  new_failed: number;
  renew_ok: number;
  renew_failed: number;
  total: number;
  by_agent: EmailStatsAgent[];
};

export type EmailStats = {
  from_date: string;
  to_date: string;
  new_ok: number;
  new_failed: number;
  renew_ok: number;
  renew_failed: number;
  total: number;
  /** Số email DUY NHẤT chạm tới trong kỳ (1 email add đầu tháng + gia hạn cuối tháng = 2 lượt, 1 email). */
  unique_emails: number;
  days: EmailStatsDay[];
  by_agent: EmailStatsAgent[];
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
  cycle_fee: "Phí kỳ còn nợ",
  withdraw_hold: "Giữ rút tiền",
  withdraw_settle: "Rút tiền (đã chi)",
  withdraw_refund: "Hoàn rút tiền",
  adjust: "Điều chỉnh",
};
