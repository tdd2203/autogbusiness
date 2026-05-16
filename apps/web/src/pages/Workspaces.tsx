import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import type { Workspace, WorkspaceWithKey } from "../types";

export default function Workspaces() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<"business" | "enterprise">("business");
  const [seatTotal, setSeatTotal] = useState<string>("");
  const [createdKey, setCreatedKey] = useState<WorkspaceWithKey | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: workspaces = [], isLoading } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/v1/workspaces"),
  });

  const create = useMutation({
    mutationFn: () =>
      api<WorkspaceWithKey>("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          plan,
          seat_total: seatTotal ? Number(seatTotal) : null,
        }),
      }),
    onSuccess: (ws) => {
      setCreatedKey(ws);
      setShowForm(false);
      setName("");
      setSeatTotal("");
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (e) => {
      setFormError(e instanceof ApiError ? String(e.detail) : "Lỗi tạo workspace");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    create.mutate();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Workspaces</h1>
        {user?.is_super_admin && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="bg-slate-900 text-white px-4 py-2 rounded text-sm"
          >
            + Tạo workspace
          </button>
        )}
      </div>

      {createdKey && (
        <div className="bg-amber-50 border border-amber-300 rounded p-4 mb-6">
          <div className="font-semibold text-amber-900 mb-1">
            Workspace "{createdKey.name}" đã tạo
          </div>
          <p className="text-sm text-amber-800 mb-3">
            Đây là <strong>Extension API Key</strong> — copy ngay, lần sau sẽ không
            hiển thị lại (phải dùng "Regenerate key").
          </p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 bg-white border rounded px-3 py-2 text-xs font-mono break-all">
              {createdKey.extension_api_key}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(createdKey.extension_api_key);
              }}
              className="bg-slate-900 text-white px-3 py-2 rounded text-sm"
            >
              Copy
            </button>
            <button
              onClick={() => setCreatedKey(null)}
              className="text-sm text-slate-600 px-2"
            >
              Đóng
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={onSubmit}
          className="bg-white rounded shadow p-5 mb-6 space-y-3"
        >
          <h2 className="font-medium">Tạo workspace mới</h2>
          <input
            required
            placeholder="Tên workspace (ví dụ: Acme Production)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border rounded px-3 py-2"
          />
          <div className="flex gap-3">
            <select
              value={plan}
              onChange={(e) => setPlan(e.target.value as "business" | "enterprise")}
              className="border rounded px-3 py-2"
            >
              <option value="business">Business</option>
              <option value="enterprise">Enterprise</option>
            </select>
            <input
              type="number"
              min={0}
              placeholder="Số seat (tùy chọn)"
              value={seatTotal}
              onChange={(e) => setSeatTotal(e.target.value)}
              className="flex-1 border rounded px-3 py-2"
            />
          </div>
          {formError && <div className="text-rose-600 text-sm">{formError}</div>}
          <div className="flex gap-2">
            <button
              disabled={create.isPending}
              className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60"
            >
              {create.isPending ? "Đang tạo..." : "Tạo"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setFormError(null);
              }}
              className="px-4 py-2 rounded border"
            >
              Huỷ
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-700">
            <tr>
              <th className="p-3 font-medium">Tên</th>
              <th className="p-3 font-medium">Plan</th>
              <th className="p-3 font-medium">Seat</th>
              <th className="p-3 font-medium">Last synced</th>
              <th className="p-3 font-medium">Created</th>
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
            {!isLoading && workspaces.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  Chưa có workspace nào
                </td>
              </tr>
            )}
            {workspaces.map((ws) => (
              <tr key={ws.id} className="border-t hover:bg-slate-50">
                <td className="p-3">
                  <Link
                    to={`/workspaces/${ws.id}/members`}
                    className="text-slate-900 font-medium hover:underline"
                  >
                    {ws.name}
                  </Link>
                </td>
                <td className="p-3 text-slate-600">{ws.plan ?? "—"}</td>
                <td className="p-3 text-slate-600">
                  {ws.seat_used ?? 0}/{ws.seat_total ?? "—"}
                </td>
                <td className="p-3 text-slate-600">
                  {ws.last_synced_at
                    ? new Date(ws.last_synced_at).toLocaleString("vi-VN")
                    : "Chưa sync"}
                </td>
                <td className="p-3 text-slate-600">
                  {new Date(ws.created_at).toLocaleDateString("vi-VN")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
