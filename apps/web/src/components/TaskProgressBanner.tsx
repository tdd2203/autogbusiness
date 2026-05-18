/**
 * Banner hiển thị tiến trình real-time của 1 task đang chạy trên extension.
 *
 * Dùng cho mọi loại task gọi extension (SYNC_DATA / SYNC_BILLING /
 * INVITE_MEMBER / REMOVE_MEMBER / CHANGE_ROLE / REVOKE_INVITES). Extension
 * report progress qua `reportProgress(taskId, { phase, message, current })`
 * → backend lưu vào `task.progress` → polling 2s ở queryKey ["recent-tasks"]
 * sẽ pick up.
 *
 * Title được sinh theo type+payload (vd "Mời 5 thành viên" /
 * "Xoá user@x.com"). Sub-message ưu tiên `progress.message` từ extension,
 * fallback sang i18n theo phase.
 */

import type { QueueItem } from "../types";
import { useT } from "../i18n";

type Translator = (k: string, p?: Record<string, string | number>) => string;

function getTaskTitle(task: QueueItem, t: Translator): string {
  const payload = task.payload ?? {};
  switch (task.type) {
    case "SYNC_DATA":
      return t("task.title.SYNC_DATA");
    case "SYNC_BILLING":
      return t("task.title.SYNC_BILLING");
    case "INVITE_MEMBER": {
      const emails = payload.emails as string[] | undefined;
      const email = payload.email as string | undefined;
      if (Array.isArray(emails) && emails.length > 1) {
        return t("task.title.INVITE_MEMBER_MANY", { n: emails.length });
      }
      const one = emails?.[0] ?? email ?? "";
      return t("task.title.INVITE_MEMBER_ONE", { email: one });
    }
    case "REMOVE_MEMBER": {
      const email = (payload.email as string | undefined) ?? "";
      return t("task.title.REMOVE_MEMBER", { email });
    }
    case "CHANGE_ROLE": {
      const email = (payload.email as string | undefined) ?? "";
      const role = (payload.new_role as string | undefined) ?? "";
      return t("task.title.CHANGE_ROLE", { email, role });
    }
    case "REVOKE_INVITES": {
      const emails = payload.emails as string[] | undefined;
      return t("task.title.REVOKE_INVITES", { n: emails?.length ?? 0 });
    }
    default:
      return task.type;
  }
}

export function TaskProgressBanner({
  task,
  onCancel,
  canceling,
}: {
  task: QueueItem;
  onCancel?: () => void;
  canceling?: boolean;
}) {
  const t = useT();
  const p = task.progress ?? {};
  const phase = (p.phase as string | undefined) ?? task.status;
  const current = p.current as number | undefined;
  // Ưu tiên message bằng tiếng đã localize từ extension. Fallback theo phase.
  const message =
    (p.message as string | undefined) ?? t(`progress.${phase}`);
  const showCount = typeof current === "number";

  const title = getTaskTitle(task, t);

  const createdAt = new Date(task.created_at).getTime();
  const ageMs = Date.now() - createdAt;
  const isStale =
    (task.status === "PENDING" && ageMs > 60_000) ||
    (task.status === "IN_PROGRESS" && ageMs > 90_000 && !p.phase);

  return (
    <div className="notice">
      <div className="notice-icon">
        <div className="spinner" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <div className="notice-title" style={{ minWidth: 0, wordBreak: "break-word" }}>
            {title}
          </div>
          {showCount && (
            <div
              style={{
                fontSize: 12,
                color: "var(--info)",
                fontFamily: "var(--font-mono)",
                marginLeft: "auto",
                whiteSpace: "nowrap",
              }}
            >
              {t("progress.collected", { n: current ?? 0 })}
            </div>
          )}
        </div>
        <div className="notice-body">{message}</div>
        {isStale && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11.5,
              color: "var(--warning)",
              background: "var(--warning-bg)",
              border: "1px solid #fde68a",
              borderRadius: 4,
              padding: "4px 8px",
            }}
          >
            ⚠ {t("queue.stuckHint")}
          </div>
        )}
      </div>
      {onCancel && (
        <button
          onClick={onCancel}
          disabled={canceling}
          className="btn btn-ghost btn-sm"
          style={{ borderColor: "#fecaca", color: "var(--danger)" }}
        >
          {canceling ? t("queue.cancelOkBusy") : t("queue.cancel")}
        </button>
      )}
    </div>
  );
}
