import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useExtensionStatus } from "../hooks/useExtensionTrigger";
import { useT } from "../i18n";
import type { Workspace } from "../types";
import { WorkspaceBillingPanel } from "./WorkspaceBillingPanel";

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
    <div className="page-fade">
      <div
        className="flex items-start justify-between"
        style={{ gap: 24, marginBottom: 32, flexWrap: "wrap" }}
      >
        <div>
          <div className="breadcrumb">
            <Link to="/workspaces">{t("nav.workspaces")}</Link>
            <span className="breadcrumb-sep">/</span>
            {workspace?.name ?? "..."}
          </div>
          <h1 className="display-h1">{workspace?.name ?? t("nav.workspaces")}</h1>
          <p className="page-sub">{t("workspace.detailPageSub")}</p>
        </div>
        {workspace && <ConnectionInfo workspace={workspace} />}
      </div>

      <div className="tabs-bar">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end
            className={({ isActive }) => (isActive ? "tab active" : "tab")}
          >
            {t(tab.labelKey)}
          </NavLink>
        ))}
      </div>

      {workspace && <WorkspaceBillingPanel workspace={workspace} />}
      <Outlet />
    </div>
  );
}

function ConnectionInfo({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const { online: ssOnline } = useExtensionStatus(workspace.id);
  const lastSeen = workspace.last_extension_seen_at;
  const minutesAgo = lastSeen
    ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 60000)
    : null;
  const online =
    ssOnline === true ||
    (ssOnline === null && minutesAgo !== null && minutesAgo < 5);
  const userLabel = workspace.chatgpt_user_email
    ? workspace.chatgpt_user_name
      ? `${workspace.chatgpt_user_name} <${workspace.chatgpt_user_email}>`
      : workspace.chatgpt_user_email
    : null;

  const pillClass = online
    ? "status-pill online"
    : lastSeen
    ? "status-pill warn"
    : "status-pill idle";

  const title = online
    ? t("connection.online")
    : lastSeen
    ? t("connection.offline")
    : t("connection.never");

  const lastSeenText = lastSeen
    ? minutesAgo === 0
      ? t("connection.justNow")
      : t("connection.minutesAgo", { n: minutesAgo ?? 0 })
    : null;

  return (
    <div className="flex flex-col items-end" style={{ gap: 6 }}>
      <span className={pillClass}>
        <span className="dot" />
        {title}
        {lastSeenText && (
          <span style={{ color: "var(--ink-3)", marginLeft: 4 }}>
            · {lastSeenText}
          </span>
        )}
      </span>
      {userLabel && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--ink-3)",
          }}
        >
          {t("connection.user")}: {userLabel}
        </span>
      )}
    </div>
  );
}
