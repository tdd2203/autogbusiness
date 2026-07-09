/**
 * Chức năng: Đổi hạn dùng (subscription) CÓ DUYỆT — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useSubscriptionApprovals.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Song song luồng duyệt thanh toán (useAddedEmails). Gồm:
 *   - useChangeSubscription(wsId)      → PATCH .../members/{id}/subscription
 *       Super-admin: áp ngay. Sub-admin: tạo yêu cầu chờ duyệt (BE quyết định).
 *   - usePendingSubscriptionCount()    → badge chuông (số yêu cầu chờ duyệt)
 *   - usePendingSubscriptionRequests() → danh sách cho dropdown chuông
 *   - useApproveSubscription()         → super-admin duyệt / từ chối
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "./useAuth";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import type { Member, SubscriptionRequestNotice } from "../types";

/** Body PATCH subscription: đặt hạn theo NGÀY MUA + SỐ THÁNG, hoặc null = vô thời hạn. */
export type ChangeSubscriptionVars = {
  memberId: string;
  /** Số tháng (chu kỳ, 1..60). months + purchasedAt + endAt đều null = vô thời hạn. */
  subscriptionMonths?: number | null;
  /** Ngày mua (ISO, mốc neo). Gửi kèm subscriptionMonths → BE tính hạn = ngày mua +
   *  tháng×30 (chính xác tới giây). Đây là đường đi chính của modal Đổi hạn dùng. */
  subscriptionPurchasedAt?: string | null;
  /** Ngày hết hạn cụ thể (ISO) — dự phòng, BE dùng trực tiếp (vd bulk-set-expiry). */
  subscriptionEndAt?: string | null;
};

export function useChangeSubscription(workspaceId: string | undefined) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: ChangeSubscriptionVars) => {
      const body: Record<string, unknown> = {};
      if (vars.subscriptionMonths != null) {
        body.subscription_months = vars.subscriptionMonths;
      }
      if (vars.subscriptionPurchasedAt != null) {
        body.subscription_purchased_at = vars.subscriptionPurchasedAt;
      }
      if (vars.subscriptionEndAt != null) {
        body.subscription_end_at = vars.subscriptionEndAt;
      }
      // months + purchasedAt + endAt đều null → {} = đặt vô thời hạn.
      return api<Member>(
        `/api/v1/workspaces/${workspaceId}/members/${vars.memberId}/subscription`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },
    onSuccess: (m) => {
      // BE trả Member: nếu requested → sub-admin gửi yêu cầu; ngược lại đã áp dụng.
      if (m.subscription_request_status === "requested") {
        toast.success(t("subscription.requestSent"));
      } else {
        toast.success(t("subscription.applied"));
      }
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["subscription-requests"] });
      qc.invalidateQueries({ queryKey: ["member-logs"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });
}

/**
 * GIA HẠN (renew) — TỰ PHỤC VỤ, áp dụng NGAY, KHÔNG cần duyệt (yêu cầu user 2026-07-08).
 * POST .../members/{id}/renew. BE cộng dồn hạn, tạo 1 CHU KỲ mới (unpaid) và reset
 * trạng thái thanh toán của member về 'chưa thanh toán'. Khác useChangeSubscription
 * (đổi hạn — vẫn qua duyệt cho sub-admin). Xem routers/members/renew.py.
 */
export function useRenewSubscription(workspaceId: string | undefined) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { memberId: string; months: number }) =>
      api<Member>(
        `/api/v1/workspaces/${workspaceId}/members/${vars.memberId}/renew`,
        { method: "POST", body: JSON.stringify({ months: vars.months }) },
      ),
    onSuccess: () => {
      toast.success(t("subscription.renewed"));
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["added-members"] });
      qc.invalidateQueries({ queryKey: ["member-logs"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });
}

/**
 * Sửa "Ngày gia hạn" (mốc neo = ngày add đầu tiên) ĐÚNG 1 LẦN — chỉ super-admin.
 * PATCH .../members/{id}/add-date. BE tính lại hạn = ngày mới + tháng×30 rồi khoá
 * (add_date_corrected_at). 409 nếu đã sửa rồi. Xem correct_add_date.md.
 */
export function useCorrectAddDate(workspaceId: string | undefined) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      memberId: string;
      addDate: string;
      /** Neo lại cả số tháng: hạn = ngày mới + months×30 (không cộng dồn). Bỏ trống
       *  → giữ subscription_months hiện tại. */
      months?: number | null;
      /** "Theo ngày cụ thể" (kết hợp): đặt THẲNG ngày hết hạn đã tinh chỉnh; BE để
       *  subscription_months = null (hạn thủ công). Ưu tiên hơn months. */
      endAt?: string | null;
      /** "Vô thời hạn": xoá hạn (subscription_end_at + months = null). */
      clearEnd?: boolean;
    }) =>
      api<Member>(
        `/api/v1/workspaces/${workspaceId}/members/${vars.memberId}/add-date`,
        {
          method: "PATCH",
          body: JSON.stringify({
            add_date: vars.addDate,
            ...(vars.clearEnd ? { clear_end: true } : {}),
            ...(vars.endAt != null ? { end_at: vars.endAt } : {}),
            ...(vars.months != null ? { months: vars.months } : {}),
          }),
        },
      ),
    onSuccess: () => {
      toast.success(t("addDate.corrected"));
      // Làm mới NGAY: list members (info trên cùng modal) + added-members +
      // timeline lịch sử trong modal (member-logs) → sửa xong hiện tức thì, khỏi reload.
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["added-members"] });
      qc.invalidateQueries({ queryKey: ["member-logs"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });
}

/**
 * Số yêu cầu đổi hạn đang chờ → badge chuông (super-admin; sub-admin BE trả 0).
 * Poll 30s, key ["subscription-requests","pending-count"] → mọi mutation duyệt
 * invalidate ["subscription-requests"] cũng làm mới badge.
 */
export function usePendingSubscriptionCount() {
  const { user } = useAuth();
  const enabled = !!user?.is_super_admin;
  const query = useQuery({
    queryKey: ["subscription-requests", "pending-count"],
    queryFn: () =>
      api<{ count: number }>("/api/v1/subscription-requests/pending-count"),
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  return enabled ? (query.data?.count ?? 0) : 0;
}

/** Danh sách yêu cầu đổi hạn chờ duyệt — chỉ fetch khi dropdown mở (enabled). */
export function usePendingSubscriptionRequests(enabled: boolean) {
  return useQuery({
    queryKey: ["subscription-requests", "pending"],
    queryFn: () =>
      api<SubscriptionRequestNotice[]>("/api/v1/subscription-requests/pending"),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useApproveSubscription(opts?: { onCleared?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { ids: string[]; approve: boolean }) =>
      api<{ count: number; approve: boolean }>(
        "/api/v1/subscription-requests/approve",
        {
          method: "POST",
          body: JSON.stringify({ member_ids: vars.ids, approve: vars.approve }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(
        resp.approve
          ? t("subscription.approveOk", { n: resp.count })
          : t("subscription.rejectOk", { n: resp.count }),
      );
      opts?.onCleared?.();
      qc.invalidateQueries({ queryKey: ["subscription-requests"] });
      // Hạn vừa duyệt áp vào member → mọi bảng members refresh.
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });
}
