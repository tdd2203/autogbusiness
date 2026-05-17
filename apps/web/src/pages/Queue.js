import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
export default function Queue() {
    const t = useT();
    const { hasPermission } = useAuth();
    const items = useQuery({
        queryKey: ["queue", "all"],
        queryFn: () => api("/api/v1/queue?limit=200"),
        enabled: hasPermission("QUEUE_VIEW"),
        refetchInterval: 5000,
    });
    return (_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold mb-2", children: t("queue.title") }), _jsxs("p", { className: "text-sm text-slate-600 mb-6", children: [t("queue.subtitle"), " ", _jsx(Link, { to: "/workspaces", className: "underline", children: t("nav.workspaces") }), "."] }), _jsx("div", { className: "bg-white rounded shadow overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-slate-50 text-slate-600", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-2", children: t("queue.colTime") }), _jsx("th", { className: "text-left px-4 py-2", children: t("queue.colWorkspace") }), _jsx("th", { className: "text-left px-4 py-2", children: t("queue.colType") }), _jsx("th", { className: "text-left px-4 py-2", children: t("queue.colStatus") }), _jsx("th", { className: "text-left px-4 py-2", children: t("queue.colPayload") }), _jsx("th", { className: "text-left px-4 py-2", children: t("queue.colResult") })] }) }), _jsxs("tbody", { children: [items.data?.map((it) => (_jsxs("tr", { className: "border-t align-top", children: [_jsx("td", { className: "px-4 py-2 whitespace-nowrap text-slate-600", children: new Date(it.created_at).toLocaleString() }), _jsx("td", { className: "px-4 py-2 text-xs font-mono", children: it.workspace_id ? (_jsxs(Link, { to: `/workspaces/${it.workspace_id}/members`, className: "text-slate-700 hover:underline", children: [it.workspace_id.slice(0, 8), "\u2026"] })) : (_jsx("span", { className: "text-slate-400", children: "\u2014" })) }), _jsx("td", { className: "px-4 py-2 font-mono text-xs", children: it.type }), _jsx("td", { className: "px-4 py-2", children: _jsx(StatusBadge, { status: it.status }) }), _jsx("td", { className: "px-4 py-2 font-mono text-xs max-w-xs break-all", children: JSON.stringify(it.payload) }), _jsx("td", { className: "px-4 py-2 text-xs max-w-xs break-words", children: it.error_code ? (_jsxs("span", { className: "text-rose-600", children: [it.error_code, ": ", it.error_message] })) : it.result ? (_jsx("span", { className: "text-emerald-700 font-mono", children: JSON.stringify(it.result) })) : ("—") })] }, it.id))), !items.isLoading && (items.data?.length ?? 0) === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "px-4 py-6 text-center text-slate-500", children: t("queue.empty") }) }))] })] }) })] }));
}
function StatusBadge({ status }) {
    const cls = status === "COMPLETED"
        ? "bg-emerald-100 text-emerald-700"
        : status === "FAILED"
            ? "bg-rose-100 text-rose-700"
            : status === "IN_PROGRESS"
                ? "bg-amber-100 text-amber-700"
                : "bg-slate-200 text-slate-700";
    return (_jsx("span", { className: `px-2 py-0.5 rounded text-xs font-medium ${cls}`, children: status }));
}
