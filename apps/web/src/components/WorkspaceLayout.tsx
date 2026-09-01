import { useState } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { useAuth } from "../hooks/useAuth";
import { usePlatform, workspaceBasePath } from "../hooks/usePlatform";
import { useExtensionStatus, triggerExtensionRun } from "../hooks/useExtensionTrigger";
import { useBillingActions } from "../hooks/useBillingActions";
import { useT } from "../i18n";
import type { QueueItem, Workspace } from "../types";
import { TaskCompletionBanner } from "./TaskCompletionBanner";
import { InviteMemberModal } from "./InviteMemberModal";
import { ManualAddModal } from "./ManualAddModal";
import { BulkRemoveModal } from "./BulkRemoveModal";
import { PasteInvoiceModal } from "./PasteInvoiceModal";
import { toast, confirm } from "./Toast";

type Tab = {
  to: string;
  labelKey: string;
  superAdminOnly?: boolean;
  permission?: string;
  /** Chỉ hiện ở nhánh ChatGPT (Canva không có thứ tương ứng). */
  gptOnly?: boolean;
};

const TABS: Tab[] = [
  { to: "members", labelKey: "workspace.tabMembers" },
  // "Gia hạn" đã chuyển sang trang "Email đã add" (sub-tab) — gom xuyên workspace.
  // "Thanh toán" chỉ ChatGPT: Canva không có hoá đơn Stripe nào để đọc.
  {
    to: "billing",
    labelKey: "workspace.tabBilling",
    permission: "BILLING_VIEW",
    gptOnly: true,
  },
  { to: "queue", labelKey: "workspace.tabQueue" },
  { to: "extension", labelKey: "workspace.tabExtension", superAdminOnly: true },
  { to: "settings", labelKey: "workspace.tabSettings", superAdminOnly: true },
];

export default function WorkspaceLayout() {
  const t = useT();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { user, hasPermission } = useAuth();
  // Nhánh của khung này. Canva KHÔNG có: hoá đơn Stripe (tab Thanh toán + nút dán
  // hoá đơn) — mọi thứ còn lại (thành viên, hàng đợi, extension, cài đặt) dùng chung.
  const platform = usePlatform();
  const isCanva = platform === "canva";
  const base = workspaceBasePath(platform);
  const qc = useQueryClient();
  const [showInviteModal, setShowInviteModal] = useState(false);
  // Modal "Thêm thủ công" — bản ghi quản lý cho email đã ở trên ChatGPT (auto-create),
  // KHÔNG mời qua extension / không trừ ví. Chỉ super-admin (xem nút bên dưới).
  const [showManualAddModal, setShowManualAddModal] = useState(false);
  const [showBulkRemoveModal, setShowBulkRemoveModal] = useState(false);
  // Giá trị mở sẵn cho modal Cập nhật hàng loạt (khi mở từ dropdown inline trong
  // Members: chọn hành động + điền sẵn email đã tích). null = mở rỗng từ header.
  const [bulkInitial, setBulkInitial] = useState<{
    action?: string;
    emails?: string[];
  } | null>(null);
  // Popup DÁN chi tiết hoá đơn (thay scrape) — mở khi bấm "Cập nhật giá & ngày renew".
  const [pasteBillingOpen, setPasteBillingOpen] = useState(false);

  // Cho phép trang con (Members) mở modal Cập nhật hàng loạt với hành động + email
  // điền sẵn — truyền xuống qua Outlet context.
  function openBulkUpdate(action?: string, emails?: string[]) {
    setBulkInitial(action || emails ? { action, emails } : null);
    setShowBulkRemoveModal(true);
  }

  const { data: workspace, error: workspaceError } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
    // 404 = workspace không tồn tại hoặc sub-admin đã bị gỡ quyền truy cập.
    // Không retry để hiện màn "không tìm thấy" ngay thay vì nã lại.
    retry: (failureCount, err) =>
      err instanceof ApiError && err.status === 404 ? false : failureCount < 3,
  });

  // Sub-admin bị gỡ khỏi workspace → backend trả 404 (assert_workspace_access).
  // Trước đây lỗi bị nuốt, trang render vỏ rỗng (header "Workspaces" + số 0).
  // Nay hiện màn "không tìm thấy / hết quyền" rõ ràng, không dựng tab/Outlet.
  const notFound =
    workspaceError instanceof ApiError && workspaceError.status === 404;

  // Poll recent-tasks để theo dõi tiến trình SYNC_BILLING (extension report
  // phase navigate→scraping→uploading). Cùng queryKey với Members.tsx nên
  // react-query auto-dedupe.
  const { data: recentTasks = [] } = useQuery({
    queryKey: ["recent-tasks", workspaceId],
    queryFn: () =>
      api<QueueItem[]>(`/api/v1/queue?workspace_id=${workspaceId}&limit=50`),
    // Cần QUEUE_VIEW: nhánh Canva mở khung này cho tài khoản phụ, ai bị gỡ quyền
    // xem hàng đợi mà vẫn poll thì chỉ tổ nã 403 vài giây một lần.
    enabled: !!workspaceId && hasPermission("QUEUE_VIEW"),
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
    activeBillingTask,
    lastBillingTask,
    showBillingCompletion,
    setLastBillingTaskId,
  } = useBillingActions(workspaceId, workspace, recentTasks);

  const tabs = TABS.filter(
    (tab) =>
      (!tab.superAdminOnly || user?.is_super_admin) &&
      (!tab.permission || hasPermission(tab.permission)) &&
      (!tab.gptOnly || !isCanva),
  );

  // Số liệu tổng quan (tổng/active/chờ/hàng đợi) hiển thị bằng KHỐI 4 THẺ TO ở
  // đầu trang Thành viên (Members.tsx) — theo mockup. Không còn cụm gọn trên hàng
  // tab nữa; hàng tab chỉ còn tab + nút hành động.

  // ---- Đồng bộ TOÀN BỘ (full-sync) từ ChatGPT về DB ----
  // (user 2026-08-24) BỎ modal chọn scope: nút "Đồng bộ từ ChatGPT" chỉ hỏi
  // XÁC NHẬN 1 lần rồi chạy luôn scope="both" (quét CẢ tab "Người dùng" lẫn tab
  // "Lời mời đang chờ"). Tách riêng từng tab không còn cần — chọn nhầm scope chỉ
  // làm dữ liệu lệch. Giữ 1 bước xác nhận vì đây là task nặng, chạy nhầm thì
  // chiếm extension + tab chatgpt.com/admin của người khác.
  // Tạo task SYNC_DATA → extension scrape chatgpt.com/admin rồi bulk-upsert về DB.
  // Đồng bộ 1 tài khoản lẻ per-row ở tab "Chờ tham gia" (Members.tsx) là tính
  // năng riêng, không thay thế full-sync này.
  const syncMembers = useMutation({
    mutationFn: async () => {
      // Không cần body: tiêu đề + nút "Đồng bộ ngay" đã nói đủ.
      const ok = await confirm("", {
        title: t(isCanva ? "canva.syncButton" : "member.syncButton"),
        okText: t("member.syncConfirmOk"),
        cancelText: t("common.cancel"),
      });
      if (!ok) throw new Error("__user_cancel__");
      const scope = "both";
      // expected_locale chỉ để extension BÁO LỖI / hướng dẫn nếu ChatGPT lệch ngôn ngữ —
      // KHÔNG tự đổi Settings giúp user. Nguồn = "ngôn ngữ hệ thống" của workspace
      // (super-admin đặt ở Cài đặt), KHÔNG phải ngôn ngữ HIỂN THỊ dashboard của
      // người bấm sync (per-user). Mặc định 'vi' khi chưa tải xong workspace.
      const expectedLocale = workspace?.chatgpt_locale ?? "vi";
      return api<{ queue_item_id: string }>(
        `/api/v1/workspaces/${workspaceId}/sync?scope=${scope}&expected_locale=${expectedLocale}`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t(isCanva ? "canva.syncQueued" : "member.syncQueued"));
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      // `e.message` chứ không `String(e.detail)`: cooldown đồng bộ toàn bộ trả
      // detail dạng object, ép chuỗi thẳng ra "[object Object]".
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
    },
  });

  // scope="both" quét CẢ hai tab trên ChatGPT: "Người dùng" (active) và "Lời mời
  // đang chờ xử lý" (pending). Sau khi quét, backend `reconcile.py` đối chiếu:
  // email dashboard để "chờ tham gia" mà không còn ở tab Lời mời → tra tiếp tab
  // Người dùng → thấy ⇒ promote active, không thấy ⇒ giữ pending.

  function openInviteForm() {
    setShowInviteModal(true);
  }

  // Full-sync toàn workspace (nút "Đồng bộ từ ChatGPT") gate bằng quyền RIÊNG
  // WORKSPACE_FULL_SYNC — mặc định TẮT cho tài khoản phụ (khoá sẵn), super-admin
  // tick mới hiện; super-admin luôn có. (Đồng bộ pending lẻ / batch ở tab "Chờ
  // tham gia" là tính năng khác, mở mặc định — không bị khoá theo nút này.)
  const canSync = hasPermission("WORKSPACE_FULL_SYNC");
  const canInvite = hasPermission("MEMBER_INVITE");
  const alreadySyncedBilling = !!workspace?.last_billing_synced_at;

  if (notFound) {
    return (
      <div className="page-fade" style={{ padding: 32 }}>
        <p style={{ color: "var(--ink-2)" }}>{t("protected.404Workspace")}</p>
      </div>
    );
  }

  return (
    <div className="page-fade">
      <div
        className="flex items-start justify-between"
        style={{ gap: 24, marginBottom: 32, flexWrap: "wrap" }}
      >
        <div>
          <div className="breadcrumb">
            <Link to={base}>
              {t(isCanva ? "nav.canvaTeams" : "nav.workspaces")}
            </Link>
            <span className="breadcrumb-sep">/</span>
            {workspace?.name ?? "..."}
          </div>
          <h1 className="display-h1">
            {workspace?.name ??
              t(isCanva ? "nav.canvaTeams" : "nav.workspaces")}
          </h1>
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
              {user?.is_super_admin && !isCanva && (
                <button
                  onClick={() => setPasteBillingOpen(true)}
                  className={`btn btn-sm ${alreadySyncedBilling ? "btn-ghost" : "btn-primary"}`}
                  title={t("billing.pasteTooltip")}
                >
                  {t("billing.syncButton")}
                </button>
              )}
              {canSync && (
                <button
                  onClick={() => syncMembers.mutate()}
                  disabled={syncMembers.isPending}
                  className="btn btn-sm btn-ghost"
                  title={t(isCanva ? "canva.syncTooltip" : "member.syncTooltip")}
                >
                  {syncMembers.isPending
                    ? t("member.syncBusy")
                    : t(isCanva ? "canva.syncButton" : "member.syncButton")}
                </button>
              )}
              {/* "Thêm thủ công" — CHỈ super-admin: ghi nhận email đã ở trên ChatGPT
                  (auto-create) để quản lý, không mời qua extension / không trừ ví. */}
              {user?.is_super_admin && (
                <button
                  onClick={() => setShowManualAddModal(true)}
                  className="btn btn-sm btn-ghost"
                  title={t("manualAdd.buttonTooltip")}
                >
                  {t("member.manualAddButton")}
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
              {/* Nút "Cập nhật hàng loạt" đã ẩn theo yêu cầu. Modal vẫn mở được
                  qua openBulkUpdate() từ thanh thao tác hàng loạt trong bảng. */}
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

      {/* Panel billing đã chuyển sang tab riêng "Thanh toán"
          (pages/WorkspaceBilling.tsx) — không còn chèn trên đầu các tab khác. */}
      <div>
        <Outlet context={{ openBulkUpdate }} />
      </div>

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
      {showManualAddModal && workspaceId && (
        <ManualAddModal
          workspaceId={workspaceId}
          verifiedDomain={workspace?.verified_domain ?? null}
          onClose={() => setShowManualAddModal(false)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["members", workspaceId] });
            qc.invalidateQueries({ queryKey: ["member-stats", workspaceId] });
          }}
        />
      )}
      {pasteBillingOpen && workspaceId && (
        <PasteInvoiceModal
          workspaceId={workspaceId}
          onClose={() => setPasteBillingOpen(false)}
        />
      )}
      {showBulkRemoveModal && workspaceId && (
        <BulkRemoveModal
          workspaceId={workspaceId}
          initialAction={bulkInitial?.action}
          initialEmails={bulkInitial?.emails}
          onClose={() => {
            setShowBulkRemoveModal(false);
            setBulkInitial(null);
          }}
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
  const isCanva = usePlatform() === "canva";
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
          {t(isCanva ? "canva.connectionUser" : "connection.user")}: {userLabel}
        </span>
      )}
    </div>
  );
}

