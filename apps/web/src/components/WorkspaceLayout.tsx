import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useExtensionStatus } from "../hooks/useExtensionTrigger";
import { useI18n, useT } from "../i18n";
import { dashboardLangToChatGPTLocale } from "../lib/chatgpt-locale";
import type { QueueItem, Workspace } from "../types";
import { WorkspaceBillingPanel } from "./WorkspaceBillingPanel";
import { TaskCompletionBanner } from "./TaskCompletionBanner";
import { TaskProgressBanner } from "./TaskProgressBanner";
import { confirm, toast } from "./Toast";
import { InviteMemberModal } from "./InviteMemberModal";

type Tab = { to: string; labelKey: string; superAdminOnly?: boolean };

const TABS: Tab[] = [
  { to: "members", labelKey: "workspace.tabMembers" },
  { to: "queue", labelKey: "workspace.tabQueue" },
  { to: "extension", labelKey: "workspace.tabExtension", superAdminOnly: true },
  { to: "settings", labelKey: "workspace.tabSettings", superAdminOnly: true },
];

export default function WorkspaceLayout() {
  const t = useT();
  const { lang } = useI18n();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { user, hasPermission } = useAuth();
  const qc = useQueryClient();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [lastBillingTaskId, setLastBillingTaskId] = useState<string | null>(null);

  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  // Poll recent-tasks để theo dõi tiến trình SYNC_BILLING (extension report
  // phase navigate→scraping→uploading). Cùng queryKey với Members.tsx nên
  // react-query auto-dedupe.
  const { data: recentTasks = [] } = useQuery({
    queryKey: ["recent-tasks", workspaceId],
    queryFn: () =>
      api<QueueItem[]>(`/api/v1/queue?workspace_id=${workspaceId}&limit=50`),
    enabled: !!workspaceId,
    refetchInterval: 2000,
  });

  const activeBillingTask = recentTasks.find(
    (t) =>
      t.type === "SYNC_BILLING" &&
      (t.status === "PENDING" || t.status === "IN_PROGRESS"),
  );
  const lastBillingTask = lastBillingTaskId
    ? recentTasks.find((t) => t.id === lastBillingTaskId) ?? null
    : null;
  const showBillingCompletion =
    lastBillingTask?.status === "COMPLETED" ||
    lastBillingTask?.status === "FAILED";

  // Khi billing task COMPLETED → refresh workspace để bảng billing show data mới
  useEffect(() => {
    if (lastBillingTask?.status === "COMPLETED") {
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    }
  }, [lastBillingTask?.status, qc, workspaceId]);

  // Auto-dismiss completion banner sau 10s khi COMPLETED (giữ lại FAILED để user đọc)
  useEffect(() => {
    if (!showBillingCompletion || lastBillingTask?.status !== "COMPLETED") return;
    const timer = setTimeout(() => setLastBillingTaskId(null), 10_000);
    return () => clearTimeout(timer);
  }, [showBillingCompletion, lastBillingTask?.status]);

  const cancelBillingTask = useMutation({
    mutationFn: async (taskId: string) => {
      const ok = await confirm(t("queue.cancelConfirm", { type: "SYNC_BILLING" }), {
        title: t("queue.cancelConfirmTitle"),
        okText: t("queue.cancelOk"),
        cancelText: t("common.cancel"),
        danger: true,
      });
      if (!ok) throw new Error("__user_cancel__");
      return api<{ id: string; status: string }>(
        `/api/v1/queue/${taskId}/cancel`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("queue.cancelOkToast"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      toast.error(
        t("queue.cancelError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
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
      // expected_locale chỉ để extension BÁO LỖI / hướng dẫn nếu ChatGPT lệch ngôn ngữ —
      // KHÔNG tự đổi Settings giúp user.
      const expectedLocale = dashboardLangToChatGPTLocale(lang);
      return api<{ queue_item_id: string }>(
        `/api/v1/workspaces/${workspaceId}/sync?include_pending=${includePending}&expected_locale=${expectedLocale}`,
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
    onSuccess: (resp) => {
      toast.success(t("billing.syncQueuedToast"));
      setLastBillingTaskId(resp.queue_item_id);
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      const msg = e instanceof ApiError ? String(e.detail) : String(e);
      toast.error(t("billing.syncErrorToast", { error: msg }));
    },
  });

  function openInviteForm() {
    setShowInviteModal(true);
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

      {activeBillingTask && (
        <div style={{ marginBottom: 16 }}>
          <TaskProgressBanner
            task={activeBillingTask}
            onCancel={() => cancelBillingTask.mutate(activeBillingTask.id)}
            canceling={cancelBillingTask.isPending}
          />
        </div>
      )}
      {!activeBillingTask && showBillingCompletion && lastBillingTask && (
        <div style={{ marginBottom: 16 }}>
          <TaskCompletionBanner
            task={lastBillingTask}
            onDismiss={() => setLastBillingTaskId(null)}
          />
        </div>
      )}

      {workspace && <WorkspaceBillingPanel workspace={workspace} />}
      <Outlet />

      {showInviteModal && workspaceId && (
        <InviteMemberModal
          workspaceId={workspaceId}
          onClose={() => setShowInviteModal(false)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
          }}
        />
      )}
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

