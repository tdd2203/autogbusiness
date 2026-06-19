import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { useT, useTranslateEnum } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import type { QueueItem } from "../types";
import { Chip, ErrorCell } from "./Queue";
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

export default function WorkspaceQueue() {
  const t = useT();
  const tStatus = useTranslateEnum("status");
  const tTaskType = useTranslateEnum("taskType");
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { user } = useAuth();
  const isSuper = !!user?.is_super_admin;

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["queue", workspaceId],
    queryFn: () =>
      api<QueueItem[]>(
        `/api/v1/queue?workspace_id=${workspaceId}&limit=200`,
      ),
    enabled: !!workspaceId,
    // Trang theo dõi queue: poll 5s khi có task chạy, idle giãn còn 15s. Xem
    // lib/queuePolling.
    refetchInterval: queuePollInterval(5000, 15000),
  });

  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: tasks.length,
      FAILED: 0,
      COMPLETED: 0,
      IN_PROGRESS: 0,
      PENDING: 0,
    };
    for (const it of tasks) {
      if (it.status === "FAILED") c.FAILED++;
      else if (it.status === "COMPLETED") c.COMPLETED++;
      else if (it.status === "IN_PROGRESS") c.IN_PROGRESS++;
      else if (it.status === "PENDING") c.PENDING++;
    }
    return c;
  }, [tasks]);

  const filtered = useMemo(() => {
    let list = tasks;
    if (filter !== "all") list = list.filter((it) => it.status === filter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter(
        (it) =>
          it.type.toLowerCase().includes(s) ||
          JSON.stringify(it.payload).toLowerCase().includes(s),
      );
    }
    return list;
  }, [tasks, filter, search]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div className="display-h3">{t("queue.subtitleWs")}</div>
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
                <th>{t("queue.colType")}</th>
                <th>{t("queue.colStatus")}</th>
                {isSuper && <th>Người yêu cầu</th>}
                <th>{t("queue.colPayload")}</th>
                <th>{t("queue.colResult")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={isSuper ? 6 : 5} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={isSuper ? 6 : 5} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("queue.emptyWs")}
                  </td>
                </tr>
              )}
              {filtered.map((task) => (
                <tr key={task.id}>
                  <td>
                    <TaskTimingCell task={task} />
                  </td>
                  <td>
                    <span className="action-name">{tTaskType(task.type)}</span>
                  </td>
                  <td>
                    <span
                      className={STATUS_BADGE[task.status] ?? "badge badge-neutral"}
                    >
                      {tStatus(task.status)}
                    </span>
                  </td>
                  {isSuper && (
                    <td>
                      <span className="action-name">
                        {task.created_by_username ?? "—"}
                      </span>
                    </td>
                  )}
                  <td>
                    <PayloadCell payload={task.payload} />
                  </td>
                  <td>
                    {task.error_code || task.error_message ? (
                      <ErrorCell
                        code={task.error_code ?? ""}
                        message={task.error_message ?? ""}
                      />
                    ) : task.status === "IN_PROGRESS" && task.progress ? (
                      <span style={{ color: "var(--info)", fontSize: 12.5 }}>
                        {(task.progress.message as string | undefined) ??
                          t(`progress.${task.progress.phase ?? "IN_PROGRESS"}`)}
                        {typeof task.progress.current === "number" && (
                          <>
                            {" "}
                            ({String(task.progress.current)}
                            {typeof task.progress.total === "number"
                              ? `/${task.progress.total}`
                              : ""}
                            )
                          </>
                        )}
                      </span>
                    ) : (
                      <PayloadCell payload={task.result} variant="success" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
