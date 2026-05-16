import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import type { Workspace } from "../types";

type Tab = { to: string; label: string; superAdminOnly?: boolean };

const TABS: Tab[] = [
  { to: "members", label: "Thành viên" },
  { to: "queue", label: "Queue" },
  { to: "extension", label: "Extension", superAdminOnly: true },
  { to: "settings", label: "Cài đặt", superAdminOnly: true },
];

export default function WorkspaceLayout() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { user } = useAuth();

  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  const tabs = TABS.filter((t) => !t.superAdminOnly || user?.is_super_admin);

  return (
    <div>
      <div className="text-sm text-slate-500 mb-1">
        <Link to="/workspaces" className="hover:underline">
          Workspaces
        </Link>
        {" / "}
        <span>{workspace?.name ?? "..."}</span>
      </div>
      <h1 className="text-2xl font-semibold mb-4">
        {workspace?.name ?? "Workspace"}
      </h1>

      <div className="border-b mb-6">
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end
              className={({ isActive }) =>
                `px-4 py-2 text-sm border-b-2 -mb-px ${
                  isActive
                    ? "border-slate-900 text-slate-900 font-medium"
                    : "border-transparent text-slate-600 hover:text-slate-900"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet />
    </div>
  );
}
