import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ApiError } from "../lib/api";
import { useT } from "../i18n";
export default function Login() {
    const t = useT();
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    async function onSubmit(e) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            await login(identifier.trim(), password);
            const to = location.state?.from?.pathname ?? "/workspaces";
            navigate(to, { replace: true });
        }
        catch (err) {
            if (err instanceof ApiError) {
                setError(typeof err.detail === "string" ? err.detail : t("auth.errorAuth"));
            }
            else {
                setError(t("auth.errorConnection"));
            }
        }
        finally {
            setBusy(false);
        }
    }
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-slate-100", children: _jsxs("form", { onSubmit: onSubmit, className: "w-full max-w-sm bg-white p-8 rounded-lg shadow", children: [_jsx("h1", { className: "text-xl font-semibold mb-1", children: t("auth.title") }), _jsx("p", { className: "text-sm text-slate-500 mb-6", children: t("auth.subtitle") }), _jsx("label", { className: "block text-sm font-medium mb-1", children: t("auth.identifier") }), _jsx("input", { autoFocus: true, required: true, value: identifier, onChange: (e) => setIdentifier(e.target.value), className: "w-full border border-slate-300 rounded px-3 py-2 mb-4 outline-none focus:border-slate-500" }), _jsx("label", { className: "block text-sm font-medium mb-1", children: t("auth.password") }), _jsx("input", { type: "password", required: true, value: password, onChange: (e) => setPassword(e.target.value), className: "w-full border border-slate-300 rounded px-3 py-2 mb-4 outline-none focus:border-slate-500" }), error && (_jsx("div", { className: "text-rose-600 text-sm mb-3 bg-rose-50 border border-rose-200 rounded px-3 py-2", children: error })), _jsx("button", { disabled: busy, className: "w-full bg-slate-900 text-white rounded py-2 hover:bg-slate-800 disabled:opacity-60", children: busy ? t("auth.loginBusy") : t("auth.login") })] }) }));
}
