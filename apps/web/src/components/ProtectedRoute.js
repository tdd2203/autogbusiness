import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
export default function ProtectedRoute({ children, requirePermission, requireSuperAdmin, }) {
    const t = useT();
    const { user, loading, hasPermission } = useAuth();
    const location = useLocation();
    if (loading)
        return _jsx("div", { className: "p-8", children: t("common.loading") });
    if (!user)
        return _jsx(Navigate, { to: "/login", state: { from: location }, replace: true });
    if (requireSuperAdmin && !user.is_super_admin) {
        return (_jsxs("div", { className: "p-8", children: [_jsx("h1", { className: "text-xl font-semibold mb-2", children: t("protected.403SuperTitle") }), _jsx("p", { className: "text-slate-600", children: t("protected.403Super") })] }));
    }
    if (requirePermission && !hasPermission(requirePermission)) {
        return (_jsxs("div", { className: "p-8", children: [_jsx("h1", { className: "text-xl font-semibold mb-2", children: t("protected.403Title") }), _jsx("p", { className: "text-slate-600", children: t("protected.403Perm", { perm: requirePermission }) })] }));
    }
    return _jsx(_Fragment, { children: children });
}
