import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
export default function WorkspaceExtension() {
    const t = useT();
    const { workspaceId } = useParams();
    const [revealedKey, setRevealedKey] = useState(null);
    const [copied, setCopied] = useState(false);
    const regen = useMutation({
        mutationFn: () => api(`/api/v1/workspaces/${workspaceId}/regenerate-key`, { method: "POST" }),
        onSuccess: (ws) => {
            setRevealedKey(ws.extension_api_key);
            setCopied(false);
        },
    });
    const reveal = useMutation({
        mutationFn: () => api(`/api/v1/workspaces/${workspaceId}/reveal-key`, { method: "POST" }),
        onSuccess: (ws) => {
            setRevealedKey(ws.extension_api_key);
            setCopied(false);
        },
    });
    function onCopy() {
        if (!revealedKey)
            return;
        navigator.clipboard.writeText(revealedKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }
    return (_jsxs("div", { className: "max-w-2xl", children: [_jsx("h2", { className: "text-lg font-medium mb-4", children: t("extension.title") }), _jsxs("div", { className: "bg-white rounded shadow p-5 space-y-4", children: [_jsx("div", { className: "text-sm text-slate-700 space-y-2", children: _jsx("p", { children: t("extension.description") }) }), revealedKey && (_jsxs("div", { className: "bg-amber-50 border border-amber-300 rounded p-4", children: [_jsx("div", { className: "font-semibold text-amber-900 mb-1", children: t("extension.keyBannerTitle") }), _jsx("p", { className: "text-sm text-amber-800 mb-3", children: t("extension.keyBannerWarning") }), _jsxs("div", { className: "flex gap-2 items-center", children: [_jsx("code", { className: "flex-1 bg-white border rounded px-3 py-2 text-xs font-mono break-all", children: revealedKey }), _jsx("button", { onClick: onCopy, className: "bg-slate-900 text-white px-3 py-2 rounded text-sm whitespace-nowrap", children: copied ? t("common.copied") : t("common.copy") })] })] })), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: () => reveal.mutate(), disabled: reveal.isPending, className: "bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-60", children: reveal.isPending
                                    ? t("extension.revealBusy")
                                    : t("extension.revealButton") }), _jsx("button", { onClick: () => {
                                    if (window.confirm(t("extension.regenConfirm"))) {
                                        regen.mutate();
                                    }
                                }, disabled: regen.isPending, className: "bg-rose-600 text-white px-4 py-2 rounded text-sm disabled:opacity-60", children: regen.isPending
                                    ? t("extension.regenBusy")
                                    : t("extension.regenButton") })] }), _jsx("p", { className: "text-xs text-slate-500 mt-2", children: t("extension.helpText") })] })] }));
}
