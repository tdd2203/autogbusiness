import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useT } from "../i18n";
export default function Billing() {
    const t = useT();
    return (_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold mb-6", children: t("billing.title") }), _jsx("div", { className: "bg-white rounded shadow p-6", children: _jsxs("p", { className: "text-slate-600", children: [t("nav.billing"), " \u2014 coming soon."] }) })] }));
}
