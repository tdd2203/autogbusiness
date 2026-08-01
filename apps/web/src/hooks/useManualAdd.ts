/**
 * Chức năng: Thêm thủ công (Manual Add) — phía web/dashboard.
 *
 * POST /members/manual-add với `invites: [{email, subscription_months}]` — CHỈ GHI
 * NHẬN email vào dashboard để quản lý (email đã ở trên ChatGPT nhờ auto-create),
 * KHÔNG mời qua extension, KHÔNG trừ ví. Chỉ super-admin.
 *
 * Khác `useBulkInvite`: không có luồng QR (miễn phí) và không tạo task extension.
 * onSuccess gọi callback do component truyền vào (đóng modal / clear state).
 */
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "../components/Toast";

const MANUAL_ROLE = "member" as const;

export type ManualAddEntry = { email: string; months: number };

type ManualAddResp = {
  count: number;
  added_count: number;
  renewed_count: number;
  member_ids: string[];
};

export function useManualAdd(
  workspaceId: string,
  opts: {
    entries: ManualAddEntry[];
    onSuccess?: () => void;
  },
) {
  const t = useT();

  return useMutation({
    mutationFn: () =>
      api<ManualAddResp>(
        `/api/v1/workspaces/${workspaceId}/members/manual-add`,
        {
          method: "POST",
          body: JSON.stringify({
            invites: opts.entries.map((e) => ({
              email: e.email,
              subscription_months: e.months,
            })),
            role: MANUAL_ROLE,
          }),
        },
      ),
    onSuccess: (resp) => {
      toast.success(t("manualAdd.result", { n: resp.count }));
      opts.onSuccess?.();
    },
    onError: (e) => {
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
      toast.error(t("manualAdd.resultError", { error: msg }));
    },
  });
}
