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
      // Bulk-invite payload có `emails: string[]`. Single-invite có `email`.
      const emails = (task.payload?.emails as string[] | undefined) ?? [];
      const singleEmail = (task.payload?.email as string | undefined) ?? "";
      const role = (task.payload?.role as string | undefined) ?? "";
      const r = (task.result ?? {}) as {
        verified_count?: number;
        unverified_count?: number;
        unverified_emails?: string[];
        verify_scrape_failed?: boolean;
      };
      const total = emails.length || (singleEmail ? 1 : 0);
      const emailLabel = emails.length > 0 ? `${emails.length} email` : singleEmail;
      // Verify: nếu có thông tin verify thì show "verified X/Y"; nếu không thì
      // fallback message cũ.
      if (typeof r.verified_count === "number" && total > 0) {
        if (r.verify_scrape_failed) {
          return t("sync.completedInviteVerifyFailed", {
            email: emailLabel,
            role,
            total,
          });
        }
        const unverifiedList =
          (r.unverified_emails ?? []).slice(0, 3).join(", ") +
          ((r.unverified_emails ?? []).length > 3
            ? ` +${(r.unverified_emails ?? []).length - 3}`
            : "");
        if (r.unverified_count && r.unverified_count > 0) {
          return t("sync.completedInvitePartial", {
            verified: r.verified_count,
            total,
            role,
            unverified: unverifiedList,
          });
        }
        return t("sync.completedInviteVerified", {
          verified: r.verified_count,
          total,
          role,
        });
      }
      return t("sync.completedInvite", { email: emailLabel, role });
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
      className={isError ? "notice danger" : "notice success"}
      style={{ alignItems: "flex-start" }}
    >
      <div
        className="notice-icon"
        aria-hidden
        style={{
          color: isError ? "var(--danger)" : "var(--success)",
          fontWeight: 600,
        }}
      >
        {isError ? "✕" : "✓"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="notice-title">
          {title} ·{" "}
          <span style={{ fontWeight: 400, opacity: 0.85 }}>{typeLabel}</span>
          {contextLabel && (
            <span style={{ fontWeight: 400, opacity: 0.85 }}>
              {" "}
              · {contextLabel}
            </span>
          )}
        </div>
        <div
          className="notice-body"
          style={{ marginTop: 4, wordBreak: "break-word" }}
        >
          {detail}
        </div>
        {task.completed_at && (
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              marginTop: 4,
              fontFamily: "var(--font-mono)",
            }}
          >
            {new Date(task.completed_at).toLocaleTimeString()}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("common.close")}
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "inherit",
          opacity: 0.5,
          padding: "0 6px",
          fontSize: 14,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
      >
        ✕
      </button>
    </div>
  );
}
