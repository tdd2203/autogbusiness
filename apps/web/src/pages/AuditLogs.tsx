import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { Chip, TimeCell } from "./Queue";
import { SearchInput } from "./Members";

type AuditLog = {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  result: string;
  target_type: string | null;
  target_id: string | null;
  data: Record<string, unknown> | null;
};

type Filter = "all" | "admin" | "ext" | "failed";

const RESULT_BADGE: Record<string, string> = {
  SUCCESS: "badge badge-success",
  COMPLETED: "badge badge-success",
  FAILED: "badge badge-danger",
  PENDING: "badge badge-neutral",
};

export default function AuditLogs() {
  const t = useT();
  const logs = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => api<AuditLog[]>("/api/v1/audit-logs?limit=200"),
  });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const data = logs.data ?? [];
  const filtered = useMemo(() => {
    let list = data;
    if (filter === "admin") {
      list = list.filter(
        (l) =>
          l.actor_type !== "EXTENSION" &&
          l.actor_type !== "SYSTEM" &&
          !l.action.startsWith("QUEUE_"),
      );
    } else if (filter === "ext") {
      list = list.filter(
        (l) => l.actor_type === "EXTENSION" || l.action.startsWith("QUEUE_"),
      );
    } else if (filter === "failed") {
      list = list.filter((l) => l.result === "FAILED");
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter(
        (l) =>
          l.action.toLowerCase().includes(s) ||
          (l.actor_label ?? "").toLowerCase().includes(s) ||
          (l.target_id ?? "").toLowerCase().includes(s),
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
            {t("nav.auditLog")}
          </div>
          <h1 className="display-h1">{t("audit.title")}</h1>
          <p className="page-sub">{t("audit.pageSub")}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2" style={{ marginBottom: 16 }}>
        <Chip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={t("audit.filterAll")}
        />
        <Chip
          active={filter === "admin"}
          onClick={() => setFilter("admin")}
          label={t("audit.filterAdmin")}
        />
        <Chip
          active={filter === "ext"}
          onClick={() => setFilter("ext")}
          label={t("audit.filterExt")}
        />
        <Chip
          active={filter === "failed"}
          onClick={() => setFilter("failed")}
          label={t("audit.filterFailed")}
        />
      </div>

      <div className="table-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("audit.recentTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("audit.countLabel", {
                shown: filtered.length,
                total: data.length,
              })}
            </div>
          </div>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("audit.searchPlaceholder")}
          />
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("queue.colTime")}</th>
                <th>{t("audit.colActor")}</th>
                <th>{t("audit.colAction")}</th>
                <th>{t("queue.colStatus")}</th>
                <th>{t("audit.colTarget")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => {
                const isExt =
                  l.actor_type === "EXTENSION" || l.action.startsWith("QUEUE_");
                const initial = (l.actor_label ?? l.actor_type ?? "?")
                  .charAt(0)
                  .toUpperCase();
                const targetLabel = l.target_type
                  ? `${l.target_type}:${l.target_id?.slice(0, 8) ?? ""}…`
                  : "—";
                return (
                  <tr key={l.id}>
                    <td>
                      <TimeCell iso={l.timestamp} />
                    </td>
                    <td>
                      <div className="actor">
                        <div
                          className={
                            isExt ? "actor-avatar ext" : "actor-avatar"
                          }
                        >
                          {isExt ? "E" : initial}
                        </div>
                        <div>
                          <div className="actor-name">
                            {l.actor_label ??
                              (isExt ? t("audit.actorExt") : "—")}
                          </div>
                          <div className="actor-sub">
                            {l.actor_type.toLowerCase()}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="action-name">{l.action}</span>
                    </td>
                    <td>
                      <span
                        className={
                          RESULT_BADGE[l.result] ?? "badge badge-neutral"
                        }
                      >
                        {l.result.toLowerCase()}
                      </span>
                    </td>
                    <td className="cell-muted mono" style={{ fontSize: 11.5 }}>
                      {targetLabel}
                    </td>
                  </tr>
                );
              })}
              {!logs.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("common.empty")}
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
