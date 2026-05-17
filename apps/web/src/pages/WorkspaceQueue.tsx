import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import type { QueueItem } from "../types";

const STATUS_BADGE: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  IN_PROGRESS: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-rose-100 text-rose-800",
};

export default function WorkspaceQueue() {
  const t = useT();
  const { workspaceId } = useParams<{ workspaceId: string }>();

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["queue", workspaceId],
    queryFn: () =>
      api<QueueItem[]>(
        `/api/v1/queue?workspace_id=${workspaceId}&limit=200`,
      ),
    enabled: !!workspaceId,
    refetchInterval: 5000,
  });

  return (
    <div>
      <h2 className="text-lg font-medium mb-4">{t("queue.subtitleWs")}</h2>
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-700">
            <tr>
              <th className="p-3 font-medium">{t("queue.colTime")}</th>
              <th className="p-3 font-medium">{t("queue.colType")}</th>
              <th className="p-3 font-medium">{t("queue.colStatus")}</th>
              <th className="p-3 font-medium">{t("queue.colPayload")}</th>
              <th className="p-3 font-medium">{t("queue.colResult")}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {!isLoading && tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  {t("queue.emptyWs")}
                </td>
              </tr>
            )}
            {tasks.map((task) => (
              <tr key={task.id} className="border-t align-top">
                <td className="p-3 text-slate-600 whitespace-nowrap">
                  {new Date(task.created_at).toLocaleString()}
                </td>
                <td className="p-3 font-mono text-xs">{task.type}</td>
                <td className="p-3">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_BADGE[task.status] ?? "bg-slate-100"
                    }`}
                  >
                    {task.status}
                  </span>
                </td>
                <td className="p-3 text-xs font-mono text-slate-700 max-w-md break-all">
                  {JSON.stringify(task.payload)}
                </td>
                <td className="p-3 text-xs text-slate-700 max-w-md break-words">
                  {task.error_message ? (
                    <span className="text-rose-700">
                      {task.error_code}: {task.error_message}
                    </span>
                  ) : task.status === "IN_PROGRESS" && task.progress ? (
                    <span className="text-blue-700">
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
                  ) : task.result ? (
                    <span className="font-mono">
                      {JSON.stringify(task.result)}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
