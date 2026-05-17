import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";

type QueueItem = {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  workspace_id: string | null;
  created_by_id: string | null;
  created_at: string;
  picked_at: string | null;
  completed_at: string | null;
};

export default function Queue() {
  const t = useT();
  const { hasPermission } = useAuth();

  const items = useQuery({
    queryKey: ["queue", "all"],
    queryFn: () => api<QueueItem[]>("/api/v1/queue?limit=200"),
    enabled: hasPermission("QUEUE_VIEW"),
    refetchInterval: 5000,
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-2">{t("queue.title")}</h1>
      <p className="text-sm text-slate-600 mb-6">
        {t("queue.subtitle")}{" "}
        <Link to="/workspaces" className="underline">
          {t("nav.workspaces")}
        </Link>
        .
      </p>

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2">{t("queue.colTime")}</th>
              <th className="text-left px-4 py-2">{t("queue.colWorkspace")}</th>
              <th className="text-left px-4 py-2">{t("queue.colType")}</th>
              <th className="text-left px-4 py-2">{t("queue.colStatus")}</th>
              <th className="text-left px-4 py-2">{t("queue.colPayload")}</th>
              <th className="text-left px-4 py-2">{t("queue.colResult")}</th>
            </tr>
          </thead>
          <tbody>
            {items.data?.map((it) => (
              <tr key={it.id} className="border-t align-top">
                <td className="px-4 py-2 whitespace-nowrap text-slate-600">
                  {new Date(it.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-xs font-mono">
                  {it.workspace_id ? (
                    <Link
                      to={`/workspaces/${it.workspace_id}/members`}
                      className="text-slate-700 hover:underline"
                    >
                      {it.workspace_id.slice(0, 8)}…
                    </Link>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{it.type}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={it.status} />
                </td>
                <td className="px-4 py-2 font-mono text-xs max-w-xs break-all">
                  {JSON.stringify(it.payload)}
                </td>
                <td className="px-4 py-2 text-xs max-w-xs break-words">
                  {it.error_code ? (
                    <span className="text-rose-600">
                      {it.error_code}: {it.error_message}
                    </span>
                  ) : it.result ? (
                    <span className="text-emerald-700 font-mono">
                      {JSON.stringify(it.result)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {!items.isLoading && (items.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  {t("queue.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "COMPLETED"
      ? "bg-emerald-100 text-emerald-700"
      : status === "FAILED"
      ? "bg-rose-100 text-rose-700"
      : status === "IN_PROGRESS"
      ? "bg-amber-100 text-amber-700"
      : "bg-slate-200 text-slate-700";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}
