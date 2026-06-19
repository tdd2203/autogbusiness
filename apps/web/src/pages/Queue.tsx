import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { useAuth } from "../hooks/useAuth";
import { localeTag, useI18n, useT, useTranslateEnum } from "../i18n";
import type { QueueItem } from "../types";
import { SearchInput } from "./Members";
import { TaskTimingCell } from "../components/TaskTimingCell";
import { PayloadCell } from "../components/PayloadCell";

type Filter = "all" | "FAILED" | "COMPLETED" | "IN_PROGRESS" | "PENDING";

const STATUS_BADGE: Record<string, string> = {
  PENDING: "badge badge-neutral",
  IN_PROGRESS: "badge badge-warning",
  COMPLETED: "badge badge-success",
  FAILED: "badge badge-danger",
};

export default function Queue() {
  const t = useT();
  const tStatus = useTranslateEnum("status");
  const tTaskType = useTranslateEnum("taskType");
  const { hasPermission } = useAuth();

  const items = useQuery({
    queryKey: ["queue", "all"],
    queryFn: () => api<QueueItem[]>("/api/v1/queue?limit=200"),
    enabled: hasPermission("QUEUE_VIEW"),
    // Trang theo dõi queue: poll 5s khi có task chạy, idle giãn còn 15s (vẫn
    // bắt task do người/tab khác tạo). Xem lib/queuePolling.
    refetchInterval: queuePollInterval(5000, 15000),
  });

  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const data = items.data ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: data.length,
      FAILED: 0,
      COMPLETED: 0,
      IN_PROGRESS: 0,
      PENDING: 0,
    };
    for (const it of data) {
      if (it.status === "FAILED") c.FAILED++;
      else if (it.status === "COMPLETED") c.COMPLETED++;
      else if (it.status === "IN_PROGRESS") c.IN_PROGRESS++;
      else if (it.status === "PENDING") c.PENDING++;
    }
    return c;
  }, [data]);

  const filtered = useMemo(() => {
    let list = data;
    if (filter !== "all") list = list.filter((it) => it.status === filter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter(
        (it) =>
          (it.workspace_id ?? "").toLowerCase().includes(s) ||
          it.type.toLowerCase().includes(s) ||
          JSON.stringify(it.payload).toLowerCase().includes(s),
      );
    }
    return list;
  }, [data, filter, search]);

  return (
    <div className="page-fade">
      <div
        className="flex items-start justify-between"
        style={{ gap: 24, marginBottom: 32, flexWrap: "wrap" }}
      >
        <div>
          <div className="breadcrumb">
            {t("breadcrumb.system")}
            <span className="breadcrumb-sep">/</span>
            {t("nav.queue")}
          </div>
          <h1 className="display-h1">{t("queue.title")}</h1>
          <p className="page-sub">{t("queue.pageSub")}</p>
        </div>
      </div>

      <div className="metrics" style={{ marginBottom: 24 }}>
        <MetricSimple
          label={t("metrics.totalTasks")}
          value={counts.all}
          delta={t("metrics.last24h")}
        />
        <MetricSimple
          label={t("metrics.completed")}
          value={counts.COMPLETED}
          delta={
            counts.all > 0
              ? t("metrics.successRate", {
                  n: Math.round((counts.COMPLETED / counts.all) * 100),
                })
              : ""
          }
          deltaKind={counts.COMPLETED > 0 ? "up" : undefined}
        />
        <MetricSimple
          label={t("metrics.failed")}
          value={counts.FAILED}
          delta={
            counts.all > 0
              ? t("metrics.failureRate", {
                  n: Math.round((counts.FAILED / counts.all) * 100),
                })
              : ""
          }
          deltaKind={counts.FAILED > 0 ? "down" : undefined}
        />
        <MetricSimple
          label={t("metrics.inProgress")}
          value={counts.IN_PROGRESS + counts.PENDING}
          delta={t("metrics.runningHint")}
        />
      </div>

      <div className="flex flex-wrap gap-2" style={{ marginBottom: 16 }}>
        <Chip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={t("queue.filterAll")}
          count={counts.all}
        />
        <Chip
          active={filter === "FAILED"}
          onClick={() => setFilter("FAILED")}
          label={t("queue.filterFailed")}
          count={counts.FAILED}
        />
        <Chip
          active={filter === "COMPLETED"}
          onClick={() => setFilter("COMPLETED")}
          label={t("queue.filterCompleted")}
          count={counts.COMPLETED}
        />
        <Chip
          active={filter === "IN_PROGRESS"}
          onClick={() => setFilter("IN_PROGRESS")}
          label={t("queue.filterInProgress")}
          count={counts.IN_PROGRESS}
        />
        <Chip
          active={filter === "PENDING"}
          onClick={() => setFilter("PENDING")}
          label={t("queue.filterPending")}
          count={counts.PENDING}
        />
      </div>

      <div className="table-card">
        <div className="table-head">
          <div className="table-title">{t("queue.recentTitle")}</div>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("queue.searchPlaceholder")}
          />
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("queue.colTime")}</th>
                <th>{t("queue.colWorkspace")}</th>
                <th>{t("queue.colType")}</th>
                <th>{t("queue.colStatus")}</th>
                <th>{t("queue.colPayload")}</th>
                <th>{t("queue.colResult")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.id}>
                  <td>
                    <TaskTimingCell task={it} />
                  </td>
                  <td>
                    {it.workspace_id ? (
                      <Link
                        to={`/workspaces/${it.workspace_id}/members`}
                        style={{ textDecoration: "none" }}
                      >
                        <span className="role-tag">
                          {it.workspace_id.slice(0, 8)}
                        </span>
                      </Link>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className="action-name">{tTaskType(it.type)}</span>
                  </td>
                  <td>
                    <span
                      className={STATUS_BADGE[it.status] ?? "badge badge-neutral"}
                    >
                      {tStatus(it.status)}
                    </span>
                  </td>
                  <td>
                    <PayloadCell payload={it.payload} />
                  </td>
                  <td>
                    {it.error_code ? (
                      <ErrorCell
                        code={it.error_code}
                        message={it.error_message ?? ""}
                      />
                    ) : (
                      <PayloadCell payload={it.result} variant="success" />
                    )}
                  </td>
                </tr>
              ))}
              {!items.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("queue.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Hiển thị error_code + error_message dạng có thể expand. Nhiều error message
 * giờ chứa diag step-by-step nhiều dòng (xem [runner.ts ensureContentInjected])
 * — collapse 2 dòng đầu, click để xem full.
 */
export function ErrorCell({ code, message }: { code: string; message: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const hasMultiline = message.includes("\n");
  return (
    <div
      style={{
        fontSize: 12.5,
        color: "var(--danger)",
        lineHeight: 1.45,
        maxWidth: 380,
      }}
    >
      <strong className="mono">{code}:</strong>{" "}
      <span
        style={{
          whiteSpace: "pre-wrap",
          display: "inline-block",
          maxHeight: expanded ? "none" : "3em",
          overflow: "hidden",
          verticalAlign: "top",
        }}
      >
        {message}
      </span>
      {hasMultiline && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "block",
            marginTop: 4,
            background: "none",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            padding: 0,
            fontSize: 12,
            textDecoration: "underline",
          }}
        >
          {expanded ? t("queue.errorCollapse") : t("queue.errorExpand")}
        </button>
      )}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={active ? "filter-chip active" : "filter-chip"}
    >
      {label}
      {typeof count === "number" && <span className="count">{count}</span>}
    </button>
  );
}

export function TimeCell({ iso }: { iso: string }) {
  const { lang } = useI18n();
  const d = new Date(iso);
  const tag = localeTag(lang);
  return (
    <span className="timestamp">
      {d.toLocaleTimeString(tag)}
      <span className="date">{d.toLocaleDateString(tag)}</span>
    </span>
  );
}

function MetricSimple({
  label,
  value,
  delta,
  deltaKind,
}: {
  label: string;
  value: number | string;
  delta?: string;
  deltaKind?: "up" | "down";
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {delta && (
        <div
          className={
            "metric-delta" +
            (deltaKind === "up"
              ? " up"
              : deltaKind === "down"
              ? " down"
              : "")
          }
        >
          {delta}
        </div>
      )}
    </div>
  );
}

