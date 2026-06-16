/**
 * Chức năng: Billing actions per-workspace (sync billing + huỷ billing task) — phía web/dashboard.
 *
 * ⚠️ ĐỌC `useBillingActions.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Gom toàn bộ logic nghiệp vụ billing (trước đây nằm inline trong `WorkspaceLayout.tsx`):
 *   - syncBilling        → POST /sync-billing (enqueue task SYNC_BILLING; confirm nếu đã sync trước đó)
 *   - cancelBillingTask  → POST /queue/{id}/cancel (huỷ task SYNC_BILLING đang chạy)
 *   - theo dõi vòng đời billing task: activeBillingTask / lastBillingTask / showBillingCompletion
 *     + auto-refresh workspace khi COMPLETED + auto-dismiss banner sau 10s.
 *
 * Backend chỉ enqueue task SYNC_BILLING; extension mới scrape /admin/billing trên ChatGPT —
 * vì vậy hook poll recent-tasks (refetchInterval 2s) để hiện banner tiến trình/hoàn tất.
 *
 * Phần TÍNH GIÁ / render (WorkspaceBillingPanel.tsx) vẫn là logic thuần, không thuộc hook này.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { confirm, toast } from "../components/Toast";
import type { QueueItem, Workspace } from "../types";

export function useBillingActions(
  workspaceId: string | undefined,
  workspace: Workspace | undefined,
  recentTasks: QueueItem[],
) {
  const t = useT();
  const qc = useQueryClient();
  const [lastBillingTaskId, setLastBillingTaskId] = useState<string | null>(null);

  const activeBillingTask = recentTasks.find(
    (t) =>
      t.type === "SYNC_BILLING" &&
      (t.status === "PENDING" || t.status === "IN_PROGRESS"),
  );
  const lastBillingTask = lastBillingTaskId
    ? recentTasks.find((t) => t.id === lastBillingTaskId) ?? null
    : null;
  const showBillingCompletion =
    lastBillingTask?.status === "COMPLETED" ||
    lastBillingTask?.status === "FAILED";

  // Khi billing task COMPLETED → refresh workspace để bảng billing show data mới
  useEffect(() => {
    if (lastBillingTask?.status === "COMPLETED") {
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    }
  }, [lastBillingTask?.status, qc, workspaceId]);

  // Auto-dismiss completion banner sau 10s khi COMPLETED (giữ lại FAILED để user đọc)
  useEffect(() => {
    if (!showBillingCompletion || lastBillingTask?.status !== "COMPLETED") return;
    const timer = setTimeout(() => setLastBillingTaskId(null), 10_000);
    return () => clearTimeout(timer);
  }, [showBillingCompletion, lastBillingTask?.status]);

  const cancelBillingTask = useMutation({
    mutationFn: async (taskId: string) => {
      const ok = await confirm(t("queue.cancelConfirm", { type: "SYNC_BILLING" }), {
        title: t("queue.cancelConfirmTitle"),
        okText: t("queue.cancelOk"),
        cancelText: t("common.cancel"),
        danger: true,
      });
      if (!ok) throw new Error("__user_cancel__");
      return api<{ id: string; status: string }>(
        `/api/v1/queue/${taskId}/cancel`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("queue.cancelOkToast"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      toast.error(
        t("queue.cancelError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  });

  const syncBilling = useMutation({
    mutationFn: async () => {
      if (workspace?.last_billing_synced_at) {
        const ok = await confirm(
          t("billing.alreadySyncedWarn", {
            time: new Date(workspace.last_billing_synced_at).toLocaleString("vi-VN"),
          }),
          {
            title: t("billing.workspaceTitle"),
            okText: t("billing.syncAgainAnyway"),
            cancelText: t("common.cancel"),
          },
        );
        if (!ok) throw new Error("__user_cancel__");
      }
      return api<{ queue_item_id: string }>(
        `/api/v1/workspaces/${workspaceId}/sync-billing`,
        { method: "POST" },
      );
    },
    onSuccess: (resp) => {
      toast.success(t("billing.syncQueuedToast"));
      setLastBillingTaskId(resp.queue_item_id);
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      const msg = e instanceof ApiError ? String(e.detail) : String(e);
      toast.error(t("billing.syncErrorToast", { error: msg }));
    },
  });

  return {
    syncBilling,
    cancelBillingTask,
    activeBillingTask,
    lastBillingTask,
    showBillingCompletion,
    setLastBillingTaskId,
  };
}
