import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useI18n } from "../i18n";
import { useExtensionStatus } from "../hooks/useExtensionTrigger";
const NAV = [
    { to: "/workspaces", labelKey: "nav.workspaces", perm: "MEMBER_VIEW" },
    { to: "/queue", labelKey: "nav.queue", perm: "QUEUE_VIEW" },
    { to: "/audit-logs", labelKey: "nav.auditLog", perm: "AUDIT_LOG_VIEW" },
    { to: "/billing", labelKey: "nav.billing", perm: "BILLING_VIEW" },
    { to: "/users", labelKey: "nav.users", perm: "USER_MANAGE" },
    { to: "/settings", labelKey: "nav.settings" },
];
export default function Layout() {
    const { user, logout, hasPermission } = useAuth();
    const { lang, setLang, t } = useI18n();
    const navigate = useNavigate();
    const { installed: extInstalled, version: extVersion, lastRunResult, } = useExtensionStatus();
    function onLogout() {
        logout();
        navigate("/login");
    }
    return (_jsxs("div", { className: "min-h-screen flex", children: [_jsxs("aside", { className: "w-60 bg-slate-900 text-slate-100 flex flex-col", children: [_jsx("div", { className: "px-5 py-4 text-lg font-semibold border-b border-slate-700", children: "AutoGPT Admin" }), _jsx("nav", { className: "flex-1 px-2 py-3 space-y-1", children: NAV.filter((n) => !n.perm || hasPermission(n.perm)).map((n) => (_jsx(NavLink, { to: n.to, className: ({ isActive }) => `block px-3 py-2 rounded text-sm ${isActive ? "bg-slate-700" : "hover:bg-slate-800"}`, children: t(n.labelKey) }, n.to))) }), _jsxs("div", { className: "px-4 py-3 border-t border-slate-700 text-xs space-y-2", children: [_jsxs("div", { children: [_jsx("div", { className: "font-medium", children: user?.email }), _jsx("div", { className: "text-slate-400", children: user?.is_super_admin ? t("role.super") : t("role.sub") })] }), _jsxs("div", { className: `px-2 py-1 rounded text-xs ${extInstalled
                                    ? "bg-emerald-700/40 text-emerald-200"
                                    : "bg-rose-700/40 text-rose-200"}`, title: extInstalled
                                    ? "Bridge content script đã inject. Mutation tự trigger extension."
                                    : "Bridge chưa inject. Reload extension trong chrome://extensions/ rồi F5 trang này.", children: [extInstalled
                                        ? `✓ Extension${extVersion ? ` v${extVersion}` : ""}: connected`
                                        : "✗ Extension: not detected", !extInstalled && (_jsx("button", { onClick: () => window.location.reload(), className: "block mt-1 text-[10px] underline text-rose-100 hover:text-white", title: "Reload extension trong chrome://extensions/ tr\u01B0\u1EDBc khi b\u1EA5m n\u00FAt n\u00E0y", children: t("ext.reloadHint") })), lastRunResult && (_jsxs("div", { className: "text-slate-300 mt-1 text-[10px]", children: ["last run: ", lastRunResult.processed, " task \u00B7", " ", lastRunResult.lastStatus] }))] }), _jsxs("div", { children: [_jsx("label", { className: "block text-slate-400 mb-1", children: t("lang.switch") }), _jsxs("select", { value: lang, onChange: (e) => setLang(e.target.value), className: "w-full bg-slate-800 text-slate-100 border border-slate-700 rounded px-2 py-1 text-xs", children: [_jsx("option", { value: "vi", children: t("lang.vi") }), _jsx("option", { value: "zh-CN", children: t("lang.zh-CN") })] })] }), _jsx("button", { onClick: onLogout, className: "w-full text-left text-rose-300 hover:text-rose-200", children: t("auth.logout") })] })] }), _jsx("main", { className: "flex-1 p-8 overflow-auto", children: _jsx(Outlet, {}) })] }));
}
