import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, setToken } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
export default function Settings() {
    const t = useT();
    const { user, refresh } = useAuth();
    const [oldPw, setOldPw] = useState("");
    const [newPw, setNewPw] = useState("");
    const [msg, setMsg] = useState(null);
    const mut = useMutation({
        mutationFn: () => api("/api/v1/auth/change-password", {
            method: "POST",
            body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
        }),
        onSuccess: async (res) => {
            setToken(res.access_token);
            await refresh();
            setMsg({ ok: true, text: t("auth.changePasswordOk") });
            setOldPw("");
            setNewPw("");
        },
        onError: (e) => {
            setMsg({
                ok: false,
                text: e instanceof ApiError ? String(e.detail) : t("auth.changePasswordError"),
            });
        },
    });
    function onSubmit(e) {
        e.preventDefault();
        setMsg(null);
        mut.mutate();
    }
    return (_jsxs("div", { className: "max-w-xl", children: [_jsx("h1", { className: "text-2xl font-semibold mb-6", children: t("settings.title") }), _jsxs("div", { className: "bg-white rounded shadow p-5 mb-6", children: [_jsx("h2", { className: "font-medium mb-2", children: t("settings.accountInfo") }), _jsxs("div", { className: "text-sm text-slate-700 space-y-1", children: [_jsxs("div", { children: [t("settings.email"), ": ", user?.email] }), _jsxs("div", { children: [t("settings.username"), ": ", user?.username] }), _jsxs("div", { children: [t("settings.role"), ":", " ", user?.is_super_admin ? t("role.super") : t("role.sub")] })] })] }), _jsxs("form", { onSubmit: onSubmit, className: "bg-white rounded shadow p-5 space-y-3", children: [_jsx("h2", { className: "font-medium", children: t("settings.changePasswordHeader") }), _jsx("input", { required: true, type: "password", placeholder: t("auth.oldPassword"), value: oldPw, onChange: (e) => setOldPw(e.target.value), className: "w-full border rounded px-3 py-2" }), _jsx("input", { required: true, type: "password", placeholder: t("auth.newPassword"), minLength: 8, value: newPw, onChange: (e) => setNewPw(e.target.value), className: "w-full border rounded px-3 py-2" }), msg && (_jsx("div", { className: `text-sm ${msg.ok ? "text-emerald-700" : "text-rose-600"}`, children: msg.text })), _jsx("button", { disabled: mut.isPending, className: "bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60", children: mut.isPending
                            ? t("auth.changePasswordBusy")
                            : t("auth.changePassword") })] })] }));
}
