import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { useAuth } from "../hooks/useAuth";
import { triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { useFormatDate, useT } from "../i18n";
import {
  SEAT_TOTAL_MAX,
  type QueueItem,
  type Workspace,
  type WorkspaceWithKey,
} from "../types";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";
import { AssignWorkspaceModal } from "../components/AssignWorkspaceModal";
import { SearchInput } from "./Members";

export default function Workspaces() {
  const t = useT();
  const formatDate = useFormatDate();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<"business" | "enterprise">("business");
  const [seatTotal, setSeatTotal] = useState<string>("");
  const [verifiedDomain, setVerifiedDomain] = useState<string>("");
  const [createdKey, setCreatedKey] = useState<WorkspaceWithKey | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assignWs, setAssignWs] = useState<Workspace | null>(null);

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
          verified_domain: verifiedDomain.trim() || null,
        }),
      }),
    onSuccess: (ws) => {
      setCreatedKey(ws);
      setShowForm(false);
      setName("");
      setSeatTotal("");
      setVerifiedDomain("");
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

  const { data: recentTasks = [] } = useQuery({
    queryKey: ["recent-tasks-global"],
    queryFn: () => api<QueueItem[]>("/api/v1/queue?limit=20"),
    // Chỉ bật khi có billing task in-flight; poll 2s lúc chạy, dừng khi xong.
    refetchInterval: queuePollInterval(2000),
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

  const filtered = useMemo(() => {
    if (!search.trim()) return workspaces;
    const s = search.trim().toLowerCase();
    return workspaces.filter((w) => w.name.toLowerCase().includes(s));
  }, [workspaces, search]);

  return (
    <div className="page-fade">
      <div
        className="flex items-start justify-between"
        style={{ gap: 24, marginBottom: 32, flexWrap: "wrap" }}
      >
        <div>
          <h1 className="display-h1">{t("workspace.listTitle")}</h1>
          <p className="page-sub">{t("workspace.pageSub")}</p>
        </div>
        {user?.is_super_admin && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="btn btn-primary"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={14} height={14}>
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t("workspace.createButton")}
          </button>
        )}
      </div>

      {showBillingCompletion && lastBillingTask && (
        <div style={{ marginBottom: 16 }}>
          <TaskCompletionBanner
            task={lastBillingTask}
            onDismiss={() => setLastBillingTaskId(null)}
            contextLabel={lastBillingWorkspaceName ?? undefined}
          />
        </div>
      )}

      {createdKey && (
        <div className="notice warn" style={{ marginBottom: 20, alignItems: "flex-start" }}>
          <div className="notice-icon">!</div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("workspace.createdBanner", { name: createdKey.name })}
            </div>
            <div className="notice-body" style={{ marginBottom: 8 }}>
              {t("workspace.apiKeyOnce")}
            </div>
            <div className="flex items-center gap-2">
              <code
                style={{
                  flex: 1,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "8px 10px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {createdKey.extension_api_key}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(createdKey.extension_api_key);
                }}
                className="btn btn-primary btn-sm"
              >
                {t("common.copy")}
              </button>
              <button
                onClick={() => setCreatedKey(null)}
                className="btn btn-ghost btn-sm"
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={onSubmit}
          className="surface-card"
          style={{ padding: 20, marginBottom: 20 }}
        >
          <div className="display-h3" style={{ marginBottom: 12 }}>
            {t("workspace.createTitle")}
          </div>
          <input
            required
            placeholder={t("workspace.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="form-input"
            style={{ marginBottom: 12 }}
          />
          <div className="flex gap-3" style={{ marginBottom: 8, flexWrap: "wrap" }}>
            <select
              value={plan}
              onChange={(e) => setPlan(e.target.value as "business" | "enterprise")}
              className="form-input"
              style={{ flex: 1, minWidth: 150 }}
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
              className="form-input"
              style={{ flex: 1 }}
            />
          </div>
          <div className="form-hint" style={{ marginBottom: 12 }}>
            {t("workspace.seatHint", { max: SEAT_TOTAL_MAX })}
          </div>
          <input
            placeholder="Tên miền đã xác minh (vd: ndaigroup.org) — để trống nếu chưa có"
            value={verifiedDomain}
            onChange={(e) => setVerifiedDomain(e.target.value)}
            className="form-input"
            style={{ marginBottom: 6 }}
          />
          <div className="form-hint" style={{ marginBottom: 12 }}>
            Khi mời thành viên: nếu mọi email đều thuộc tên miền này thì không cần
            bật "cho phép mời ngoài tên miền". Có thể cập nhật sau.
          </div>
          {formError && (
            <div style={{ color: "var(--danger)", fontSize: 12.5, marginBottom: 10 }}>
              {formError}
            </div>
          )}
          <div className="flex gap-2">
            <button disabled={create.isPending} className="btn btn-primary">
              {create.isPending ? t("common.creating") : t("common.create")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setFormError(null);
              }}
              className="btn btn-ghost"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}

      <div className="table-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("workspace.listTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("members.countLabel", { n: workspaces.length })}
            </div>
          </div>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("members.searchPlaceholder")}
          />
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("workspace.tableName")}</th>
                <th>{t("workspace.tablePlan")}</th>
                <th>{t("workspace.tableSeat")}</th>
                <th>{t("workspace.tableLastSync")}</th>
                <th>{t("workspace.tableCreated")}</th>
                {user?.is_super_admin && (
                  <th style={{ textAlign: "right" }}>
                    {t("workspace.tableActions")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("workspace.emptyList")}
                  </td>
                </tr>
              )}
              {filtered.map((ws) => {
                const isSyncing = syncBilling.isPending && syncBillingId === ws.id;
                const unpaid = ws.billing_status === "UNPAID";
                const billingNeverSynced = !ws.last_billing_synced_at;
                return (
                  <tr key={ws.id}>
                    <td>
                      <Link
                        to={`/workspaces/${ws.id}/members`}
                        style={{
                          color: "var(--ink)",
                          fontWeight: 500,
                          textDecoration: "none",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.textDecoration = "underline")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.textDecoration = "none")
                        }
                      >
                        {ws.name}
                      </Link>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="role-tag">{ws.plan ?? "—"}</span>
                        {unpaid && (
                          <span
                            className="badge badge-danger"
                            title={t("workspace.billingUnpaid")}
                          >
                            {t("workspace.billingUnpaid")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td
                      className="cell-muted mono"
                      style={{ fontSize: 12.5 }}
                      title={
                        billingNeverSynced
                          ? t("workspace.billingNeverSynced")
                          : `${t("workspace.tableLastSync")}: ${new Date(
                              ws.last_billing_synced_at!,
                            ).toLocaleString()}`
                      }
                    >
                      {ws.seat_used ?? 0}/{ws.seat_total ?? "—"}
                    </td>
                    <td className="cell-muted" style={{ fontSize: 12.5 }}>
                      {ws.last_synced_at
                        ? new Date(ws.last_synced_at).toLocaleString()
                        : t("workspace.lastSyncNever")}
                    </td>
                    <td className="cell-muted" style={{ fontSize: 12.5 }}>
                      {formatDate(ws.created_at)}
                    </td>
                    {user?.is_super_admin && (
                      <td style={{ textAlign: "right" }}>
                        <div
                          className="flex items-center justify-end"
                          style={{ gap: 6 }}
                        >
                          <button
                            onClick={() => setAssignWs(ws)}
                            title={t("assign.tooltip")}
                            className="btn btn-ghost btn-sm"
                          >
                            {t("assign.action")}
                          </button>
                          <button
                            onClick={() => syncBilling.mutate(ws)}
                            disabled={isSyncing}
                            title={t("workspace.syncBillingTooltip")}
                            className="btn btn-ghost btn-sm"
                          >
                            {isSyncing
                              ? t("workspace.syncBillingBusy")
                              : t("workspace.syncBilling")}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {assignWs && (
        <AssignWorkspaceModal
          workspace={assignWs}
          onClose={() => setAssignWs(null)}
        />
      )}
    </div>
  );
}
