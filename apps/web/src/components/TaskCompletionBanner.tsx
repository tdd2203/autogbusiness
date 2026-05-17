/**
 * Banner thông báo kết quả sau khi 1 task queue COMPLETED hoặc FAILED.
 *
 * Render khác nhau theo `task.type` để show data hữu ích:
 *   SYNC_DATA    → tổng members, +created, ~updated
 *   SYNC_BILLING → seat used/total, plan, billing_status
 *   INVITE/REMOVE/CHANGE_ROLE → email + role
 *
 * Dismissible. Caller tự manage auto-dismiss qua state (banner KHÔNG tự ẩn).
 */

import type { QueueItem } from "../types";
import { useT } from "../i18n";

type SyncDataResult = {
  total?: number;
  created?: number;
  updated?: number;
  chunks?: number;
};

type SyncBillingResult = {
  seat_total?: number | null;
  seat_used?: number | null;
  plan?: string | null;
  billing_status?: string | null;
};

type Translator = (k: string, p?: Record<string, string | number>) => string;

function renderDetail(task: QueueItem, t: Translator): string {
  if (task.status === "FAILED") {
    return task.error_message ?? task.error_code ?? t("sync.failedUnknown");
  }
  switch (task.type) {
    case "SYNC_DATA": {
      const r = (task.result ?? {}) as SyncDataResult;
      return t("sync.completedMembers", {
        total: r.total ?? 0,
        created: r.created ?? 0,
        updated: r.updated ?? 0,
      });
    }
    case "SYNC_BILLING": {
      const r = (task.result ?? {}) as SyncBillingResult;
      return t("sync.completedBilling", {
        used: r.seat_used ?? "?",
        total: r.seat_total ?? "?",
        plan: r.plan ?? "?",
        status: r.billing_status ?? "?",
      });
    }
    case "INVITE_MEMBER": {
      const email = (task.payload?.email as string | undefined) ?? "";
      const role = (task.payload?.role as string | undefined) ?? "";
      return t("sync.completedInvite", { email, role });
    }
    case "REMOVE_MEMBER": {
      const email = (task.payload?.email as string | undefined) ?? "";
      return t("sync.completedRemove", { email });
    }
    case "CHANGE_ROLE": {
      const email = (task.payload?.email as string | undefined) ?? "";
      const role = (task.payload?.new_role as string | undefined) ?? "";
      return t("sync.completedChangeRole", { email, role });
    }
    default:
      return task.type;
  }
}

export function TaskCompletionBanner({
  task,
  onDismiss,
  contextLabel,
}: {
  task: QueueItem;
  onDismiss: () => void;
  /** Hiển thị thêm context (vd tên workspace) khi banner ở page list. */
  contextLabel?: string;
}) {
  const t = useT();
  const isError = task.status === "FAILED";
  const detail = renderDetail(task, t);
  const title = isError ? t("sync.failedTitle") : t("sync.completedTitle");
  const typeLabel = t(`sync.type.${task.type}`);

  return (
    <div
      role="status"
      className={`rounded p-3 mb-4 text-sm flex items-start gap-3 ${
        isError
          ? "bg-rose-50 border border-rose-300 text-rose-900"
          : "bg-emerald-50 border border-emerald-300 text-emerald-900"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {title} · <span className="font-normal opacity-80">{typeLabel}</span>
          {contextLabel && (
            <span className="font-normal opacity-80"> · {contextLabel}</span>
          )}
        </div>
        <div className="mt-1 break-words">{detail}</div>
        {task.completed_at && (
          <div className="text-xs opacity-70 mt-1">
            {new Date(task.completed_at).toLocaleTimeString()}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-current opacity-50 hover:opacity-100 px-2"
        aria-label={t("common.close")}
      >
        ✕
      </button>
    </div>
  );
}
