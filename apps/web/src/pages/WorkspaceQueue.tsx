import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { QueueItem } from "../types";

const STATUS_BADGE: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  IN_PROGRESS: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-rose-100 text-rose-800",
};

export default function WorkspaceQueue() {
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
      <h2 className="text-lg font-medium mb-4">Queue tasks của workspace</h2>
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-700">
            <tr>
              <th className="p-3 font-medium">Thời gian</th>
              <th className="p-3 font-medium">Loại</th>
              <th className="p-3 font-medium">Trạng thái</th>
              <th className="p-3 font-medium">Payload</th>
              <th className="p-3 font-medium">Kết quả / Lỗi</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  Đang tải...
                </td>
              </tr>
            )}
            {!isLoading && tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  Workspace chưa có task nào
                </td>
              </tr>
            )}
            {tasks.map((t) => (
              <tr key={t.id} className="border-t align-top">
                <td className="p-3 text-slate-600 whitespace-nowrap">
                  {new Date(t.created_at).toLocaleString("vi-VN")}
                </td>
                <td className="p-3 font-mono text-xs">{t.type}</td>
                <td className="p-3">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_BADGE[t.status] ?? "bg-slate-100"
                    }`}
                  >
                    {t.status}
                  </span>
                </td>
                <td className="p-3 text-xs font-mono text-slate-700 max-w-md break-all">
                  {JSON.stringify(t.payload)}
                </td>
                <td className="p-3 text-xs text-slate-700 max-w-md break-words">
                  {t.error_message ? (
                    <span className="text-rose-700">
                      {t.error_code}: {t.error_message}
                    </span>
                  ) : t.result ? (
                    <span className="font-mono">{JSON.stringify(t.result)}</span>
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
