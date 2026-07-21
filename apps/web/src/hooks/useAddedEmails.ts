/**
 * Chức năng: Added Emails (email đã thêm) — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useAddedEmails.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Gom các mutation gọi API (trước đây nằm inline trong `pages/AddedEmails.tsx`):
 *   - requestPayment → POST /added-members/request-payment (bước 1: gửi / rút yêu cầu — sub-admin)
 *   - markPaid       → POST /added-members/mark-paid        (bước 2: xác nhận / huỷ — super-admin)
 *   - transferOwner  → POST /added-members/transfer-owner   (chuyển / thu hồi sở hữu)
 *
 * Mọi onSuccess đều bỏ chọn checkbox (clear selection) → component truyền
 * callback `onCleared` thay cho `setSelected(new Set())` inline.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "./useAuth";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import { isRenewalDue } from "../components/RenewalsPanel";
import type { AddedMember, PaymentRequestNotice } from "../types";

/**
 * Đếm số email đang "Chờ xác nhận" (payment_status='requested') để hiện badge
 * thông báo cho super-admin biết mà vào duyệt. Poll mỗi 30s, chỉ bật cho
 * super-admin (sub-admin backend luôn trả 0). Query key ["added-members",
 * "pending-count"] → mọi mutation invalidate ["added-members"] cũng làm mới badge.
 */
export function usePendingPaymentCount() {
  const { user } = useAuth();
  const enabled = !!user?.is_super_admin;
  const query = useQuery({
    queryKey: ["added-members", "pending-count"],
    queryFn: () =>
      api<{ count: number }>("/api/v1/added-members/pending-count"),
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  return enabled ? (query.data?.count ?? 0) : 0;
}

/**
 * Đếm số thành viên "cần gia hạn" (sắp/đã hết hạn — cùng điều kiện `isRenewalDue`
 * mà RenewalsPanel dùng) để hiện badge trên mục "Gia hạn" ở sidebar. Dùng CHUNG
 * queryKey ["added-members", "self"] với trang Gia hạn → react-query tái dùng
 * cache, không gọi API thừa. Bật cho mọi ai xem được member (MEMBER_VIEW).
 *
 * Phục vụ TỪ CACHE (staleTime=Infinity) — KHÔNG còn poll 60s / refetch khi focus tab
 * (badge sidebar luôn mounted nên trước đây kéo TOÀN BỘ list mỗi 60s liên tục). Badge
 * chỉ cập nhật khi ["added-members"] bị invalidate bởi mutation hoặc watcher task nền.
 * (User 2026-07-20: dữ liệu lấy cache, chỉ khi thay đổi mới get từ DB.)
 */
export function useRenewalDueCount() {
  const { hasPermission } = useAuth();
  const enabled = hasPermission("MEMBER_VIEW");
  const query = useQuery({
    queryKey: ["added-members", "self"],
    queryFn: () => api<AddedMember[]>("/api/v1/added-members"),
    enabled,
    staleTime: Infinity,
  });
  return enabled ? (query.data ?? []).filter(isRenewalDue).length : 0;
}

/**
 * Danh sách yêu cầu duyệt thanh toán đang chờ (dạng thông báo) cho dropdown chuông.
 * Chỉ fetch khi `enabled` (dropdown mở) để khỏi tải list mỗi nhịp poll badge.
 */
export function usePendingPaymentRequests(enabled: boolean) {
  return useQuery({
    queryKey: ["added-members", "pending-requests"],
    queryFn: () =>
      api<PaymentRequestNotice[]>("/api/v1/added-members/pending-requests"),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useAddedEmails(opts?: { onCleared?: () => void }) {
  const t = useT();
  const qc = useQueryClient();

  // Bước 1 — sub-admin gửi yêu cầu duyệt thanh toán (requested:true). UI nút "Rút
  // yêu cầu" (requested:false) đã bỏ (yêu cầu user 2026-07-08); mutation vẫn giữ
  // tham số requested để tương thích, chỉ không còn entry point gọi false.
  const requestPayment = useMutation({
    // ids = theo email (áp mọi chu kỳ); cycleIds = theo từng chu kỳ. Gửi ≥1.
    mutationFn: (vars: {
      ids?: string[];
      cycleIds?: string[];
      requested: boolean;
    }) =>
      api<{ count: number; requested: boolean }>(
        "/api/v1/added-members/request-payment",
        {
          method: "POST",
          body: JSON.stringify({
            member_ids: vars.ids ?? [],
            cycle_ids: vars.cycleIds ?? [],
            requested: vars.requested,
          }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(
        resp.requested
          ? t("addedEmails.requestOk", { n: resp.count })
          : t("addedEmails.withdrawOk", { n: resp.count }),
      );
      opts?.onCleared?.();
      qc.invalidateQueries({ queryKey: ["added-members"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  const markPaid = useMutation({
    // ids = theo email (áp mọi chu kỳ); cycleIds = xác nhận từng chu kỳ. Gửi ≥1.
    mutationFn: (vars: { ids?: string[]; cycleIds?: string[]; paid: boolean }) =>
      api<{ count: number; paid: boolean }>(
        "/api/v1/added-members/mark-paid",
        {
          method: "POST",
          body: JSON.stringify({
            member_ids: vars.ids ?? [],
            cycle_ids: vars.cycleIds ?? [],
            paid: vars.paid,
          }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(
        resp.paid
          ? t("addedEmails.confirmOk", { n: resp.count })
          : t("addedEmails.markUnpaidOk", { n: resp.count }),
      );
      opts?.onCleared?.();
      qc.invalidateQueries({ queryKey: ["added-members"] });
      // Nút "Huỷ" (đánh dấu chưa thanh toán) nằm trong modal Chi tiết thành viên,
      // mở từ Members (["members"]) lẫn Email đã add / sub-tab Gia hạn. Làm mới cả
      // danh sách thành viên + lịch sử để trạng thái phản ánh ngay.
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-logs"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  // Super-admin: chuyển/thu hồi quyền sở hữu. Thu hồi = chuyển về chính admin.
  const transferOwner = useMutation({
    mutationFn: (vars: { ids: string[]; targetUserId: string }) =>
      api<{ count: number; target_username: string }>(
        "/api/v1/added-members/transfer-owner",
        {
          method: "POST",
          body: JSON.stringify({
            member_ids: vars.ids,
            target_user_id: vars.targetUserId,
          }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(`Đã chuyển ${resp.count} email cho ${resp.target_username}`);
      opts?.onCleared?.();
      qc.invalidateQueries({ queryKey: ["added-members"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });

  return { requestPayment, markPaid, transferOwner };
}
