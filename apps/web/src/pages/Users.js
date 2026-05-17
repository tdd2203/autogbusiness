import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { GRANTABLE } from "../lib/permissions";
import { useT } from "../i18n";
export default function Users() {
    const t = useT();
    const qc = useQueryClient();
    const users = useQuery({
        queryKey: ["users"],
        queryFn: () => api("/api/v1/users"),
    });
    const [showForm, setShowForm] = useState(false);
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsx("h1", { className: "text-2xl font-semibold", children: t("users.title") }), _jsx("button", { onClick: () => setShowForm((v) => !v), className: "bg-slate-900 text-white px-4 py-2 rounded", children: showForm ? t("users.close") : t("users.create") })] }), showForm && (_jsx(CreateUserForm, { onCreated: () => {
                    setShowForm(false);
                    qc.invalidateQueries({ queryKey: ["users"] });
                } })), _jsx("div", { className: "bg-white rounded shadow overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-slate-50 text-slate-600", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-2", children: t("users.email") }), _jsx("th", { className: "text-left px-4 py-2", children: t("users.username") }), _jsx("th", { className: "text-left px-4 py-2", children: t("users.typeCol") }), _jsx("th", { className: "text-left px-4 py-2", children: t("users.permissionsCol") }), _jsx("th", { className: "text-left px-4 py-2", children: t("users.statusCol") }), _jsx("th", { className: "text-left px-4 py-2", children: t("users.actionsCol") })] }) }), _jsx("tbody", { children: users.data?.map((u) => (_jsx(UserRow, { user: u }, u.id))) })] }) })] }));
}
function CreateUserForm({ onCreated }) {
    const t = useT();
    const [email, setEmail] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [perms, setPerms] = useState(new Set());
    const [err, setErr] = useState(null);
    const mut = useMutation({
        mutationFn: () => api("/api/v1/users", {
            method: "POST",
            body: JSON.stringify({
                email,
                username,
                password,
                permissions: Array.from(perms),
            }),
        }),
        onSuccess: () => {
            setErr(null);
            onCreated();
        },
        onError: (e) => {
            setErr(e instanceof ApiError ? JSON.stringify(e.detail) : t("users.createError"));
        },
    });
    function toggle(p) {
        setPerms((prev) => {
            const next = new Set(prev);
            if (next.has(p))
                next.delete(p);
            else
                next.add(p);
            return next;
        });
    }
    function onSubmit(e) {
        e.preventDefault();
        mut.mutate();
    }
    return (_jsxs("form", { onSubmit: onSubmit, className: "bg-white rounded shadow p-5 mb-6", children: [_jsxs("div", { className: "grid grid-cols-3 gap-3 mb-4", children: [_jsx("input", { placeholder: t("users.email"), required: true, type: "email", value: email, onChange: (e) => setEmail(e.target.value), className: "border rounded px-3 py-2" }), _jsx("input", { placeholder: t("users.username"), required: true, minLength: 3, value: username, onChange: (e) => setUsername(e.target.value), className: "border rounded px-3 py-2" }), _jsx("input", { placeholder: t("users.password"), required: true, minLength: 8, type: "text", value: password, onChange: (e) => setPassword(e.target.value), className: "border rounded px-3 py-2" })] }), _jsxs("div", { className: "mb-4", children: [_jsx("div", { className: "text-sm font-medium mb-2", children: t("users.grantTitle") }), _jsx("div", { className: "grid grid-cols-2 gap-2", children: GRANTABLE.map((p) => (_jsxs("label", { className: "flex items-center gap-2 text-sm", children: [_jsx("input", { type: "checkbox", checked: perms.has(p), onChange: () => toggle(p) }), _jsxs("span", { children: [t(`perm.${p}`), " ", _jsx("code", { className: "text-xs text-slate-500", children: p })] })] }, p))) })] }), err && _jsx("div", { className: "text-rose-600 text-sm mb-3", children: err }), _jsx("button", { disabled: mut.isPending, className: "bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-60", children: mut.isPending ? t("users.createBusy") : t("users.createSubmit") })] }));
}
function UserRow({ user }) {
    const t = useT();
    const qc = useQueryClient();
    const toggleActive = useMutation({
        mutationFn: () => api(`/api/v1/users/${user.id}`, {
            method: "PATCH",
            body: JSON.stringify({ is_active: !user.is_active }),
        }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    });
    const reset = useMutation({
        mutationFn: (newPassword) => api(`/api/v1/users/${user.id}/reset-password`, {
            method: "POST",
            body: JSON.stringify({ new_password: newPassword }),
        }),
    });
    function onReset() {
        const np = window.prompt(t("users.resetPrompt"));
        if (!np || np.length < 8)
            return;
        reset.mutate(np);
    }
    return (_jsxs("tr", { className: "border-t", children: [_jsx("td", { className: "px-4 py-2", children: user.email }), _jsx("td", { className: "px-4 py-2", children: user.username }), _jsx("td", { className: "px-4 py-2", children: user.is_super_admin ? (_jsx("span", { className: "text-indigo-700 font-medium", children: t("role.super") })) : (t("role.sub")) }), _jsx("td", { className: "px-4 py-2 text-xs", children: user.is_super_admin ? (_jsx("span", { className: "text-slate-500", children: t("users.fullPerms") })) : user.permissions.length === 0 ? (_jsx("span", { className: "text-slate-400", children: t("users.noPerms") })) : (user.permissions.map((p) => (_jsx("span", { className: "inline-block bg-slate-100 px-2 py-0.5 rounded mr-1 mb-1", children: p }, p)))) }), _jsx("td", { className: "px-4 py-2", children: user.is_active ? (_jsx("span", { className: "text-emerald-700", children: t("users.active") })) : (_jsx("span", { className: "text-rose-700", children: t("users.disabled") })) }), _jsx("td", { className: "px-4 py-2 space-x-2", children: !user.is_super_admin && (_jsxs(_Fragment, { children: [_jsx("button", { onClick: () => toggleActive.mutate(), className: "text-sm text-slate-700 underline", children: user.is_active ? t("users.disable") : t("users.enable") }), _jsx("button", { onClick: onReset, className: "text-sm text-slate-700 underline", children: t("users.resetPassword") })] })) })] }));
}
