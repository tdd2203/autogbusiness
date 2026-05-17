import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { useT } from "../i18n";
import {
  SEAT_TOTAL_MAX,
  type QueueItem,
  type Workspace,
  type WorkspaceWithKey,
} from "../types";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";

export default function Workspaces() {
  const t = useT();
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
      setFormError(
        e instanceof ApiError ? String(e.detail) : t("workspace.createError"),
      );
    },
  });

  const [syncBillingId, setSyncBillingId] = useState<string | null>(null);
  const [lastBillingTaskId, setLastBillingTaskId] = useState<string | null>(null);
  const [lastBillingWorkspaceName, setLastBillingWorkspaceName] = useState<
    string | null
  >(null);

  // Poll recent tasks (cross-workspace) để bắt completion của billing sync.
  // limit nhỏ vì user chỉ quan tâm vài task gần nhất.
  const { data: recentTasks = [] } = useQuery({
    queryKey: ["recent-tasks-global"],
    queryFn: () => api<QueueItem[]>("/api/v1/queue?limit=20"),
    refetchInterval: 2000,
    enabled: !!lastBillingTaskId,
  });

  const lastBillingTask = lastBillingTaskId
    ? recentTasks.find((t) => t.id === lastBillingTaskId) ?? null
    : null;
  const showBillingCompletion =
    lastBillingTask?.status === "COMPLETED" ||
    lastBillingTask?.status === "FAILED";

  useEffect(() => {
    if (!showBillingCompletion) return;
    // Refresh seat numbers ngay khi billing sync xong.
    qc.invalidateQueries({ queryKey: ["workspaces"] });
    if (lastBillingTask?.status !== "COMPLETED") return;
    const timer = setTimeout(() => setLastBillingTaskId(null), 10000);
    return () => clearTimeout(timer);
  }, [showBillingCompletion, lastBillingTask?.status, qc]);

  const syncBilling = useMutation({
    mutationFn: (ws: Workspace) =>
      api<{ queue_item_id: string; status: string }>(
        `/api/v1/workspaces/${ws.id}/sync-billing`,
        { method: "POST" },
      ),
    onMutate: (ws) => {
      setSyncBillingId(ws.id);
      setLastBillingWorkspaceName(ws.name);
    },
    onSettled: () => setSyncBillingId(null),
    onSuccess: (resp) => {
      setLastBillingTaskId(resp.queue_item_id);
      triggerExtensionRun();
      qc.invalidateQueries({ queryKey: ["workspaces"] });
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
        <h1 className="text-2xl font-semibold">{t("workspace.listTitle")}</h1>
        {user?.is_super_admin && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="bg-slate-900 text-white px-4 py-2 rounded text-sm"
          >
            {t("workspace.createButton")}
          </button>
        )}
      </div>

      {showBillingCompletion && lastBillingTask && (
        <TaskCompletionBanner
          task={lastBillingTask}
          onDismiss={() => setLastBillingTaskId(null)}
          contextLabel={lastBillingWorkspaceName ?? undefined}
        />
      )}

      {createdKey && (
        <div className="bg-amber-50 border border-amber-300 rounded p-4 mb-6">
          <div className="font-semibold text-amber-900 mb-1">
            {t("workspace.createdBanner", { name: createdKey.name })}
          </div>
          <p className="text-sm text-amber-800 mb-3">
            {t("workspace.apiKeyOnce")}
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
              {t("common.copy")}
            </button>
            <button
              onClick={() => setCreatedKey(null)}
              className="text-sm text-slate-600 px-2"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={onSubmit}
          className="bg-white rounded shadow p-5 mb-6 space-y-3"
        >
          <h2 className="font-medium">{t("workspace.createTitle")}</h2>
          <input
            required
            placeholder={t("workspace.namePlaceholder")}
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
              <option value="business">{t("workspace.planBusiness")}</option>
              <option value="enterprise">{t("workspace.planEnterprise")}</option>
            </select>
            <input
              type="number"
              min={0}
              max={SEAT_TOTAL_MAX}
              placeholder={t("workspace.seatPlaceholder")}
              value={seatTotal}
              onChange={(e) => setSeatTotal(e.target.value)}
              className="flex-1 border rounded px-3 py-2"
            />
          </div>
          <p className="text-xs text-slate-500">
            {t("workspace.seatHint", { max: SEAT_TOTAL_MAX })}
          </p>
          {formError && <div className="text-rose-600 text-sm">{formError}</div>}
          <div className="flex gap-2">
            <button
              disabled={create.isPending}
              className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60"
            >
              {create.isPending ? t("common.creating") : t("common.create")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setFormError(null);
              }}
              className="px-4 py-2 rounded border"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-700">
            <tr>
              <th className="p-3 font-medium">{t("workspace.tableName")}</th>
              <th className="p-3 font-medium">{t("workspace.tablePlan")}</th>
              <th className="p-3 font-medium">{t("workspace.tableSeat")}</th>
              <th className="p-3 font-medium">
                {t("workspace.tableLastSync")}
              </th>
              <th className="p-3 font-medium">{t("workspace.tableCreated")}</th>
              {user?.is_super_admin && (
                <th className="p-3 font-medium">{t("workspace.tableActions")}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-500">
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {!isLoading && workspaces.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-500">
                  {t("workspace.emptyList")}
                </td>
              </tr>
            )}
            {workspaces.map((ws) => {
              const isSyncing = syncBilling.isPending && syncBillingId === ws.id;
              const unpaid = ws.billing_status === "UNPAID";
              const billingNeverSynced = !ws.last_billing_synced_at;
              return (
                <tr key={ws.id} className="border-t hover:bg-slate-50">
                  <td className="p-3">
                    <Link
                      to={`/workspaces/${ws.id}/members`}
                      className="text-slate-900 font-medium hover:underline"
                    >
                      {ws.name}
                    </Link>
                  </td>
                  <td className="p-3 text-slate-600">
                    <div className="flex items-center gap-2">
                      <span>{ws.plan ?? "—"}</span>
                      {unpaid && (
                        <span
                          className="text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-700"
                          title={t("workspace.billingUnpaid")}
                        >
                          {t("workspace.billingUnpaid")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-slate-600">
                    <span
                      title={
                        billingNeverSynced
                          ? t("workspace.billingNeverSynced")
                          : `${t("workspace.tableLastSync")}: ${new Date(
                              ws.last_billing_synced_at!,
                            ).toLocaleString()}`
                      }
                    >
                      {ws.seat_used ?? 0}/{ws.seat_total ?? "—"}
                    </span>
                  </td>
                  <td className="p-3 text-slate-600">
                    {ws.last_synced_at
                      ? new Date(ws.last_synced_at).toLocaleString()
                      : t("workspace.lastSyncNever")}
                  </td>
                  <td className="p-3 text-slate-600">
                    {new Date(ws.created_at).toLocaleDateString()}
                  </td>
                  {user?.is_super_admin && (
                    <td className="p-3 text-slate-600">
                      <button
                        onClick={() => syncBilling.mutate(ws)}
                        disabled={isSyncing}
                        title={t("workspace.syncBillingTooltip")}
                        className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-60"
                      >
                        {isSyncing
                          ? t("workspace.syncBillingBusy")
                          : t("workspace.syncBilling")}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
