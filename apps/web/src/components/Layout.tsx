import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const NAV: { to: string; label: string; perm?: string }[] = [
  { to: "/workspaces", label: "Workspaces", perm: "MEMBER_VIEW" },
  { to: "/queue", label: "Queue", perm: "QUEUE_VIEW" },
  { to: "/audit-logs", label: "Audit Log", perm: "AUDIT_LOG_VIEW" },
  { to: "/billing", label: "Billing", perm: "BILLING_VIEW" },
  { to: "/users", label: "Tài khoản phụ", perm: "USER_MANAGE" },
  { to: "/settings", label: "Cài đặt" },
];

export default function Layout() {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();

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
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-slate-700 text-xs">
          <div className="font-medium">{user?.email}</div>
          <div className="text-slate-400 mb-2">
            {user?.is_super_admin ? "Super-admin" : "Sub-admin"}
          </div>
          <button
            onClick={onLogout}
            className="w-full text-left text-rose-300 hover:text-rose-200"
          >
            Đăng xuất
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
