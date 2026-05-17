import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
import type { Workspace } from "../types";

type Tab = { to: string; labelKey: string; superAdminOnly?: boolean };

const TABS: Tab[] = [
  { to: "members", labelKey: "workspace.tabMembers" },
  { to: "queue", labelKey: "workspace.tabQueue" },
  { to: "extension", labelKey: "workspace.tabExtension", superAdminOnly: true },
  { to: "settings", labelKey: "workspace.tabSettings", superAdminOnly: true },
];

export default function WorkspaceLayout() {
  const t = useT();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { user } = useAuth();

  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  const tabs = TABS.filter((tab) => !tab.superAdminOnly || user?.is_super_admin);

  return (
    <div>
      <div className="text-sm text-slate-500 mb-1">
        <Link to="/workspaces" className="hover:underline">
          {t("nav.workspaces")}
        </Link>
        {" / "}
        <span>{workspace?.name ?? "..."}</span>
      </div>
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-4">
        <h1 className="text-2xl font-semibold">
          {workspace?.name ?? t("nav.workspaces")}
        </h1>
        {workspace && (
          <ConnectionInfo workspace={workspace} />
        )}
      </div>

      <div className="border-b mb-6">
        <nav className="flex gap-1">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end
              className={({ isActive }) =>
                `px-4 py-2 text-sm border-b-2 -mb-px ${
                  isActive
                    ? "border-slate-900 text-slate-900 font-medium"
                    : "border-transparent text-slate-600 hover:text-slate-900"
                }`
              }
            >
              {t(tab.labelKey)}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet />
    </div>
  );
}

function ConnectionInfo({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const lastSeen = workspace.last_extension_seen_at;
  const minutesAgo = lastSeen
    ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 60000)
    : null;
  const online = minutesAgo !== null && minutesAgo < 5;
  const userLabel = workspace.chatgpt_user_email
    ? workspace.chatgpt_user_name
      ? `${workspace.chatgpt_user_name} <${workspace.chatgpt_user_email}>`
      : workspace.chatgpt_user_email
    : null;

  return (
    <div
      className={`px-3 py-2 rounded-lg text-xs border ${
        online
          ? "bg-emerald-50 border-emerald-300 text-emerald-900"
          : lastSeen
          ? "bg-amber-50 border-amber-300 text-amber-900"
          : "bg-slate-100 border-slate-300 text-slate-600"
      }`}
    >
      <div className="font-medium">
        {online
          ? t("connection.online")
          : lastSeen
          ? t("connection.offline")
          : t("connection.never")}
      </div>
      {userLabel && (
        <div className="font-mono text-[11px] mt-0.5">
          {t("connection.user")}: {userLabel}
        </div>
      )}
      {lastSeen && (
        <div className="text-[11px] text-slate-600 mt-0.5">
          {t("connection.lastSeen")}:{" "}
          {minutesAgo === 0
            ? t("connection.justNow")
            : t("connection.minutesAgo", { n: minutesAgo ?? 0 })}
        </div>
      )}
    </div>
  );
}
