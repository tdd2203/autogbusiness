/**
 * Chức năng: Bulk Invite (mời thành viên hàng loạt) — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useBulkInvite.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Tách mutation `bulkInvite` (trước đây nằm inline trong
 * `components/InviteMemberModal.tsx`): POST /members/bulk-invite với danh sách
 * `invites: [{email, subscription_months}]` + role cố định "member".
 *
 * Backend chỉ enqueue task INVITE_MEMBER; extension mới thực thi trên ChatGPT.
 * onSuccess gọi callback do component truyền vào (đóng modal / clear state).
 */
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { getQrOrder, type OrderQr } from "../lib/wallet";
import { useT } from "../i18n";
import { toast } from "../components/Toast";

const INVITE_ROLE = "member" as const;

export type BulkInviteEntry = { email: string; months: number };

export function useBulkInvite(
  workspaceId: string,
  opts: {
    entries: BulkInviteEntry[];
    onSuccess?: () => void;
    /** Ví không đủ → BE trả 402 kèm hoá đơn QR (feature 003). Có callback → mở modal
     *  QR thay vì báo lỗi; user quét QR xong lời mời tự thực thi. */
    onPaymentRequired?: (order: OrderQr) => void;
  },
) {
  const t = useT();

  return useMutation({
    mutationFn: () =>
      api<{
        queue_item_id: string | null;
        count: number;
        invited_count?: number;
        renewed_count?: number;
      }>(
        `/api/v1/workspaces/${workspaceId}/members/bulk-invite`,
        {
          method: "POST",
          body: JSON.stringify({
            invites: opts.entries.map((e) => ({
              email: e.email,
              subscription_months: e.months,
            })),
            role: INVITE_ROLE,
          }),
        },
      ),
    onSuccess: (resp) => {
      // Phân biệt mời mới vs gia hạn (email đã active) trong thông báo.
      const renewed = resp.renewed_count ?? 0;
      const invited = resp.invited_count ?? resp.count;
      if (renewed > 0 && invited > 0) {
        toast.success(t("invite.resultMixed", { invited, renewed }));
      } else if (renewed > 0) {
        toast.success(t("invite.resultRenewed", { n: renewed }));
      } else {
        toast.success(t("invite.resultQueued", { n: invited }));
      }
      opts.onSuccess?.();
    },
    onError: (e) => {
      const order = getQrOrder(e);
      if (order && opts.onPaymentRequired) {
        opts.onPaymentRequired(order);
        return;
      }
      const msg =
        e instanceof ApiError
          ? typeof e.detail === "object" && e.detail
            ? String((e.detail as { message?: string }).message ?? JSON.stringify(e.detail))
            : String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(t("invite.resultError", { error: msg }));
    },
  });
}
