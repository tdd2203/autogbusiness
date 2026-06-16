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
import { useT } from "../i18n";
import { toast } from "../components/Toast";

const INVITE_ROLE = "member" as const;

export type BulkInviteEntry = { email: string; months: number };

export function useBulkInvite(
  workspaceId: string,
  opts: { entries: BulkInviteEntry[]; onSuccess?: () => void },
) {
  const t = useT();

  return useMutation({
    mutationFn: () =>
      api<{ queue_item_id: string; count: number }>(
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
      toast.success(t("invite.resultQueued", { n: resp.count }));
      opts.onSuccess?.();
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError
          ? String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(t("invite.resultError", { error: msg }));
    },
  });
}
