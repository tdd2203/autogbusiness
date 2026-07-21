/**
 * Chức năng: Mời lại (re-invite) — phía web/dashboard.
 *
 * Dùng cho member CHỜ THAM GIA khi lời mời lỗi (tỉ lệ nhỏ nhưng có thật). Gọi
 * POST /members/{id}/re-invite → backend enqueue task INVITE_MEMBER (payload.reinvite)
 * để extension: tìm tab Người dùng (còn → huỷ, báo vẫn trong workspace) → thu hồi lời
 * mời cũ → mời lại. Email CÒN HẠN miễn phí; HẾT HẠN tính phí (ví trước, QR sau).
 *
 * onSuccess invalidate ["recent-tasks"] để watcher trong Members.tsx bắt task
 * COMPLETED → tự refresh ["members"] không cần F5 (giống useChangeEmail).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { getQrOrder, type OrderQr } from "../lib/wallet";
import { handleCommandBan } from "../lib/commandBan";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import { triggerExtensionRun } from "./useExtensionTrigger";
import type { Member } from "../types";

export function useReinvite(
  workspaceId: string | undefined,
  opts?: {
    /** Hết hạn + ví thiếu → BE trả 402 kèm hoá đơn QR. Có callback → mở modal QR. */
    onPaymentRequired?: (order: OrderQr) => void;
  },
) {
  const t = useT();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (memberId: string) =>
      api<Member>(
        `/api/v1/workspaces/${workspaceId}/members/${memberId}/re-invite`,
        { method: "POST" },
      ),
    onSuccess: (m) => {
      toast.success(t("member.reinviteQueued", { email: m.email }));
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["added-members"] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks-global"] });
      triggerExtensionRun();
    },
    onError: (e) => {
      const order = getQrOrder(e);
      if (order && opts?.onPaymentRequired) {
        opts.onPaymentRequired(order);
        return;
      }
      if (handleCommandBan(e)) return;
      const msg =
        e instanceof ApiError
          ? typeof e.detail === "object" && e.detail
            ? String(
                (e.detail as { message?: string }).message ??
                  JSON.stringify(e.detail),
              )
            : String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(msg);
    },
  });
}
