import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";

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

export default function AuditLogs() {
  const t = useT();
  const logs = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => api<AuditLog[]>("/api/v1/audit-logs?limit=200"),
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">{t("audit.title")}</h1>
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2">{t("queue.colTime")}</th>
              <th className="text-left px-4 py-2">Actor</th>
              <th className="text-left px-4 py-2">Action</th>
              <th className="text-left px-4 py-2">{t("queue.colResult")}</th>
              <th className="text-left px-4 py-2">Target</th>
              <th className="text-left px-4 py-2">Data</th>
            </tr>
          </thead>
          <tbody>
            {logs.data?.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="px-4 py-2 whitespace-nowrap">
                  {new Date(l.timestamp).toLocaleString()}
                </td>
                <td className="px-4 py-2">
                  <span className="font-mono text-xs text-slate-500">
                    {l.actor_type}
                  </span>
                  <div>{l.actor_label ?? "—"}</div>
                </td>
                <td className="px-4 py-2 font-mono">{l.action}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      l.result === "SUCCESS"
                        ? "text-emerald-700"
                        : l.result === "FAILED"
                        ? "text-rose-700"
                        : "text-slate-600"
                    }
                  >
                    {l.result}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs">
                  {l.target_type ? `${l.target_type}:${l.target_id}` : "—"}
                </td>
                <td className="px-4 py-2 font-mono text-xs max-w-md truncate">
                  {l.data ? JSON.stringify(l.data) : "—"}
                </td>
              </tr>
            ))}
            {!logs.isLoading && (logs.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  {t("common.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
