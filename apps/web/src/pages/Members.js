import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
import { triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";
const ROLE_BADGE = {
    owner: "bg-purple-100 text-purple-800",
    admin: "bg-blue-100 text-blue-800",
    member: "bg-slate-100 text-slate-700",
};
const STATUS_BADGE = {
    active: "bg-emerald-100 text-emerald-800",
    pending: "bg-amber-100 text-amber-800",
    removed: "bg-rose-100 text-rose-800",
};
export default function Members() {
    const t = useT();
    const { workspaceId } = useParams();
    const { hasPermission, user } = useAuth();
    const qc = useQueryClient();
    const [showInvite, setShowInvite] = useState(false);
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteRole, setInviteRole] = useState("member");
    const [inviteError, setInviteError] = useState(null);
    const { data: members = [], isLoading } = useQuery({
        queryKey: ["members", workspaceId],
        queryFn: () => api(`/api/v1/workspaces/${workspaceId}/members`),
        enabled: !!workspaceId,
    });
    // Poll recent tasks — bao gồm cả COMPLETED/FAILED để show kết quả sync xong.
    // Lọc active vs completed ở client.
    const { data: recentTasks = [] } = useQuery({
        queryKey: ["recent-tasks", workspaceId],
        queryFn: () => api(`/api/v1/queue?workspace_id=${workspaceId}&limit=50`),
        enabled: !!workspaceId,
        refetchInterval: 2000,
    });
    const activeTasks = recentTasks.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS");
    const activeSyncTask = activeTasks.find((t) => t.type === "SYNC_DATA");
    const activeInviteCount = activeTasks.filter((t) => t.type === "INVITE_MEMBER").length;
    // Track task ID của lần sync gần nhất → tìm trong recentTasks để show
    // completion banner với result data.
    const [lastSyncTaskId, setLastSyncTaskId] = useState(null);
    const lastSyncTask = lastSyncTaskId
        ? recentTasks.find((t) => t.id === lastSyncTaskId) ?? null
        : null;
    const showSyncCompletion = lastSyncTask?.status === "COMPLETED" || lastSyncTask?.status === "FAILED";
    // Auto-dismiss SUCCESS banner sau 10s. FAILED giữ tới khi user dismiss.
    useEffect(() => {
        if (!showSyncCompletion || lastSyncTask?.status !== "COMPLETED")
            return;
        const timer = setTimeout(() => setLastSyncTaskId(null), 10000);
        return () => clearTimeout(timer);
    }, [showSyncCompletion, lastSyncTask?.status]);
    // Auto-refresh member list khi sync task vừa transition active → done
    const prevSyncIdRef = useRef(null);
    useEffect(() => {
        const currentSyncId = activeSyncTask?.id ?? null;
        if (prevSyncIdRef.current && !currentSyncId) {
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
        }
        prevSyncIdRef.current = currentSyncId;
    }, [activeSyncTask?.id, qc, workspaceId]);
    const sync = useMutation({
        mutationFn: () => api(`/api/v1/workspaces/${workspaceId}/sync`, { method: "POST" }),
        onSuccess: (resp) => {
            setLastSyncTaskId(resp.queue_item_id);
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            triggerExtensionRun();
        },
    });
    const invite = useMutation({
        mutationFn: () => api(`/api/v1/workspaces/${workspaceId}/members/invite`, {
            method: "POST",
            body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
        }),
        onSuccess: () => {
            setShowInvite(false);
            setInviteEmail("");
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            triggerExtensionRun();
        },
        onError: (e) => {
            setInviteError(e instanceof ApiError ? String(e.detail) : t("member.inviteError"));
        },
    });
    const remove = useMutation({
        mutationFn: (memberId) => api(`/api/v1/workspaces/${workspaceId}/members/${memberId}`, {
            method: "DELETE",
        }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            triggerExtensionRun();
        },
    });
    const changeRole = useMutation({
        mutationFn: ({ memberId, role }) => api(`/api/v1/workspaces/${workspaceId}/members/${memberId}/role`, {
            method: "PATCH",
            body: JSON.stringify({ new_role: role }),
        }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            triggerExtensionRun();
        },
    });
    function onInviteSubmit(e) {
        e.preventDefault();
        setInviteError(null);
        invite.mutate();
    }
    const canInvite = hasPermission("MEMBER_INVITE");
    const canRemove = hasPermission("MEMBER_REMOVE");
    const canChangeRole = user?.is_super_admin === true;
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsx("h2", { className: "text-lg font-medium", children: t("member.listTitle") }), _jsxs("div", { className: "flex gap-2", children: [hasPermission("WORKSPACE_SYNC_TRIGGER") && (_jsx("button", { onClick: () => sync.mutate(), disabled: sync.isPending || !!activeSyncTask, className: "bg-white border px-4 py-2 rounded text-sm disabled:opacity-60", title: t("member.syncTooltip"), children: activeSyncTask
                                    ? t("member.syncRunning")
                                    : sync.isPending
                                        ? t("member.syncBusy")
                                        : t("member.syncButton") })), canInvite && !showInvite && (_jsx("button", { onClick: () => setShowInvite(true), className: "bg-slate-900 text-white px-4 py-2 rounded text-sm", children: t("member.inviteButton") }))] })] }), activeSyncTask && _jsx(SyncProgressBanner, { task: activeSyncTask }), !activeSyncTask && showSyncCompletion && lastSyncTask && (_jsx(TaskCompletionBanner, { task: lastSyncTask, onDismiss: () => setLastSyncTaskId(null) })), !activeSyncTask && !lastSyncTask && sync.isSuccess && (_jsx("div", { className: "bg-blue-50 border border-blue-300 rounded p-3 mb-4 text-sm text-blue-900", children: t("member.syncQueued") })), activeInviteCount > 0 && (_jsx("div", { className: "bg-amber-50 border border-amber-300 rounded p-3 mb-4 text-sm text-amber-900", children: t("member.invitesInFlight", { n: activeInviteCount }) })), showInvite && (_jsxs("form", { onSubmit: onInviteSubmit, className: "bg-white rounded shadow p-5 mb-6 space-y-3", children: [_jsx("h2", { className: "font-medium", children: t("member.inviteTitle") }), _jsxs("div", { className: "flex gap-3", children: [_jsx("input", { required: true, type: "email", placeholder: t("member.inviteEmailPlaceholder"), value: inviteEmail, onChange: (e) => setInviteEmail(e.target.value), className: "flex-1 border rounded px-3 py-2" }), _jsxs("select", { value: inviteRole, onChange: (e) => setInviteRole(e.target.value), className: "border rounded px-3 py-2", children: [_jsx("option", { value: "member", children: t("member.roleMember") }), _jsx("option", { value: "admin", children: t("member.roleAdmin") })] })] }), inviteError && (_jsx("div", { className: "text-rose-600 text-sm", children: inviteError })), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { disabled: invite.isPending, className: "bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60", children: invite.isPending
                                    ? t("member.inviteBusy")
                                    : t("member.inviteSubmit") }), _jsx("button", { type: "button", onClick: () => {
                                    setShowInvite(false);
                                    setInviteError(null);
                                }, className: "px-4 py-2 rounded border", children: t("common.cancel") })] })] })), _jsx("div", { className: "bg-white rounded shadow overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-slate-50 text-left text-slate-700", children: _jsxs("tr", { children: [_jsx("th", { className: "p-3 font-medium", children: t("member.colEmail") }), _jsx("th", { className: "p-3 font-medium", children: t("member.colName") }), _jsx("th", { className: "p-3 font-medium", children: t("member.colRole") }), _jsx("th", { className: "p-3 font-medium", children: t("member.colStatus") }), _jsx("th", { className: "p-3 font-medium text-right", children: t("common.actions") })] }) }), _jsxs("tbody", { children: [isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-6 text-center text-slate-500", children: t("common.loading") }) })), !isLoading && members.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-6 text-center text-slate-500", children: user?.is_super_admin
                                            ? t("member.emptySuper")
                                            : t("member.emptySub") }) })), members.map((m) => (_jsxs("tr", { className: "border-t", children: [_jsx("td", { className: "p-3 font-medium", children: m.email }), _jsx("td", { className: "p-3 text-slate-700", children: m.name ?? "—" }), _jsx("td", { className: "p-3", children: m.chatgpt_role ? (_jsx("span", { className: `px-2 py-0.5 rounded text-xs font-medium ${ROLE_BADGE[m.chatgpt_role] ?? "bg-slate-100"}`, children: t(`member.role${m.chatgpt_role.charAt(0).toUpperCase()}${m.chatgpt_role.slice(1)}`) })) : (_jsx("span", { className: "text-slate-400", children: "\u2014" })) }), _jsx("td", { className: "p-3", children: _jsx("span", { className: `px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[m.status] ?? "bg-slate-100"}`, children: t(`member.status${m.status.charAt(0).toUpperCase()}${m.status.slice(1)}`) }) }), _jsxs("td", { className: "p-3 text-right space-x-2", children: [canChangeRole && m.chatgpt_role && m.status === "active" && (_jsxs("select", { value: m.chatgpt_role, onChange: (e) => changeRole.mutate({
                                                        memberId: m.id,
                                                        role: e.target.value,
                                                    }), className: "border rounded px-2 py-1 text-xs", children: [_jsx("option", { value: "member", children: t("member.roleMember") }), _jsx("option", { value: "admin", children: t("member.roleAdmin") }), _jsx("option", { value: "owner", children: t("member.roleOwner") })] })), canRemove && m.status !== "removed" && (_jsx("button", { onClick: () => {
                                                        if (window.confirm(t("member.confirmRemove", { email: m.email }))) {
                                                            remove.mutate(m.id);
                                                        }
                                                    }, className: "text-rose-600 hover:text-rose-700 text-xs", children: t("member.removeAction") }))] })] }, m.id)))] })] }) })] }));
}
function SyncProgressBanner({ task }) {
    const t = useT();
    const p = task.progress ?? {};
    const phase = p.phase ?? task.status;
    const current = p.current;
    const message = p.message ?? t(`progress.${phase}`);
    const showCount = typeof current === "number";
    return (_jsxs("div", { className: "bg-blue-50 border border-blue-300 rounded p-4 mb-4", children: [_jsxs("div", { className: "flex items-center gap-3 mb-2", children: [_jsx("div", { className: "w-3 h-3 rounded-full bg-blue-500 animate-pulse" }), _jsx("div", { className: "font-medium text-blue-900", children: t("member.syncRunning") }), showCount && (_jsx("div", { className: "text-sm text-blue-700 ml-auto", children: t("progress.collected", { n: current ?? 0 }) }))] }), _jsx("div", { className: "text-sm text-blue-800", children: message })] }));
}
