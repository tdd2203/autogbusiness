import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useExtensionStatus } from "../hooks/useExtensionTrigger";
import { useT } from "../i18n";
import type { Workspace } from "../types";
import { WorkspaceBillingPanel } from "./WorkspaceBillingPanel";
import { confirm, toast } from "./Toast";

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
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  const tabs = TABS.filter((tab) => !tab.superAdminOnly || user?.is_super_admin);

  // ---- 3 action mutations dùng chung cho toàn workspace ----
  const syncMembers = useMutation({
    mutationFn: async () => {
      const includePending = await confirm(t("member.syncConfirmBody"), {
        title: t("member.syncConfirmTitle"),
        okText: t("member.syncConfirmOk"),
        cancelText: t("member.syncConfirmCancel"),
      });
      return api<{ queue_item_id: string }>(
        `/api/v1/workspaces/${workspaceId}/sync?include_pending=${includePending}`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("member.syncQueued"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? String(e.detail) : String(e);
      toast.error(msg);
    },
  });

  const syncBilling = useMutation({
    mutationFn: async () => {
      if (workspace?.last_billing_synced_at) {
        const ok = await confirm(
          t("billing.alreadySyncedWarn", {
            time: new Date(workspace.last_billing_synced_at).toLocaleString("vi-VN"),
          }),
          {
            title: t("billing.workspaceTitle"),
            okText: t("billing.syncAgainAnyway"),
            cancelText: t("common.cancel"),
          },
        );
        if (!ok) throw new Error("__user_cancel__");
      }
      return api<{ queue_item_id: string }>(
        `/api/v1/workspaces/${workspaceId}/sync-billing`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("billing.syncQueuedToast"));
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      const msg = e instanceof ApiError ? String(e.detail) : String(e);
      toast.error(t("billing.syncErrorToast", { error: msg }));
    },
  });

  function openInviteForm() {
    // Members.tsx đọc URL param ?invite=1 để auto-mở form
    navigate(`/workspaces/${workspaceId}/members?invite=1`);
  }

  const canSync = hasPermission("WORKSPACE_SYNC_TRIGGER");
  const canInvite = hasPermission("MEMBER_INVITE");
  const alreadySyncedBilling = !!workspace?.last_billing_synced_at;

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

      <div
        className="flex items-center"
        style={{
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
          justifyContent: "space-between",
        }}
      >
        <div className="tabs-bar" style={{ marginBottom: 0 }}>
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
        <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
          {canSync && (
            <button
              onClick={() => syncBilling.mutate()}
              disabled={syncBilling.isPending}
              className={`btn btn-sm ${alreadySyncedBilling ? "btn-ghost" : "btn-primary"}`}
              title={t("billing.syncTooltip")}
            >
              {syncBilling.isPending
                ? t("billing.syncBusy")
                : t("billing.syncButton")}
            </button>
          )}
          {canSync && (
            <button
              onClick={() => syncMembers.mutate()}
              disabled={syncMembers.isPending}
              className="btn btn-sm btn-ghost"
              title={t("member.syncTooltip")}
            >
              {syncMembers.isPending
                ? t("member.syncBusy")
                : t("member.syncButton")}
            </button>
          )}
          {canInvite && (
            <button
              onClick={openInviteForm}
              className="btn btn-sm btn-primary"
            >
              {t("member.inviteButton")}
            </button>
          )}
        </div>
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
