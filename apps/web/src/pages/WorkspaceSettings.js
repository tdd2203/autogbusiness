import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
export default function WorkspaceSettings() {
    const t = useT();
    const { workspaceId } = useParams();
    const qc = useQueryClient();
    const [invite, setInvite] = useState("5000");
    const [role, setRole] = useState("3000");
    const [remove, setRemove] = useState("5000");
    const [dryRun, setDryRun] = useState(false);
    const [msg, setMsg] = useState(null);
    const { data: settings } = useQuery({
        queryKey: ["workspace-settings", workspaceId],
        queryFn: () => api(`/api/v1/workspaces/${workspaceId}/settings`),
        enabled: !!workspaceId,
    });
    useEffect(() => {
        if (settings) {
            setInvite(String(settings.rate_limit_invite_ms));
            setRole(String(settings.rate_limit_role_ms));
            setRemove(String(settings.rate_limit_remove_ms));
            setDryRun(settings.dry_run_mode);
        }
    }, [settings]);
    const save = useMutation({
        mutationFn: () => api(`/api/v1/workspaces/${workspaceId}/settings`, {
            method: "PATCH",
            body: JSON.stringify({
                rate_limit_invite_ms: Number(invite),
                rate_limit_role_ms: Number(role),
                rate_limit_remove_ms: Number(remove),
                dry_run_mode: dryRun,
            }),
        }),
        onSuccess: () => {
            setMsg({ ok: true, text: t("wsettings.saveOk") });
            qc.invalidateQueries({ queryKey: ["workspace-settings", workspaceId] });
        },
        onError: (e) => setMsg({
            ok: false,
            text: e instanceof ApiError ? String(e.detail) : t("wsettings.saveError"),
        }),
    });
    function onSubmit(e) {
        e.preventDefault();
        setMsg(null);
        save.mutate();
    }
    return (_jsxs("div", { className: "max-w-xl", children: [_jsx("h2", { className: "text-lg font-medium mb-4", children: t("wsettings.title") }), _jsxs("form", { onSubmit: onSubmit, className: "bg-white rounded shadow p-5 space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium mb-1", children: t("wsettings.rateInvite") }), _jsx("input", { type: "number", min: 0, max: 600000, value: invite, onChange: (e) => setInvite(e.target.value), className: "w-full border rounded px-3 py-2" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium mb-1", children: t("wsettings.rateRole") }), _jsx("input", { type: "number", min: 0, max: 600000, value: role, onChange: (e) => setRole(e.target.value), className: "w-full border rounded px-3 py-2" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium mb-1", children: t("wsettings.rateRemove") }), _jsx("input", { type: "number", min: 0, max: 600000, value: remove, onChange: (e) => setRemove(e.target.value), className: "w-full border rounded px-3 py-2" })] }), _jsxs("label", { className: "flex items-center gap-2 text-sm", children: [_jsx("input", { type: "checkbox", checked: dryRun, onChange: (e) => setDryRun(e.target.checked) }), _jsx("span", { children: t("wsettings.dryRun") })] }), msg && (_jsx("div", { className: `text-sm ${msg.ok ? "text-emerald-700" : "text-rose-600"}`, children: msg.text })), _jsx("button", { disabled: save.isPending, className: "bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60", children: save.isPending ? t("common.saving") : t("common.save") })] })] }));
}
