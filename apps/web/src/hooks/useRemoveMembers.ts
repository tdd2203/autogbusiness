/**
 * Chức năng: Remove Member (xoá thành viên) — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useRemoveMembers.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Gom 3 mutation xoá member (trước đây nằm inline trong `pages/Members.tsx`):
 *   - remove              → DELETE 1 member
 *   - bulkRemoveSelected  → POST /bulk-remove (nhiều member theo id)
 *   - cleanupExpired      → POST /cleanup-expired (dọn member hết hạn)
 *
 * Backend chỉ enqueue task REMOVE_MEMBER; extension mới thực thi trên ChatGPT —
 * vì vậy onSuccess gọi triggerExtensionRun() để đánh thức extension chạy ngay.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { handleCommandBan } from "../lib/commandBan";
import { useT } from "../i18n";
import { toast } from "../components/Toast";
import { triggerExtensionRun } from "./useExtensionTrigger";

export function useRemoveMembers(
  workspaceId: string | undefined,
  opts?: { onBulkRemoveCleared?: () => void },
) {
  const t = useT();
  const qc = useQueryClient();

  const remove = useMutation({
    mutationFn: (memberId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${memberId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      // PHẢI invalidate ["recent-tasks"] để KHỞI ĐỘNG LẠI poll queue (dừng khi
      // idle): task REMOVE_MEMBER vừa enqueue là PENDING → poll bật lại → watcher
      // trong Members.tsx bắt được lúc task COMPLETED → tự invalidate ["members"]
      // → member bị xoá biến mất ngay, KHỎI reload tay. (bulkRemoveSelected đã làm;
      // remove đơn trước đây sót → xoá xong list không tự cập nhật.)
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      handleCommandBan(e);
    },
  });

  const bulkRemoveSelected = useMutation({
    mutationFn: (memberIds: string[]) =>
      api<{ count: number; emails: string[]; skipped: string[] }>(
        `/api/v1/workspaces/${workspaceId}/members/bulk-remove`,
        { method: "POST", body: JSON.stringify({ member_ids: memberIds }) },
      ),
    onSuccess: (resp) => {
      toast.success(t("bulkRemove.resultQueued", { n: resp.count }));
      opts?.onBulkRemoveCleared?.();
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      triggerExtensionRun();
    },
    onError: (e) => {
      if (handleCommandBan(e)) return;
      toast.error(
        t("bulkRemove.resultError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });

  const cleanupExpired = useMutation({
    mutationFn: () =>
      api<{ count: number; emails: string[] }>(
        `/api/v1/workspaces/${workspaceId}/members/cleanup-expired`,
        { method: "POST" },
      ),
    onSuccess: (resp) => {
      toast.success(t("member.cleanupExpiredOk", { n: resp.count }));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
    },
  });

  return { remove, bulkRemoveSelected, cleanupExpired };
}
