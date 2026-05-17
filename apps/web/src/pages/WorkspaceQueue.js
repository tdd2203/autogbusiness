import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
const STATUS_BADGE = {
    PENDING: "bg-amber-100 text-amber-800",
    IN_PROGRESS: "bg-blue-100 text-blue-800",
    COMPLETED: "bg-emerald-100 text-emerald-800",
    FAILED: "bg-rose-100 text-rose-800",
};
export default function WorkspaceQueue() {
    const t = useT();
    const { workspaceId } = useParams();
    const { data: tasks = [], isLoading } = useQuery({
        queryKey: ["queue", workspaceId],
        queryFn: () => api(`/api/v1/queue?workspace_id=${workspaceId}&limit=200`),
        enabled: !!workspaceId,
        refetchInterval: 5000,
    });
    return (_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-medium mb-4", children: t("queue.subtitleWs") }), _jsx("div", { className: "bg-white rounded shadow overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-slate-50 text-left text-slate-700", children: _jsxs("tr", { children: [_jsx("th", { className: "p-3 font-medium", children: t("queue.colTime") }), _jsx("th", { className: "p-3 font-medium", children: t("queue.colType") }), _jsx("th", { className: "p-3 font-medium", children: t("queue.colStatus") }), _jsx("th", { className: "p-3 font-medium", children: t("queue.colPayload") }), _jsx("th", { className: "p-3 font-medium", children: t("queue.colResult") })] }) }), _jsxs("tbody", { children: [isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-6 text-center text-slate-500", children: t("common.loading") }) })), !isLoading && tasks.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-6 text-center text-slate-500", children: t("queue.emptyWs") }) })), tasks.map((task) => (_jsxs("tr", { className: "border-t align-top", children: [_jsx("td", { className: "p-3 text-slate-600 whitespace-nowrap", children: new Date(task.created_at).toLocaleString() }), _jsx("td", { className: "p-3 font-mono text-xs", children: task.type }), _jsx("td", { className: "p-3", children: _jsx("span", { className: `px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[task.status] ?? "bg-slate-100"}`, children: task.status }) }), _jsx("td", { className: "p-3 text-xs font-mono text-slate-700 max-w-md break-all", children: JSON.stringify(task.payload) }), _jsx("td", { className: "p-3 text-xs text-slate-700 max-w-md break-words", children: task.error_message ? (_jsxs("span", { className: "text-rose-700", children: [task.error_code, ": ", task.error_message] })) : task.status === "IN_PROGRESS" && task.progress ? (_jsxs("span", { className: "text-blue-700", children: [task.progress.message ??
                                                        t(`progress.${task.progress.phase ?? "IN_PROGRESS"}`), typeof task.progress.current === "number" && (_jsxs(_Fragment, { children: [" ", "(", String(task.progress.current), typeof task.progress.total === "number"
                                                                ? `/${task.progress.total}`
                                                                : "", ")"] }))] })) : task.result ? (_jsx("span", { className: "font-mono", children: JSON.stringify(task.result) })) : (_jsx("span", { className: "text-slate-400", children: "\u2014" })) })] }, task.id)))] })] }) })] }));
}
