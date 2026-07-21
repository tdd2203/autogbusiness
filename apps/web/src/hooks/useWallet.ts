/**
 * useWallet (feature 003-wallet-invite-payment) — query số dư/lịch sử + mutation
 * nạp/rút cho user hiện tại, và các query/mutation quản trị cho super-admin.
 *
 * Mọi mutation invalidate ["wallet"] để UI đọc bản sống (không reload tay) —
 * theo memory `mutation-must-refresh-ui`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "./useAuth";
import type {
  FinancialReport,
  PaymentOrder,
  PaymentSettings,
  Topup,
  TopupCreated,
  Wallet,
  WalletAdminUser,
  WalletTxn,
  Withdrawal,
  WithdrawalAdmin,
} from "../lib/wallet";

// ── User: số dư + lịch sử ───────────────────────────────────────────────────

export function useWallet() {
  const { user } = useAuth();
  const enabled = !!user?.wallet_beta || !!user?.is_super_admin;
  return useQuery({
    queryKey: ["wallet", "balance"],
    queryFn: () => api<Wallet>("/api/v1/wallet"),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useWalletTransactions() {
  const { user } = useAuth();
  const enabled = !!user?.wallet_beta || !!user?.is_super_admin;
  return useQuery({
    queryKey: ["wallet", "transactions"],
    queryFn: () =>
      api<{ items: WalletTxn[] }>("/api/v1/wallet/transactions?limit=100"),
    enabled,
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
      api<{ items: WalletTxn[] }>(
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
    mutationFn: (args: { userId: string; amount_vnd: number; reason?: string }) =>
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
