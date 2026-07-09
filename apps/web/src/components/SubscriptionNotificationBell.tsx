/**
 * Chuông thông báo "đổi hạn dùng chờ duyệt" cho super-admin (song song NotificationBell
 * của thanh toán ở Layout). Badge = số yêu cầu; mở → dropdown gom theo người gửi, mỗi
 * dòng hiện email + hạn cũ → hạn đề xuất, kèm nút Duyệt / Từ chối. Ẩn khi count = 0.
 *
 * Dữ liệu + duyệt qua hooks/useSubscriptionApprovals. Xem subscription_requests.md (BE).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFormatDate, useT } from "../i18n";
import {
  useApproveSubscription,
  usePendingSubscriptionRequests,
} from "../hooks/useSubscriptionApprovals";
import type { SubscriptionRequestNotice } from "../types";

export function SubscriptionNotificationBell({
  count,
  label,
}: {
  count: number;
  label: string;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { data: notices, isLoading } = usePendingSubscriptionRequests(open);
  const approve = useApproveSubscription();

  const groups = useMemo(() => {
    const byUser = new Map<
      string,
      { name: string; ids: string[]; items: SubscriptionRequestNotice[] }
    >();
    for (const n of notices ?? []) {
      const name = n.requested_by_username ?? t("notif.unknownUser");
      const key = n.requested_by_username ?? " unknown";
      let g = byUser.get(key);
      if (!g) {
        g = { name, ids: [], items: [] };
        byUser.set(key, g);
      }
      g.ids.push(n.member_id);
      g.items.push(n);
    }
    return [...byUser.values()];
  }, [notices, t]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (count <= 0) return null;

  const fmtTarget = (n: SubscriptionRequestNotice) =>
    n.requested_end_at
      ? formatDate(n.requested_end_at)
      : t("subscription.unlimited");
  const fmtCurrent = (n: SubscriptionRequestNotice) =>
    n.current_end_at ? formatDate(n.current_end_at) : t("subscription.unlimited");

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${label} (${count})`}
        aria-expanded={open}
        title={`${label} (${count})`}
        style={{
          position: "relative",
          width: 36,
          height: 36,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: open ? "var(--surface-2)" : "var(--surface)",
          color: open ? "var(--ink)" : "var(--ink-2)",
          cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
        }}
      >
        {/* Icon đồng hồ/lịch — phân biệt với chuông thanh toán. */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          style={{ width: 18, height: 18 }}
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: -6,
            right: -6,
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            background: "var(--warning)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: "18px",
            textAlign: "center",
            boxShadow: "0 0 0 2px var(--surface)",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: 60,
            width: 360,
            maxWidth: "calc(100vw - 32px)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
            }}
          >
            {t("subscription.notifTitle")} · {count}
          </div>

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {isLoading && (
              <div style={{ padding: "16px 14px", fontSize: 12.5, color: "var(--ink-3)" }}>
                {t("common.loading")}
              </div>
            )}
            {!isLoading && (notices?.length ?? 0) === 0 && (
              <div style={{ padding: "16px 14px", fontSize: 12.5, color: "var(--ink-3)" }}>
                {t("notif.empty")}
              </div>
            )}
            {groups.map((g) => (
              <div key={g.name} style={{ borderBottom: "1px solid var(--border)" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "10px 14px 8px",
                  }}
                >
                  <div style={{ fontSize: 12.5, color: "var(--ink)", minWidth: 0 }}>
                    <strong>{g.name}</strong>{" "}
                    <span style={{ color: "var(--ink-3)" }}>
                      · {t("notif.groupCount", { n: g.ids.length })}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={approve.isPending}
                    title={t("subscription.approveAll", { name: g.name })}
                    onClick={() => approve.mutate({ ids: g.ids, approve: true })}
                    style={{
                      flexShrink: 0,
                      fontSize: 11.5,
                      fontWeight: 500,
                      padding: "4px 10px",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "var(--ink)",
                      color: "var(--surface)",
                      cursor: approve.isPending ? "default" : "pointer",
                      opacity: approve.isPending ? 0.6 : 1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("subscription.approveAllShort")}
                  </button>
                </div>
                {g.items.map((n) => (
                  <div
                    key={n.member_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 14px 10px",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontFamily: "var(--font-mono)",
                          color: "var(--ink-2)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {n.email}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {n.workspace_name ? `${n.workspace_name} · ` : ""}
                        {fmtCurrent(n)} → <strong>{fmtTarget(n)}</strong>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button
                        type="button"
                        disabled={approve.isPending}
                        title={t("subscription.approve")}
                        aria-label={t("subscription.approve")}
                        onClick={() =>
                          approve.mutate({ ids: [n.member_id], approve: true })
                        }
                        style={{
                          width: 28,
                          height: 28,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "var(--radius)",
                          border: "1px solid var(--border)",
                          background: "var(--surface)",
                          color: "var(--ink-2)",
                          cursor: approve.isPending ? "default" : "pointer",
                          opacity: approve.isPending ? 0.6 : 1,
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          style={{ width: 14, height: 14 }}
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        disabled={approve.isPending}
                        title={t("subscription.reject")}
                        aria-label={t("subscription.reject")}
                        onClick={() =>
                          approve.mutate({ ids: [n.member_id], approve: false })
                        }
                        style={{
                          width: 28,
                          height: 28,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "var(--radius)",
                          border: "1px solid var(--border)",
                          background: "var(--surface)",
                          color: "var(--ink-3)",
                          cursor: approve.isPending ? "default" : "pointer",
                          opacity: approve.isPending ? 0.6 : 1,
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          style={{ width: 14, height: 14 }}
                        >
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
