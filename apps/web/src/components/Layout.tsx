import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useI18n, type Lang } from "../i18n";
import { useExtensionStatus } from "../hooks/useExtensionTrigger";

const NAV: { to: string; labelKey: string; perm?: string }[] = [
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
  const {
    installed: extInstalled,
    version: extVersion,
    lastRunResult,
  } = useExtensionStatus();

  function onLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-5 py-4 text-lg font-semibold border-b border-slate-700">
          AutoGPT Admin
        </div>
        <nav className="flex-1 px-2 py-3 space-y-1">
          {NAV.filter((n) => !n.perm || hasPermission(n.perm)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `block px-3 py-2 rounded text-sm ${
                  isActive ? "bg-slate-700" : "hover:bg-slate-800"
                }`
              }
            >
              {t(n.labelKey)}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-slate-700 text-xs space-y-2">
          <div>
            <div className="font-medium">{user?.email}</div>
            <div className="text-slate-400">
              {user?.is_super_admin ? t("role.super") : t("role.sub")}
            </div>
          </div>
          <div
            className={`px-2 py-1 rounded text-xs ${
              extInstalled
                ? "bg-emerald-700/40 text-emerald-200"
                : "bg-rose-700/40 text-rose-200"
            }`}
            title={
              extInstalled
                ? "Bridge content script đã inject. Mutation tự trigger extension."
                : "Bridge chưa inject. Reload extension trong chrome://extensions/ rồi F5 trang này."
            }
          >
            {extInstalled
              ? `✓ Extension${extVersion ? ` v${extVersion}` : ""}: connected`
              : "✗ Extension: not detected"}
            {!extInstalled && (
              <button
                onClick={() => window.location.reload()}
                className="block mt-1 text-[10px] underline text-rose-100 hover:text-white"
                title="Reload extension trong chrome://extensions/ trước khi bấm nút này"
              >
                {t("ext.reloadHint")}
              </button>
            )}
            {lastRunResult && (
              <div className="text-slate-300 mt-1 text-[10px]">
                last run: {lastRunResult.processed} task ·{" "}
                {lastRunResult.lastStatus}
              </div>
            )}
          </div>
          <div>
            <label className="block text-slate-400 mb-1">
              {t("lang.switch")}
            </label>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
              className="w-full bg-slate-800 text-slate-100 border border-slate-700 rounded px-2 py-1 text-xs"
            >
              <option value="vi">{t("lang.vi")}</option>
              <option value="zh-CN">{t("lang.zh-CN")}</option>
            </select>
          </div>
          <button
            onClick={onLogout}
            className="w-full text-left text-rose-300 hover:text-rose-200"
          >
            {t("auth.logout")}
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
