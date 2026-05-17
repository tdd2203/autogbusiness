import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { useT } from "../i18n";
import { SEAT_TOTAL_MAX, } from "../types";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";
export default function Workspaces() {
    const t = useT();
    const { user } = useAuth();
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [name, setName] = useState("");
    const [plan, setPlan] = useState("business");
    const [seatTotal, setSeatTotal] = useState("");
    const [createdKey, setCreatedKey] = useState(null);
    const [formError, setFormError] = useState(null);
    const { data: workspaces = [], isLoading } = useQuery({
        queryKey: ["workspaces"],
        queryFn: () => api("/api/v1/workspaces"),
    });
    const create = useMutation({
        mutationFn: () => api("/api/v1/workspaces", {
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
            setFormError(e instanceof ApiError ? String(e.detail) : t("workspace.createError"));
        },
    });
    const [syncBillingId, setSyncBillingId] = useState(null);
    const [lastBillingTaskId, setLastBillingTaskId] = useState(null);
    const [lastBillingWorkspaceName, setLastBillingWorkspaceName] = useState(null);
    // Poll recent tasks (cross-workspace) để bắt completion của billing sync.
    // limit nhỏ vì user chỉ quan tâm vài task gần nhất.
    const { data: recentTasks = [] } = useQuery({
        queryKey: ["recent-tasks-global"],
        queryFn: () => api("/api/v1/queue?limit=20"),
        refetchInterval: 2000,
        enabled: !!lastBillingTaskId,
    });
    const lastBillingTask = lastBillingTaskId
        ? recentTasks.find((t) => t.id === lastBillingTaskId) ?? null
        : null;
    const showBillingCompletion = lastBillingTask?.status === "COMPLETED" ||
        lastBillingTask?.status === "FAILED";
    useEffect(() => {
        if (!showBillingCompletion)
            return;
        // Refresh seat numbers ngay khi billing sync xong.
        qc.invalidateQueries({ queryKey: ["workspaces"] });
        if (lastBillingTask?.status !== "COMPLETED")
            return;
        const timer = setTimeout(() => setLastBillingTaskId(null), 10000);
        return () => clearTimeout(timer);
    }, [showBillingCompletion, lastBillingTask?.status, qc]);
    const syncBilling = useMutation({
        mutationFn: (ws) => api(`/api/v1/workspaces/${ws.id}/sync-billing`, { method: "POST" }),
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
    function onSubmit(e) {
        e.preventDefault();
        setFormError(null);
        create.mutate();
    }
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsx("h1", { className: "text-2xl font-semibold", children: t("workspace.listTitle") }), user?.is_super_admin && !showForm && (_jsx("button", { onClick: () => setShowForm(true), className: "bg-slate-900 text-white px-4 py-2 rounded text-sm", children: t("workspace.createButton") }))] }), showBillingCompletion && lastBillingTask && (_jsx(TaskCompletionBanner, { task: lastBillingTask, onDismiss: () => setLastBillingTaskId(null), contextLabel: lastBillingWorkspaceName ?? undefined })), createdKey && (_jsxs("div", { className: "bg-amber-50 border border-amber-300 rounded p-4 mb-6", children: [_jsx("div", { className: "font-semibold text-amber-900 mb-1", children: t("workspace.createdBanner", { name: createdKey.name }) }), _jsx("p", { className: "text-sm text-amber-800 mb-3", children: t("workspace.apiKeyOnce") }), _jsxs("div", { className: "flex gap-2 items-center", children: [_jsx("code", { className: "flex-1 bg-white border rounded px-3 py-2 text-xs font-mono break-all", children: createdKey.extension_api_key }), _jsx("button", { onClick: () => {
                                    navigator.clipboard.writeText(createdKey.extension_api_key);
                                }, className: "bg-slate-900 text-white px-3 py-2 rounded text-sm", children: t("common.copy") }), _jsx("button", { onClick: () => setCreatedKey(null), className: "text-sm text-slate-600 px-2", children: t("common.close") })] })] })), showForm && (_jsxs("form", { onSubmit: onSubmit, className: "bg-white rounded shadow p-5 mb-6 space-y-3", children: [_jsx("h2", { className: "font-medium", children: t("workspace.createTitle") }), _jsx("input", { required: true, placeholder: t("workspace.namePlaceholder"), value: name, onChange: (e) => setName(e.target.value), className: "w-full border rounded px-3 py-2" }), _jsxs("div", { className: "flex gap-3", children: [_jsxs("select", { value: plan, onChange: (e) => setPlan(e.target.value), className: "border rounded px-3 py-2", children: [_jsx("option", { value: "business", children: t("workspace.planBusiness") }), _jsx("option", { value: "enterprise", children: t("workspace.planEnterprise") })] }), _jsx("input", { type: "number", min: 0, max: SEAT_TOTAL_MAX, placeholder: t("workspace.seatPlaceholder"), value: seatTotal, onChange: (e) => setSeatTotal(e.target.value), className: "flex-1 border rounded px-3 py-2" })] }), _jsx("p", { className: "text-xs text-slate-500", children: t("workspace.seatHint", { max: SEAT_TOTAL_MAX }) }), formError && _jsx("div", { className: "text-rose-600 text-sm", children: formError }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { disabled: create.isPending, className: "bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60", children: create.isPending ? t("common.creating") : t("common.create") }), _jsx("button", { type: "button", onClick: () => {
                                    setShowForm(false);
                                    setFormError(null);
                                }, className: "px-4 py-2 rounded border", children: t("common.cancel") })] })] })), _jsx("div", { className: "bg-white rounded shadow overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-slate-50 text-left text-slate-700", children: _jsxs("tr", { children: [_jsx("th", { className: "p-3 font-medium", children: t("workspace.tableName") }), _jsx("th", { className: "p-3 font-medium", children: t("workspace.tablePlan") }), _jsx("th", { className: "p-3 font-medium", children: t("workspace.tableSeat") }), _jsx("th", { className: "p-3 font-medium", children: t("workspace.tableLastSync") }), _jsx("th", { className: "p-3 font-medium", children: t("workspace.tableCreated") }), user?.is_super_admin && (_jsx("th", { className: "p-3 font-medium", children: t("workspace.tableActions") }))] }) }), _jsxs("tbody", { children: [isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-6 text-center text-slate-500", children: t("common.loading") }) })), !isLoading && workspaces.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-6 text-center text-slate-500", children: t("workspace.emptyList") }) })), workspaces.map((ws) => {
                                    const isSyncing = syncBilling.isPending && syncBillingId === ws.id;
                                    const unpaid = ws.billing_status === "UNPAID";
                                    const billingNeverSynced = !ws.last_billing_synced_at;
                                    return (_jsxs("tr", { className: "border-t hover:bg-slate-50", children: [_jsx("td", { className: "p-3", children: _jsx(Link, { to: `/workspaces/${ws.id}/members`, className: "text-slate-900 font-medium hover:underline", children: ws.name }) }), _jsx("td", { className: "p-3 text-slate-600", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { children: ws.plan ?? "—" }), unpaid && (_jsx("span", { className: "text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-700", title: t("workspace.billingUnpaid"), children: t("workspace.billingUnpaid") }))] }) }), _jsx("td", { className: "p-3 text-slate-600", children: _jsxs("span", { title: billingNeverSynced
                                                        ? t("workspace.billingNeverSynced")
                                                        : `${t("workspace.tableLastSync")}: ${new Date(ws.last_billing_synced_at).toLocaleString()}`, children: [ws.seat_used ?? 0, "/", ws.seat_total ?? "—"] }) }), _jsx("td", { className: "p-3 text-slate-600", children: ws.last_synced_at
                                                    ? new Date(ws.last_synced_at).toLocaleString()
                                                    : t("workspace.lastSyncNever") }), _jsx("td", { className: "p-3 text-slate-600", children: new Date(ws.created_at).toLocaleDateString() }), user?.is_super_admin && (_jsx("td", { className: "p-3 text-slate-600", children: _jsx("button", { onClick: () => syncBilling.mutate(ws), disabled: isSyncing, title: t("workspace.syncBillingTooltip"), className: "text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-60", children: isSyncing
                                                        ? t("workspace.syncBillingBusy")
                                                        : t("workspace.syncBilling") }) }))] }, ws.id));
                                })] })] }) })] }));
}
