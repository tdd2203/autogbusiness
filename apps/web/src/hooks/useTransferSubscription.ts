/**
 * Chức năng: Chuyển hạn sử dụng đến 1 email khác — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useTransferSubscription.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Hai hook:
 *   - `useTransferPreview(ws, memberId, email)` — query TÍNH TRƯỚC (không ghi
 *     DB). Modal gọi mỗi khi admin gõ xong email nhận để hiện phép tính.
 *   - `useTransferSubscription(ws)` — mutation THỰC THI.
 *
 * Phép tính do BACKEND trả (không tính lại ở web): con số admin nhìn thấy chính
 * là con số sẽ được ghi. Xem `apps/api/.../members/transfer-subscription.md`.
 *
 * onSuccess PHẢI invalidate ["recent-tasks"] để bật lại poll queue (giống
 * useChangeEmail/useRemoveMembers) → watcher trong Members.tsx bắt được khi task
 * COMPLETED → tự refresh ["members"] mà không cần F5.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { handleCommandBan } from "../lib/commandBan";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import { triggerExtensionRun } from "./useExtensionTrigger";
import type { Member, TransferPreview } from "../types";

/** Tính trước phép chuyển hạn. `enabled=false` khi email chưa hợp lệ. */
export function useTransferPreview(
  workspaceId: string | undefined,
  memberId: string | undefined,
  targetEmail: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["transfer-preview", workspaceId, memberId, targetEmail],
    enabled: Boolean(workspaceId && memberId) && enabled,
    // Phép tính phụ thuộc "bây giờ" (phần hạn còn lại) → đừng cache lâu, nhưng
    // cũng đừng gọi lại mỗi lần focus: admin đọc xong là bấm ngay.
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: () =>
      api<TransferPreview>(
        `/api/v1/workspaces/${workspaceId}/members/${memberId}/transfer-subscription/preview`,
        { method: "POST", body: JSON.stringify({ target_email: targetEmail }) },
      ),
  });
}

export function useTransferSubscription(workspaceId: string | undefined) {
  const t = useT();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({
      memberId,
      targetEmail,
    }: {
      memberId: string;
      targetEmail: string;
    }) =>
      api<Member>(
        `/api/v1/workspaces/${workspaceId}/members/${memberId}/transfer-subscription`,
        { method: "POST", body: JSON.stringify({ target_email: targetEmail }) },
      ),
    onSuccess: (m) => {
      toast.success(t("member.transferExpiryOk", { email: m.email }));
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["added-members"] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks-global"] });
      qc.invalidateQueries({ queryKey: ["transfer-preview"] });
      triggerExtensionRun();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(e instanceof Error ? e.message : String(e));
    },
  });
}
