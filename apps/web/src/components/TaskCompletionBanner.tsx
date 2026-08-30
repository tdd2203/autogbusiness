/**
 * Banner thông báo kết quả sau khi 1 task queue COMPLETED hoặc FAILED.
 *
 * Render khác nhau theo `task.type` để show data hữu ích:
 *   SYNC_DATA    → tổng members, +created, ~updated
 *   SYNC_BILLING → seat used/total, plan, billing_status
 *   INVITE/REMOVE/CHANGE_ROLE → email + role
 *
 * RIÊNG INVITE_MEMBER (user 29/8/2026): liệt kê ĐỦ từng email kèm trạng thái của
 * chính nó, thay vì một dòng "verify 7/8" cắt danh sách còn 3 email. Người dùng hỏi
 * "email nào đã mời được", con số không trả lời được câu đó. Xem `lib/inviteOutcome`.
 * Task mời cũ (chưa có `invite_outcome`) vẫn rơi về dòng tóm tắt như trước.
 *
 * Dismissible. Caller tự manage auto-dismiss qua state (banner KHÔNG tự ẩn).
 */

import type { QueueItem } from "../types";
import { useT } from "../i18n";
import {
  readInviteOutcome,
  type InviteOutcomeRow,
  type InviteOutcomeView,
} from "../lib/inviteOutcome";

type SyncMismatch = {
  expected_total?: number | null;
  scraped_active?: number;
  db_active?: number;
  extra_in_autogpt?: string[];
  missing_in_autogpt?: string[];
  unresolved_count?: number;
};

type SyncDataResult = {
  total?: number;
  created?: number;
  updated?: number;
  chunks?: number;
  mismatch?: SyncMismatch | null;
  // Đích danh email biến động sau sync (backend cap 50/list; count là số đầy đủ):
  // created = ChatGPT có mà hệ thống chưa có (auto-create); removed = hệ thống
  // có mà ChatGPT không còn (đã mark removed).
  created_emails?: string[];
  removed_emails?: string[];
};

/** Gộp email lệch thành 1 chuỗi ngắn (tối đa `max` email) cho message. */
function joinMismatchEmails(emails: string[], max = 5): string {
  const head = emails.slice(0, max).join(", ");
  return emails.length > max ? `${head} +${emails.length - max}` : head;
}

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
      let base = t("sync.completedMembers", {
        total: r.total ?? 0,
        created: r.created ?? 0,
        updated: r.updated ?? 0,
      });
      // Biến động thành viên sau sync → liệt kê đích danh email (user 2026-08-01:
      // "email này trong ChatGPT nhưng không có trong hệ thống" và ngược lại).
      if (r.created_emails?.length) {
        base += `\n➕ ${t("sync.changedCreated", {
          n: r.created ?? r.created_emails.length,
          list: joinMismatchEmails(r.created_emails, 10),
        })}`;
      }
      if (r.removed_emails?.length) {
        base += `\n➖ ${t("sync.changedRemoved", {
          n: r.removed_emails.length,
          list: joinMismatchEmails(r.removed_emails, 10),
        })}`;
      }
      // Lệch số lượng sau sync → nối 1 dòng cảnh báo đích danh email.
      const mm = r.mismatch;
      if (mm) {
        const parts: string[] = [];
        if (mm.extra_in_autogpt?.length) {
          parts.push(
            t("sync.mismatchExtra", {
              n: mm.extra_in_autogpt.length,
              list: joinMismatchEmails(mm.extra_in_autogpt),
            }),
          );
        }
        if (mm.missing_in_autogpt?.length) {
          parts.push(
            t("sync.mismatchMissing", {
              n: mm.missing_in_autogpt.length,
              list: joinMismatchEmails(mm.missing_in_autogpt),
            }),
          );
        }
        if (mm.unresolved_count) {
          parts.push(t("sync.mismatchUnresolved", { n: mm.unresolved_count }));
        }
        const detail = parts.join(" · ");
        return `${base}\n⚠ ${t("sync.mismatchLead", {
          chatgpt: mm.expected_total ?? "?",
          autogpt: mm.db_active ?? "?",
        })}${detail ? ` — ${detail}` : ""}`;
      }
      return base;
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
    case "CHANGE_LICENSE_TYPE": {
      const email = (task.payload?.email as string | undefined) ?? "";
      const license =
        (task.payload?.new_license_type as string | undefined) ?? "";
      return t("sync.completedChangeLicenseType", { email, license });
    }
    default:
      return task.type;
  }
}

/**
 * Chip trạng thái của một email — lối trình bày của chính ChatGPT admin: nền nhạt,
 * bo tròn hết cỡ, chữ nhỏ. Trạng thái nằm ở chip, KHÔNG nhuộm màu cả khung.
 */
const PILL: Record<
  InviteOutcomeRow["kind"],
  { labelKey: string; fg: string; bg: string; border: string }
> = {
  invited: {
    labelKey: "inviteOutcome.pill.invited",
    fg: "var(--success)",
    bg: "var(--success-bg)",
    border: "var(--success-border)",
  },
  failed: {
    labelKey: "inviteOutcome.pill.failed",
    fg: "var(--danger)",
    bg: "var(--danger-bg)",
    border: "var(--danger-border)",
  },
};

/** Dòng tóm tắt "5 đã mời · 2 chưa xác minh · 1 lỗi" — bỏ qua nhóm rỗng. */
export function outcomeSummary(view: InviteOutcomeView, t: Translator): string {
  const parts: string[] = [];
  if (view.counts.sent)
    parts.push(t("inviteOutcome.countInvited", { n: view.counts.sent }));
  if (view.counts.failed)
    parts.push(t("inviteOutcome.countFailed", { n: view.counts.failed }));
  return parts.join(" · ");
}

/**
 * Danh sách email của một lệnh mời. KHÔNG cắt bớt, KHÔNG gộp "+5" — cắt đúng chỗ
 * này là quay lại đúng cái bệnh cũ (không biết email nào đã mời được). Mẻ đông thì
 * cho khung tự cuộn.
 *
 * Mỗi email một hàng có gạch ngăn, email bên trái, chip trạng thái bên phải — đúng
 * lối bảng thành viên của ChatGPT admin, để đọc lướt theo cột chip là ra ngay email
 * nào chưa đi được.
 */
export function InviteOutcomeList({
  view,
  t,
}: {
  view: InviteOutcomeView;
  t: Translator;
}) {
  return (
    <ul
      style={{
        listStyle: "none",
        margin: "10px 0 0",
        padding: 0,
        maxHeight: 340,
        overflowY: "auto",
      }}
    >
      {view.rows.map((row, i) => {
        const pill = PILL[row.kind];
        return (
          <li
            key={`${row.kind}:${row.email}`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "8px 0",
              borderTop: i === 0 ? "none" : "1px solid var(--border)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--ink)",
                  wordBreak: "break-all",
                }}
              >
                {row.email}
              </div>
              {row.noteKey && (
                <div
                  style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}
                >
                  {t(row.noteKey)}
                </div>
              )}
            </div>
            <span
              style={{
                flexShrink: 0,
                fontSize: 12,
                lineHeight: 1.5,
                padding: "1px 9px",
                borderRadius: 999,
                color: pill.fg,
                background: pill.bg,
                border: `1px solid ${pill.border}`,
                whiteSpace: "nowrap",
              }}
            >
              {t(pill.labelKey)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Nút đóng — chữ X mờ ở góc, hiện rõ khi rê chuột. */
function DismissButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
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
  );
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
  const outcome = readInviteOutcome(task);
  const typeLabel = t(`sync.type.${task.type}`);
  const time = task.completed_at
    ? new Date(task.completed_at).toLocaleTimeString()
    : null;

  // ── LỆNH MỜI: thẻ trắng trung tính, trạng thái nằm ở chip từng dòng ──────────
  //
  // Không nhuộm màu cả khung (user 29/8/2026: "làm như cách ChatGPT thông báo").
  // Mảng xanh/vàng/đỏ nguyên khung đọc như một tiếng chuông báo động cho CẢ MẺ,
  // trong khi mẻ mời gần như luôn pha trộn — thứ cần phân biệt là từng email, và
  // đó đúng là việc của chip. Tiêu đề vẫn đi theo kết cục, không theo status task.
  if (outcome) {
    return (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          padding: "12px 14px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            {t(outcome.titleKey)}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
            {[outcomeSummary(outcome, t), contextLabel, time]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {/* Lý do hỏng là của CẢ NHÓM (một mẻ chỉ mang một mã lỗi) — nói một lần
              ở đây, không lặp xuống từng dòng email. */}
          {(outcome.failureText || outcome.failureKey) && (
            <div
              style={{
                fontSize: 12,
                color: "var(--danger)",
                background: "var(--danger-bg)",
                border: "1px solid var(--danger-border)",
                borderRadius: "var(--radius)",
                padding: "6px 9px",
                marginTop: 8,
                lineHeight: 1.5,
              }}
            >
              {outcome.failureText ?? t(outcome.failureKey!)}
            </div>
          )}
          <InviteOutcomeList view={outcome} t={t} />
        </div>
        <DismissButton onClick={onDismiss} label={t("common.close")} />
      </div>
    );
  }

  const detail = renderDetail(task, t);
  const title = isError ? t("sync.failedTitle") : t("sync.completedTitle");

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
          style={{
            marginTop: 4,
            wordBreak: "break-word",
            whiteSpace: "pre-line",
          }}
        >
          {detail}
        </div>
        {time && (
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              marginTop: 4,
              fontFamily: "var(--font-mono)",
            }}
          >
            {time}
          </div>
        )}
      </div>
      <DismissButton onClick={onDismiss} label={t("common.close")} />
    </div>
  );
}
