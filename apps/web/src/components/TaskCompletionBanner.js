import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useT } from "../i18n";
function renderDetail(task, t) {
    if (task.status === "FAILED") {
        return task.error_message ?? task.error_code ?? t("sync.failedUnknown");
    }
    switch (task.type) {
        case "SYNC_DATA": {
            const r = (task.result ?? {});
            return t("sync.completedMembers", {
                total: r.total ?? 0,
                created: r.created ?? 0,
                updated: r.updated ?? 0,
            });
        }
        case "SYNC_BILLING": {
            const r = (task.result ?? {});
            return t("sync.completedBilling", {
                used: r.seat_used ?? "?",
                total: r.seat_total ?? "?",
                plan: r.plan ?? "?",
                status: r.billing_status ?? "?",
            });
        }
        case "INVITE_MEMBER": {
            const email = task.payload?.email ?? "";
            const role = task.payload?.role ?? "";
            return t("sync.completedInvite", { email, role });
        }
        case "REMOVE_MEMBER": {
            const email = task.payload?.email ?? "";
            return t("sync.completedRemove", { email });
        }
        case "CHANGE_ROLE": {
            const email = task.payload?.email ?? "";
            const role = task.payload?.new_role ?? "";
            return t("sync.completedChangeRole", { email, role });
        }
        default:
            return task.type;
    }
}
export function TaskCompletionBanner({ task, onDismiss, contextLabel, }) {
    const t = useT();
    const isError = task.status === "FAILED";
    const detail = renderDetail(task, t);
    const title = isError ? t("sync.failedTitle") : t("sync.completedTitle");
    const typeLabel = t(`sync.type.${task.type}`);
    return (_jsxs("div", { role: "status", className: `rounded p-3 mb-4 text-sm flex items-start gap-3 ${isError
            ? "bg-rose-50 border border-rose-300 text-rose-900"
            : "bg-emerald-50 border border-emerald-300 text-emerald-900"}`, children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "font-medium", children: [title, " \u00B7 ", _jsx("span", { className: "font-normal opacity-80", children: typeLabel }), contextLabel && (_jsxs("span", { className: "font-normal opacity-80", children: [" \u00B7 ", contextLabel] }))] }), _jsx("div", { className: "mt-1 break-words", children: detail }), task.completed_at && (_jsx("div", { className: "text-xs opacity-70 mt-1", children: new Date(task.completed_at).toLocaleTimeString() }))] }), _jsx("button", { type: "button", onClick: onDismiss, className: "text-current opacity-50 hover:opacity-100 px-2", "aria-label": t("common.close"), children: "\u2715" })] }));
}
