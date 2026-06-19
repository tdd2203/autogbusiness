import { useState } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { useAuth } from "../hooks/useAuth";
import { useExtensionStatus, triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { useBillingActions } from "../hooks/useBillingActions";
import { useI18n, useT } from "../i18n";
import { dashboardLangToChatGPTLocale } from "../lib/chatgpt-locale";
import type { QueueItem, Workspace } from "../types";
import { WorkspaceBillingPanel } from "./WorkspaceBillingPanel";
import { TaskCompletionBanner } from "./TaskCompletionBanner";
import { InviteMemberModal } from "./InviteMemberModal";
import { BulkRemoveModal } from "./BulkRemoveModal";
import { toast } from "./Toast";

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
  const [showBulkRemoveModal, setShowBulkRemoveModal] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

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
    // Poll 2s khi có task chạy; lúc idle KHÔNG dừng hẳn mà nhịp tim 10s. Lý do:
    // panel hàng đợi (WorkspaceTaskRail) phải hiện task do NGƯỜI/PHIÊN KHÁC tạo
    // (vd admin chính bấm Xoá/Đồng bộ trong khi "người thực hiện" mở dashboard ở
    // máy chạy extension để theo dõi) — phiên không tự bấm thì không có mutation
    // invalidate, nếu idle=false thì poll tắt vĩnh viễn → không bao giờ thấy task
    // mới. 10s đủ để task "bắn lên" rail mà vẫn nhẹ (40 tab ≈ 4 req/s). Xem
    // lib/queuePolling. Phiên TỰ tạo task vẫn thấy tức thì qua invalidate.
    refetchInterval: queuePollInterval(2000, 10000),
  });

  // Billing actions (sync-billing + cancel billing task) + vòng đời billing task
  // đã tách ra hook — xem useBillingActions.md.
  // cancelBillingTask KHÔNG còn dùng ở đây — tiến trình + huỷ task billing đã chuyển
  // sang panel cột phải (WorkspaceTaskRail). Giữ activeBillingTask để biết khi nào
  // chuyển sang banner KẾT QUẢ (completion).
  const {
    syncBilling,
    activeBillingTask,
    lastBillingTask,
    showBillingCompletion,
    setLastBillingTaskId,
  } = useBillingActions(workspaceId, workspace, recentTasks);

  const tabs = TABS.filter((tab) => !tab.superAdminOnly || user?.is_super_admin);

  // ---- Đồng bộ TOÀN BỘ (full-sync) từ ChatGPT về DB ----
  // Mở modal 3 lựa chọn scope: members / invites / both → tạo task SYNC_DATA,
  // extension scrape danh sách từ chatgpt.com/admin rồi bulk-upsert về DB.
  // (Khôi phục lại sau khi từng bị gỡ tạm 2026-06-17. Backend /sync vẫn sẵn.)
  // Đồng bộ 1 tài khoản lẻ per-row ở tab "Chờ tham gia" (Members.tsx) là tính
  // năng riêng, không thay thế full-sync này.
  const syncMembers = useMutation({
    mutationFn: async (scope: "members" | "invites" | "both") => {
      setSyncOpen(false);
      // expected_locale chỉ để extension BÁO LỖI / hướng dẫn nếu ChatGPT lệch ngôn ngữ —
      // KHÔNG tự đổi Settings giúp user.
      const expectedLocale = dashboardLangToChatGPTLocale(lang);
      return api<{ queue_item_id: string }>(
        `/api/v1/workspaces/${workspaceId}/sync?scope=${scope}&expected_locale=${expectedLocale}`,
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

  function openInviteForm() {
    setShowInviteModal(true);
  }

  const canSync = hasPermission("WORKSPACE_SYNC_TRIGGER");
  const canInvite = hasPermission("MEMBER_INVITE");
  const canRemove = hasPermission("MEMBER_REMOVE");
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

      {/* HÀNG 1: tabs + nút hành động. Cột trái rộng = cột nội dung; có spacer giữ
          chỗ cột phải (= bề rộng rail) khi rail hiển thị → mép phải hàng nút trùng
          mép phải bảng thành viên (không lấn sang panel hàng đợi). */}
      <div className="flex items-start" style={{ gap: 24, marginBottom: 16 }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div
            className="flex items-center"
            style={{
              gap: 12,
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
            {/* Hàng nút hành động — căn phải sát mép bảng, hiển thị thẳng hàng. */}
            <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
              {user?.is_super_admin && (
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
                  onClick={() => setSyncOpen(true)}
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
              {(canRemove || user?.is_super_admin) && (
                <button
                  onClick={() => setShowBulkRemoveModal(true)}
                  className="btn btn-sm btn-ghost"
                >
                  {t("bulkUpdate.openModalBtn")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Banner KẾT QUẢ billing — full-width, nằm dưới hàng tabs, trên hàng nội dung.
          (Banner TIẾN TRÌNH billing đã chuyển sang panel "Hàng đợi tác vụ" cột phải.) */}
      {!activeBillingTask && showBillingCompletion && lastBillingTask && (
        <div style={{ marginBottom: 16 }}>
          <TaskCompletionBanner
            task={lastBillingTask}
            onDismiss={() => setLastBillingTaskId(null)}
          />
        </div>
      )}

      {/* Nội dung chính. Panel "Hàng đợi tác vụ" đã chuyển VÀO trang Thành viên
          (Members.tsx) — nằm giữa phần tổng quan (metrics) và bảng danh sách. */}
      <div>
        {workspace && hasPermission("BILLING_VIEW") && (
          <WorkspaceBillingPanel workspace={workspace} />
        )}
        <Outlet />
      </div>

      {syncOpen && (
        <div
          onClick={() => setSyncOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="settings-section"
            style={{ width: 360, maxWidth: "90vw", background: "var(--surface, #1e1e1e)" }}
          >
            <h3 className="display-h3" style={{ marginBottom: 16 }}>
              {t("member.syncButton")}
            </h3>
            <div className="flex flex-col" style={{ gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={syncMembers.isPending}
                onClick={() => syncMembers.mutate("members")}
              >
                {t("member.syncScopeMembers")}
              </button>
              <button
                className="btn btn-primary"
                disabled={syncMembers.isPending}
                onClick={() => syncMembers.mutate("invites")}
              >
                {t("member.syncScopeInvites")}
              </button>
              <button
                className="btn btn-primary"
                disabled={syncMembers.isPending}
                onClick={() => syncMembers.mutate("both")}
              >
                {t("member.syncScopeBoth")}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setSyncOpen(false)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

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
      {showBulkRemoveModal && workspaceId && (
        <BulkRemoveModal
          workspaceId={workspaceId}
          onClose={() => setShowBulkRemoveModal(false)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
            triggerExtensionRun();
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

