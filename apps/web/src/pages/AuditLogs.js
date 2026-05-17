import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
export default function AuditLogs() {
    const t = useT();
    const logs = useQuery({
        queryKey: ["audit-logs"],
        queryFn: () => api("/api/v1/audit-logs?limit=200"),
    });
    return (_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold mb-6", children: t("audit.title") }), _jsx("div", { className: "bg-white rounded shadow overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-slate-50 text-slate-600", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-2", children: t("queue.colTime") }), _jsx("th", { className: "text-left px-4 py-2", children: "Actor" }), _jsx("th", { className: "text-left px-4 py-2", children: "Action" }), _jsx("th", { className: "text-left px-4 py-2", children: t("queue.colResult") }), _jsx("th", { className: "text-left px-4 py-2", children: "Target" }), _jsx("th", { className: "text-left px-4 py-2", children: "Data" })] }) }), _jsxs("tbody", { children: [logs.data?.map((l) => (_jsxs("tr", { className: "border-t", children: [_jsx("td", { className: "px-4 py-2 whitespace-nowrap", children: new Date(l.timestamp).toLocaleString() }), _jsxs("td", { className: "px-4 py-2", children: [_jsx("span", { className: "font-mono text-xs text-slate-500", children: l.actor_type }), _jsx("div", { children: l.actor_label ?? "—" })] }), _jsx("td", { className: "px-4 py-2 font-mono", children: l.action }), _jsx("td", { className: "px-4 py-2", children: _jsx("span", { className: l.result === "SUCCESS"
                                                    ? "text-emerald-700"
                                                    : l.result === "FAILED"
                                                        ? "text-rose-700"
                                                        : "text-slate-600", children: l.result }) }), _jsx("td", { className: "px-4 py-2 text-xs", children: l.target_type ? `${l.target_type}:${l.target_id}` : "—" }), _jsx("td", { className: "px-4 py-2 font-mono text-xs max-w-md truncate", children: l.data ? JSON.stringify(l.data) : "—" })] }, l.id))), !logs.isLoading && (logs.data?.length ?? 0) === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "px-4 py-6 text-center text-slate-500", children: t("common.empty") }) }))] })] }) })] }));
}
