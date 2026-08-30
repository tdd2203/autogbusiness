/**
 * useWallet (feature 003-wallet-invite-payment) — query số dư/lịch sử + mutation
 * nạp/rút cho user hiện tại, và các query/mutation quản trị cho super-admin.
 *
 * Mọi mutation invalidate ["wallet"] để UI đọc bản sống (không reload tay) —
 * theo memory `mutation-must-refresh-ui`.
 */
import { useEffect, useRef } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "./useAuth";
import type {
  EmailStats,
  FinancialCycles,
  FinancialReport,
  PaymentOrder,
  PaymentSettings,
  SepayDay,
  SepaySyncResult,
  Topup,
  TopupCreated,
  Wallet,
  WalletAdminUser,
  WalletDailySummary,
  WalletTxnAdmin,
  Withdrawal,
  WithdrawalAdmin,
} from "../lib/wallet";

// ── User: số dư + lịch sử ───────────────────────────────────────────────────

/** Nhịp hỏi số dư khi đang mở ví/modal mời — payload chỉ vài con số nên rất nhẹ. */
const WALLET_POLL_MS = 30_000;

export function useWallet() {
  const { user } = useAuth();
  const enabled = !!user?.wallet_beta || !!user?.is_super_admin;
  return useQuery({
    queryKey: ["wallet", "balance"],
    queryFn: () => api<Wallet>("/api/v1/wallet"),
    enabled,
    refetchOnWindowFocus: true,
    // Tiền vào từ NGOÀI tab này (SePay báo có, phí mời trừ lúc task chạy nền,
    // super-admin điều chỉnh) nên số dư phải tự nhích, không chờ F5 hay đổi tab.
    refetchInterval: WALLET_POLL_MS,
  });
}

/**
 * Ví "sống": số dư đổi ⇒ kéo lại lịch sử + tổng kết ngày.
 *
 * Chỉ số dư mới đáng poll (vài con số); lịch sử và tổng kết ngày nặng hơn nhiều nên
 * chỉ nạp lại KHI số dư/tạm giữ thật sự đổi — lúc đó chắc chắn có bút toán mới.
 * Gọi một lần ở trang Ví.
 */
export function useWalletLive() {
  const qc = useQueryClient();
  const { data } = useWallet();
  const sig = data ? `${data.balance}|${data.held}|${data.total}` : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!sig) return;
    if (seen.current === null || seen.current === sig) {
      seen.current = sig;
      return;
    }
    seen.current = sig;
    qc.invalidateQueries({ queryKey: ["wallet", "transactions"] });
    qc.invalidateQueries({ queryKey: ["wallet", "daily-summary"] });
  }, [sig, qc]);
}

/** Số bút toán xin mỗi lượt gọi API (mới→cũ). */
const TXN_PAGE = 100;

/**
 * Lịch sử ví, phân trang bằng CON TRỎ (`before_seq`) — không còn cắt cứng 100 dòng.
 *
 * `day` (YYYY-MM-DD) khác null ⇒ xin đúng ngày đó ở server. Trước đây FE xin cứng 100
 * bút toán gần nhất rồi lọc ngày TẠI CHỖ, nên mọi ngày nằm ngoài 100 dòng ấy hiện ra
 * rỗng — trông như mất sạch lịch sử cũ (user 2026-08-26).
 *
 * `fetchNextPage` nối thêm trang cũ hơn; `hasNextPage` = server còn dòng cũ hơn nữa.
 */
export function useWalletTransactions(day: string | null = null, userId?: string | null) {
  const { user } = useAuth();
  const enabled = userId ? !!user?.is_super_admin : !!user?.wallet_beta || !!user?.is_super_admin;
  return useInfiniteQuery({
    queryKey: ["wallet", "transactions", userId ?? "me", day],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(TXN_PAGE) });
      if (day) qs.set("date", day);
      if (pageParam) qs.set("before_seq", pageParam);
      return api<{ items: WalletTxnAdmin[]; next_cursor: string | null }>(
        userId
          ? `/api/v1/wallet/admin/users/${userId}/transactions?${qs}`
          : `/api/v1/wallet/transactions?${qs}`,
      );
    },
    getNextPageParam: (last) => last.next_cursor,
    enabled,
    refetchOnWindowFocus: true,
  });
}

/**
 * Đối soát ngân hàng: dữ liệu SePay báo về trong NGÀY (giờ VN).
 *
 * `userId` = mở từ trang ví của một tài khoản: chỉ lấy tiền vào của đúng người đó.
 * Bỏ trống thì super-admin thấy toàn bộ tiền vào, user thường thấy phần của mình.
 *
 * `keepPreviousData`: đổi ngày thì GIỮ số của ngày cũ tới khi ngày mới về, thay vì
 * rơi về undefined một nhịp — nếu không, ba con số trên đầu chớp về 0đ rồi mới nhảy
 * lên giá trị thật, nhìn như đang hỏng (user 2026-08-27).
 */
export function useSepayDay(date: string, userId?: string | null, enabled = true) {
  const { user } = useAuth();
  const allowed = userId ? !!user?.is_super_admin : !!user?.wallet_beta || !!user?.is_super_admin;
  return useQuery({
    queryKey: ["wallet", "sepay-events", userId ?? "all", date],
    queryFn: () =>
      api<SepayDay>(
        `/api/v1/wallet/sepay-events?date=${date}${userId ? `&user_id=${userId}` : ""}`,
      ),
    enabled: enabled && allowed && !!date,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
  });
}

/** Kéo sao kê ngân hàng từ API SePay về sổ đối soát (super-admin). */
export function useSepaySync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { date_from: string; date_to: string }) =>
      api<SepaySyncResult>("/api/v1/wallet/admin/sepay/sync", {
        method: "POST",
        body: JSON.stringify(body),
        // Endpoint này gọi ra API SePay (bản thân nó chờ tới 20s — xem
        // `sepay/userapi.py`) rồi mới ghi sổ, nên trần 20s mặc định là quá chặt.
        timeoutMs: 60_000,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet", "sepay-events"] }),
  });
}

/** Báo cáo trong ngày (giờ VN): email đã thêm + giao dịch. `date` = YYYY-MM-DD. */
export function useWalletDailySummary(date: string, userId?: string | null) {
  const { user } = useAuth();
  const enabled = userId ? !!user?.is_super_admin : !!user?.wallet_beta || !!user?.is_super_admin;
  return useQuery({
    queryKey: ["wallet", "daily-summary", userId ?? "me", date],
    queryFn: () =>
      api<WalletDailySummary>(
        userId
          ? `/api/v1/wallet/admin/users/${userId}/daily-summary?date=${date}`
          : `/api/v1/wallet/daily-summary?date=${date}`,
      ),
    enabled: enabled && !!date,
    refetchOnWindowFocus: true,
  });
}

// ── Nạp tiền ────────────────────────────────────────────────────────────────

export function useCreateTopup() {
  return useMutation({
    mutationFn: (amount_vnd: number) =>
      api<TopupCreated>("/api/v1/wallet/topups", {
        method: "POST",
        body: JSON.stringify({ amount_vnd }),
      }),
  });
}

/** Poll trạng thái lệnh nạp mỗi 3s tới khi paid (khi modal mở với topupId). */
export function useTopupStatus(topupId: string | null) {
  return useQuery({
    queryKey: ["wallet", "topup", topupId],
    queryFn: () => api<Topup>(`/api/v1/wallet/topups/${topupId}`),
    enabled: !!topupId,
    refetchInterval: (query) =>
      query.state.data?.status === "paid" ? false : 3000,
  });
}

/** Poll trạng thái hoá đơn (mời/gia hạn) mỗi 3s tới khi rời pending (paid/huỷ/hết hạn). */
export function useOrderStatus(orderId: string | null) {
  return useQuery({
    queryKey: ["wallet", "order", orderId],
    queryFn: () => api<PaymentOrder>(`/api/v1/wallet/orders/${orderId}`),
    enabled: !!orderId,
    refetchInterval: (query) =>
      (query.state.data?.status ?? "pending") === "pending" ? 3000 : false,
  });
}

// ── Rút tiền (user) ─────────────────────────────────────────────────────────

export function useMyWithdrawals() {
  const { user } = useAuth();
  const enabled = !!user?.wallet_beta || !!user?.is_super_admin;
  return useQuery({
    queryKey: ["wallet", "withdrawals", "mine"],
    queryFn: () => api<Withdrawal[]>("/api/v1/wallet/withdrawals"),
    enabled,
  });
}

export function useCreateWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { amount_vnd: number; bank_account: string; note?: string }) =>
      api<Withdrawal>("/api/v1/wallet/withdrawals", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet"] }),
  });
}

// ── Admin (super-admin) ─────────────────────────────────────────────────────

export function usePaymentSettings(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["wallet", "admin", "settings"],
    queryFn: () => api<PaymentSettings>("/api/v1/wallet/admin/settings"),
    enabled: enabled && !!user?.is_super_admin,
  });
}

export function useUpdatePaymentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<PaymentSettings>) =>
      api<PaymentSettings>("/api/v1/wallet/admin/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet", "admin"] }),
  });
}

export function useWalletAdminUsers(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["wallet", "admin", "users"],
    queryFn: () => api<WalletAdminUser[]>("/api/v1/wallet/admin/users"),
    enabled: enabled && !!user?.is_super_admin,
  });
}

/** Super-admin xem lịch sử giao dịch ví của MỘT user (mở modal chi tiết). */
export function useWalletAdminUserTransactions(userId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["wallet", "admin", "user-transactions", userId],
    queryFn: () =>
      api<{ items: WalletTxnAdmin[] }>(
        `/api/v1/wallet/admin/users/${userId}/transactions?limit=200`,
      ),
    enabled: !!userId && !!user?.is_super_admin,
  });
}

export function useToggleBeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { userId: string; enabled: boolean }) =>
      api(`/api/v1/wallet/admin/users/${args.userId}/beta`, {
        method: "PUT",
        body: JSON.stringify({ enabled: args.enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet", "admin"] }),
  });
}

export function useAdjustBalance() {
  const qc = useQueryClient();
  return useMutation({
    // reason BẮT BUỘC — API 422 nếu thiếu (xem WalletAdjustIn).
    mutationFn: (args: { userId: string; amount_vnd: number; reason: string }) =>
      api(`/api/v1/wallet/admin/users/${args.userId}/adjust`, {
        method: "POST",
        body: JSON.stringify({ amount_vnd: args.amount_vnd, reason: args.reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet"] }),
  });
}

export function useAdminWithdrawals(status = "pending") {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["wallet", "admin", "withdrawals", status],
    queryFn: () =>
      api<WithdrawalAdmin[]>(`/api/v1/wallet/admin/withdrawals?status=${status}`),
    enabled: !!user?.is_super_admin,
    refetchInterval: 30_000,
  });
}

/** Super-admin đặt/xoá phí mời MẶC ĐỊNH của 1 user (đại lý) — feature 003. */
export function useSetUserFee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { userId: string; invite_fee_vnd: number | null }) =>
      api(`/api/v1/wallet/admin/users/${args.userId}/fee`, {
        method: "PUT",
        body: JSON.stringify({ invite_fee_vnd: args.invite_fee_vnd }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet", "admin"] }),
  });
}

/** Super-admin đặt/xoá phí mời riêng cho 1 member (feature 003). */
export function useSetMemberFee(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { memberId: string; fee_vnd: number | null }) =>
      api(`/api/v1/wallet/admin/members/${args.memberId}/fee`, {
        method: "PUT",
        body: JSON.stringify({ fee_vnd: args.fee_vnd }),
      }),
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["added-members"] });
    },
  });
}

/** Báo cáo tài chính (super-admin): THU/CHI/lợi nhuận trong kỳ [from, to] (ISO date). */
export function useFinancialReport(from: string, to: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["wallet", "admin", "report", from, to],
    queryFn: () =>
      api<FinancialReport>(
        `/api/v1/wallet/admin/report?from=${from}&to=${to}`,
      ),
    enabled: !!user?.is_super_admin && !!from && !!to,
  });
}

/**
 * Thống kê ĐẦU EMAIL (add mới / gia hạn) theo ngày — cùng khoảng với báo cáo tiền.
 * Đơn vị đếm là 1 email trong 1 ngày, không phải 1 lượt thao tác.
 */
export function useEmailStats(from: string, to: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["wallet", "admin", "report", "emails", from, to],
    queryFn: () =>
      api<EmailStats>(`/api/v1/wallet/admin/report/emails?from=${from}&to=${to}`),
    enabled: !!user?.is_super_admin && !!from && !!to,
  });
}

/** Lãi/lỗ cắt theo ĐÚNG chu kỳ thanh toán ChatGPT (không phụ thuộc khoảng đang chọn). */
export function useFinancialCycles(limit = 3) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["wallet", "admin", "report", "cycles", limit],
    queryFn: () =>
      api<FinancialCycles>(`/api/v1/wallet/admin/report/cycles?limit=${limit}`),
    enabled: !!user?.is_super_admin,
  });
}

export function useReviewWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; action: "settle" | "reject"; reason?: string }) =>
      api(`/api/v1/wallet/admin/withdrawals/${args.id}/${args.action}`, {
        method: "POST",
        body: args.action === "reject" ? JSON.stringify({ reason: args.reason }) : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallet", "admin"] }),
  });
}
