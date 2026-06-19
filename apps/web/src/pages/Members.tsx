import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { useAuth } from "../hooks/useAuth";
import { useFormatDate, useFormatDateTime, useT } from "../i18n";
import type { Member, QueueItem, WorkspaceMemberStats } from "../types";
import { useRemoveMembers } from "../hooks/useRemoveMembers";
import { useMemberMutations } from "../hooks/useMemberMutations";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";
import { WorkspaceTaskRail } from "../components/WorkspaceTaskRail";
import { confirm } from "../components/Toast";
import { Chip } from "./Queue";

// Tab lọc theo trạng thái tham gia workspace (giống ChatGPT):
//   active  → Đang hoạt động (đã tham gia)
//   pending → Chờ tham gia (đã mời, chưa accept)
// Không có tab "tất cả"; mặc định mở tab active.
type StatusFilter = "active" | "pending";

// Loại suất cấp phép ChatGPT — đổi qua menu "..." trên row /admin/members.
type LicenseType = "ChatGPT" | "Codex";
const LICENSE_TYPES: LicenseType[] = ["ChatGPT", "Codex"];

// "Ngày thêm" = thời điểm WEB APP ghi nhận member, KHÔNG dùng joined_at scrape
// từ ChatGPT. Dùng last_invited_at ?? created_at:
//   - created_at BẤT BIẾN từ lần web ghi nhận ĐẦU (invite đầu / lần SYNC đầu).
//   - last_invited_at = lần CUỐI invite/re-invite qua dashboard.
// Member RE-INVITE (invite fail rồi mời lại, hoặc removed→mời lại) giữ created_at
// cũ → nếu hiện created_at thì "Ngày thêm" LỆCH với thời điểm task INVITE trong
// Queue (xem v0.x fix). last_invited_at ?? created_at khớp lại; member chỉ từ
// SYNC (last_invited_at NULL) vẫn hiện created_at như cũ.
const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-success",
  pending: "badge badge-warning",
  removed: "badge badge-danger",
};

export default function Members() {
  const t = useT();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { hasPermission, user } = useAuth();
  const qc = useQueryClient();

  // Invite form đã được lift sang InviteMemberModal (WorkspaceLayout header).
  // Members.tsx chỉ còn hiển thị danh sách + filter + progress.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  // Xoá hàng loạt qua checkbox chọn nhiều dòng. Modal dán email nằm ở
  // WorkspaceLayout header (cạnh nút Mời) — đồng bộ với flow mời thành viên.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () =>
      api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    enabled: !!workspaceId,
  });

  // Thống kê workspace: tổng member toàn workspace + seat. Để sub-admin (chỉ
  // thấy member mình mời trong bảng) vẫn biết TỔNG số người + còn bao seat trống.
  const { data: stats } = useQuery({
    queryKey: ["member-stats", workspaceId],
    queryFn: () =>
      api<WorkspaceMemberStats>(
        `/api/v1/workspaces/${workspaceId}/members/stats`,
      ),
    enabled: !!workspaceId && hasPermission("MEMBER_VIEW"),
  });

  const { data: recentTasks = [] } = useQuery({
    queryKey: ["recent-tasks", workspaceId],
    queryFn: () =>
      api<QueueItem[]>(`/api/v1/queue?workspace_id=${workspaceId}&limit=50`),
    enabled: !!workspaceId,
    // Poll 2s khi có task chạy; lúc idle nhịp tim 10s (KHÔNG dừng hẳn) để panel
    // hàng đợi hiện task do người/phiên khác tạo — "người thực hiện" mở dashboard
    // theo dõi vẫn thấy task Xoá/Đồng bộ admin khác vừa tạo dù phiên này không tự
    // invalidate. Khớp WorkspaceLayout (cùng queryKey). Xem lib/queuePolling.
    refetchInterval: queuePollInterval(2000, 10000),
  });

  // Auto-reload members list khi extension hoàn thành task (COMPLETED/FAILED)
  // mà thay đổi member state: INVITE_MEMBER, REMOVE_MEMBER, CHANGE_ROLE,
  // REVOKE_INVITES, SYNC_DATA. recent-tasks poll mỗi 2s → khi phát hiện task
  // mới chuyển sang terminal state → invalidate members query → list refresh
  // mà không cần F5.
  //
  // Track bằng ref: set các (id, status) đã xử lý — chỉ invalidate cho task
  // mới chuyển sang terminal (tránh invalidate liên tục khi task đã terminal).
  const seenTerminalRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const memberMutatingTypes = new Set([
      "INVITE_MEMBER",
      "REMOVE_MEMBER",
      "CHANGE_ROLE",
      "CHANGE_LICENSE_TYPE",
      "REVOKE_INVITES",
      "SYNC_DATA",
      // SYNC_MEMBER (đồng bộ 1 tài khoản lẻ): khi extension hoàn tất → member có
      // thể chuyển pending→active → invalidate để list tự cập nhật, KHỎI reload tay.
      "SYNC_MEMBER",
    ]);
    let shouldInvalidate = false;
    for (const task of recentTasks) {
      if (!memberMutatingTypes.has(task.type)) continue;
      if (task.status !== "COMPLETED" && task.status !== "FAILED") continue;
      const key = `${task.id}:${task.status}`;
      if (seenTerminalRef.current.has(key)) continue;
      seenTerminalRef.current.add(key);
      shouldInvalidate = true;
    }
    if (shouldInvalidate) {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["member-stats", workspaceId] });
    }
  }, [recentTasks, qc, workspaceId]);

  // activeSyncTask: theo dõi để (1) phát hiện rogue pending sau sync, (2) invalidate
  // members khi sync xong. Tiến trình/huỷ các task đang chạy (sync/mời/thao tác)
  // đã chuyển hết sang panel cột phải (WorkspaceTaskRail) — Members KHÔNG còn render
  // banner tiến trình ở giữa trang nữa.
  const activeSyncTask = recentTasks.find(
    (t) =>
      t.type === "SYNC_DATA" &&
      (t.status === "PENDING" || t.status === "IN_PROGRESS"),
  );
  // Lấy invite FAILED gần đây (trong recentTasks) để show debug info ngay banner
  // → user thấy được error code/message của task vừa fail mà không cần mở Queue tab.
  const recentFailedInvites = recentTasks
    .filter(
      (t) =>
        t.type === "INVITE_MEMBER" &&
        t.status === "FAILED" &&
        t.completed_at &&
        Date.now() - new Date(t.completed_at).getTime() < 60_000,
    )
    .slice(0, 3);

  const [lastSyncTaskId, setLastSyncTaskId] = useState<string | null>(null);
  const lastSyncTask = lastSyncTaskId
    ? recentTasks.find((t) => t.id === lastSyncTaskId) ?? null
    : null;
  const showSyncCompletion =
    lastSyncTask?.status === "COMPLETED" || lastSyncTask?.status === "FAILED";

  useEffect(() => {
    if (!showSyncCompletion || lastSyncTask?.status !== "COMPLETED") return;
    const timer = setTimeout(() => setLastSyncTaskId(null), 10000);
    return () => clearTimeout(timer);
  }, [showSyncCompletion, lastSyncTask?.status]);

  const prevSyncIdRef = useRef<string | null>(null);
  const lastRogueAskedRef = useRef<string | null>(null);
  useEffect(() => {
    const currentSyncId = activeSyncTask?.id ?? null;
    if (prevSyncIdRef.current && !currentSyncId) {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["recent-tasks", workspaceId] });
    }
    prevSyncIdRef.current = currentSyncId;
  }, [activeSyncTask?.id, qc, workspaceId]);

  // sync mutation đã được lift lên WorkspaceLayout (button nằm cùng hàng tabs).
  // Members.tsx vẫn theo dõi activeSyncTask để show banner progress + cancel.

  // Đổi vai trò / giấy phép / thu hồi lời mời đã tách sang hook riêng kèm docs —
  // xem hooks/useMemberMutations.md TRƯỚC KHI SỬA. Huỷ task (cancelTask) KHÔNG còn
  // dùng ở Members — đã chuyển sang panel cột phải (WorkspaceTaskRail có nút Huỷ
  // riêng theo can_cancel).
  const {
    changeLicenseType,
    bulkChangeLicense,
    revokeInvites,
    syncMember,
    bulkSyncMembers,
  } = useMemberMutations(workspaceId, {
    onBulkChangeLicenseCleared: () => setSelectedIds(new Set()),
  });

  useEffect(() => {
    if (!activeSyncTask || activeSyncTask.status !== "COMPLETED") return;
    const rogue = (activeSyncTask.result?.rogue_pending_emails ?? []) as
      | string[]
      | undefined;
    if (!Array.isArray(rogue) || rogue.length === 0) return;
    if (lastRogueAskedRef.current === activeSyncTask.id) return;
    lastRogueAskedRef.current = activeSyncTask.id;

    (async () => {
      const list = rogue.slice(0, 10).join("\n");
      const more =
        rogue.length > 10
          ? t("member.rogueMore", { n: rogue.length - 10 })
          : "";
      const ok = await confirm(
        t("member.rogueBody", { n: rogue.length, list, more }),
        {
          title: t("member.rogueTitle", { n: rogue.length }),
          okText: t("member.rogueOk", { n: rogue.length }),
          cancelText: t("member.rogueCancel"),
          danger: true,
        },
      );
      if (ok) {
        revokeInvites.mutate(rogue);
      }
    })();
  }, [activeSyncTask?.id, activeSyncTask?.status]);

  // Invite mutation đã chuyển sang InviteMemberModal (modal popup ở
  // WorkspaceLayout header). Members.tsx chỉ giữ remove + changeRole.

  // Remove Member (xoá đơn / hàng loạt / cleanup hết hạn) đã tách sang hook
  // riêng kèm docs — xem hooks/useRemoveMembers.md TRƯỚC KHI SỬA.
  const { remove, bulkRemoveSelected, cleanupExpired } = useRemoveMembers(
    workspaceId,
    { onBulkRemoveCleared: () => setSelectedIds(new Set()) },
  );

  const canRemove = hasPermission("MEMBER_REMOVE");
  // Đổi license type chỉ super-admin (tái dùng quyền như đổi role).
  const canChangeLicense = user?.is_super_admin === true;
  // Có thể thao tác hàng loạt (checkbox + thanh "Cập nhật hàng loạt") khi có ít
  // nhất 1 trong 2 quyền: xoá hoặc đổi giấy phép.
  const canBulk = canRemove || canChangeLicense;

  const total = members.length;
  const activeCount = members.filter((m) => m.status === "active").length;
  const pendingCount = members.filter((m) => m.status === "pending").length;
  const queueCount = recentTasks.length;
  const recentFailed = recentTasks.filter((t) => t.status === "FAILED").length;
  const activeRate = total > 0 ? Math.round((activeCount / total) * 100) : 0;

  // Subscription tracking: phân loại theo subscription_end_at.
  //   - expired: end_at đã qua + status active/pending → cần remove
  //   - expiringSoon: 7 ngày tới hết hạn → admin nên check
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const expiredMembers = members.filter(
    (m) =>
      m.subscription_end_at &&
      (m.status === "active" || m.status === "pending") &&
      new Date(m.subscription_end_at).getTime() <= now,
  );
  const expiringSoonMembers = members.filter(
    (m) =>
      m.subscription_end_at &&
      (m.status === "active" || m.status === "pending") &&
      new Date(m.subscription_end_at).getTime() > now &&
      new Date(m.subscription_end_at).getTime() - now <= SEVEN_DAYS_MS,
  );

  const filteredMembers = useMemo(() => {
    let rows = members.filter((m) => m.status === statusFilter);
    const s = search.trim().toLowerCase();
    if (s) {
      rows = rows.filter(
        (m) =>
          m.email.toLowerCase().includes(s) ||
          (m.name ?? "").toLowerCase().includes(s),
      );
    }
    // Sắp xếp theo "ngày thêm" = last_invited_at ?? created_at (khớp cột hiển
    // thị), mới nhất lên đầu — member vừa re-invite nhảy lên đầu đúng kỳ vọng.
    const addedAt = (m: Member) =>
      new Date(m.last_invited_at ?? m.created_at).getTime();
    return [...rows].sort((a, b) => addedAt(b) - addedAt(a));
  }, [members, search, statusFilter]);

  // Xoá hàng loạt: chỉ chọn được member active/pending (removed thì bỏ qua) khi
  // có quyền MEMBER_REMOVE. Select-all chỉ áp lên các dòng đang hiển thị (đã lọc).
  const selectableMembers = useMemo(
    () =>
      canBulk
        ? filteredMembers.filter(
            (m) => m.status === "active" || m.status === "pending",
          )
        : [],
    [filteredMembers, canBulk],
  );
  const selectedCount = selectableMembers.filter((m) =>
    selectedIds.has(m.id),
  ).length;
  const allSelected =
    selectableMembers.length > 0 && selectedCount === selectableMembers.length;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (selectableMembers.length > 0 && allSelected) {
        // Bỏ chọn các dòng đang hiển thị.
        const next = new Set(prev);
        for (const m of selectableMembers) next.delete(m.id);
        return next;
      }
      const next = new Set(prev);
      for (const m of selectableMembers) next.add(m.id);
      return next;
    });
  }
  // Thanh "Cập nhật hàng loạt": 1 select gom mọi hành động trên các dòng đã chọn.
  // Tuỳ tab đang mở (statusFilter) mà danh sách hành động khác nhau (xem JSX):
  //   tab active  → remove (MEMBER_REMOVE) + license:ChatGPT/Codex (super-admin)
  //   tab pending → sync (đồng bộ kiểm tra đã tham gia) + revoke (MEMBER_REMOVE)
  // Mỗi action xong tự clear selection (onSuccess per-call) để tránh thao tác lại
  // trên danh sách đã đổi.
  async function handleBulkAction(value: string) {
    if (!value) return;
    const selected = selectableMembers.filter((m) => selectedIds.has(m.id));
    if (selected.length === 0) return;
    const ids = selected.map((m) => m.id);
    const emails = selected.map((m) => m.email);
    const clearSelection = { onSuccess: () => setSelectedIds(new Set()) };

    if (value === "sync") {
      const ok = await confirm(t("bulkSync.confirmBody", { n: emails.length }), {
        title: t("bulkSync.confirmTitle", { n: emails.length }),
        okText: t("bulkSync.confirmOk", { n: emails.length }),
        cancelText: t("common.cancel"),
      });
      if (ok) bulkSyncMembers.mutate(emails, clearSelection);
      return;
    }

    if (value === "revoke") {
      // Thu hồi lời mời pending = nhẹ hơn xoá member active. Tất cả các hành động
      // xoá/thu hồi giờ chỉ cần bấm xác nhận (danger) — không bắt gõ "delete" nữa.
      const ok = await confirm(t("bulkRevoke.confirmBody", { n: emails.length }), {
        title: t("bulkRevoke.confirmTitle", { n: emails.length }),
        okText: t("bulkRevoke.confirmOk", { n: emails.length }),
        cancelText: t("common.cancel"),
        danger: true,
      });
      if (ok) revokeInvites.mutate(emails, clearSelection);
      return;
    }

    if (value === "remove") {
      const ok = await confirm(t("bulkRemove.confirmSelectedBody", { n: ids.length }), {
        title: t("bulkRemove.confirmSelectedTitle", { n: ids.length }),
        okText: t("bulkRemove.confirmSelectedOk", { n: ids.length }),
        cancelText: t("common.cancel"),
        danger: true,
      });
      if (ok) bulkRemoveSelected.mutate(ids);
      return;
    }

    if (value.startsWith("license:")) {
      const licenseType = value.slice("license:".length) as LicenseType;
      const ok = await confirm(
        t("bulkLicense.confirmBody", { n: ids.length, license: licenseType }),
        {
          title: t("bulkLicense.confirmTitle", { n: ids.length }),
          okText: t("bulkLicense.confirmOk", { license: licenseType }),
          cancelText: t("common.cancel"),
        },
      );
      if (ok) bulkChangeLicense.mutate({ memberIds: ids, licenseType });
    }
  }

  const colCount = canBulk ? 8 : 7;

  return (
    <div>
      {/* Banner TIẾN TRÌNH task đang chạy (sync / mời / thao tác) đã GỠ khỏi giữa
          trang — mọi task đang chạy giờ hiện ở panel "Hàng đợi tác vụ" cột phải
          (WorkspaceTaskRail), kèm timeline thời lượng từng giai đoạn + nút Huỷ.
          Ở đây chỉ giữ banner KẾT QUẢ (completion) + LỖI + cảnh báo hết hạn. */}
      {!activeSyncTask && showSyncCompletion && lastSyncTask && (
        <div style={{ marginBottom: 16 }}>
          <TaskCompletionBanner
            task={lastSyncTask}
            onDismiss={() => setLastSyncTaskId(null)}
          />
        </div>
      )}
      {recentFailedInvites.length > 0 && (
        <div
          className="notice"
          style={{
            marginBottom: 16,
            background: "var(--bg-danger, #fee)",
            borderColor: "var(--border-danger, #fcc)",
          }}
        >
          <div className="notice-icon" style={{ color: "var(--ink-danger, #c00)" }}>
            ⚠
          </div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">{t("member.inviteFailedRecent")}</div>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {recentFailedInvites.map((task) => (
                <InviteFailedRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        </div>
      )}
      {expiredMembers.length > 0 && (
        <div
          className="notice"
          style={{
            marginBottom: 16,
            background: "var(--bg-danger, #fee)",
            borderColor: "var(--border-danger, #fcc)",
          }}
        >
          <div className="notice-icon" style={{ color: "var(--ink-danger, #c00)" }}>⏰</div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("member.expiredBannerTitle", { n: expiredMembers.length })}
            </div>
            <div className="notice-body" style={{ marginTop: 4 }}>
              {t("member.expiredBannerBody")}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>
              {expiredMembers.slice(0, 5).map((m) => m.email).join(", ")}
              {expiredMembers.length > 5 ? ` +${expiredMembers.length - 5}` : ""}
            </div>
          </div>
          <button
            onClick={() => cleanupExpired.mutate()}
            disabled={cleanupExpired.isPending}
            className="btn btn-sm"
            style={{
              background: "var(--ink-danger, #c00)",
              color: "white",
              border: "none",
            }}
          >
            {cleanupExpired.isPending
              ? t("member.cleanupExpiredBusy")
              : t("member.cleanupExpiredBtn", { n: expiredMembers.length })}
          </button>
        </div>
      )}
      {expiringSoonMembers.length > 0 && expiredMembers.length === 0 && (
        <div
          className="notice warn"
          style={{ marginBottom: 16 }}
        >
          <div className="notice-icon">⚠</div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("member.expiringSoonBannerTitle", { n: expiringSoonMembers.length })}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>
              {expiringSoonMembers
                .slice(0, 5)
                .map((m) =>
                  `${m.email} (${m.subscription_end_at ? formatDate(m.subscription_end_at) : "?"})`,
                )
                .join(", ")}
              {expiringSoonMembers.length > 5 ? ` +${expiringSoonMembers.length - 5}` : ""}
            </div>
          </div>
        </div>
      )}

      <div className="metrics" style={{ marginBottom: 24 }}>
        <Metric label={t("metrics.totalMembers")} value={total} />
        <Metric
          label={t("metrics.activeMembers")}
          value={activeCount}
          delta={t("metrics.activeRate", { n: activeRate })}
        />
        <Metric
          label={t("metrics.pendingInvites")}
          value={pendingCount}
          delta={pendingCount > 0 ? t("metrics.pendingHint") : ""}
        />
        <Metric
          label={t("metrics.queueTasks")}
          value={queueCount}
          delta={
            recentFailed > 0
              ? t("metrics.failureRate", {
                  n: Math.round((recentFailed / Math.max(queueCount, 1)) * 100),
                })
              : ""
          }
          deltaKind={recentFailed > 0 ? "down" : undefined}
        />
      </div>

      {/* Panel "Hàng đợi tác vụ" — nằm giữa phần tổng quan (metrics) và bảng danh
          sách thành viên. Desktop-only (tự ẩn <1024px), cần quyền QUEUE_VIEW. */}
      {workspaceId && hasPermission("QUEUE_VIEW") && (
        <WorkspaceTaskRail workspaceId={workspaceId} tasks={recentTasks} />
      )}

      <div className="table-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("member.listTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("members.countLabel", { n: total })}
              {stats && (
                <>
                  {" · "}
                  {t("members.totalInWorkspace", { n: stats.total })}
                  {stats.seat_total != null && (
                    <>
                      {" · "}
                      {t("members.seatUsage", {
                        used: stats.seat_used ?? stats.total,
                        total: stats.seat_total,
                      })}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("members.searchPlaceholder")}
            />
            {canBulk && selectedCount > 0 && (
              <select
                className="form-input"
                value=""
                disabled={
                  bulkRemoveSelected.isPending ||
                  bulkChangeLicense.isPending ||
                  bulkSyncMembers.isPending ||
                  revokeInvites.isPending
                }
                onChange={(e) => {
                  void handleBulkAction(e.target.value);
                  e.target.value = "";
                }}
                style={{ width: "auto" }}
                title={t("bulkAction.placeholder", { n: selectedCount })}
              >
                <option value="">
                  {bulkRemoveSelected.isPending ||
                  bulkChangeLicense.isPending ||
                  bulkSyncMembers.isPending ||
                  revokeInvites.isPending
                    ? t("bulkRemove.submitBusy")
                    : t("bulkAction.placeholder", { n: selectedCount })}
                </option>
                {/* Hành động bám theo tab: pending → đồng bộ + thu hồi (giống nút
                    từng dòng); active → đổi giấy phép + xoá. */}
                {statusFilter === "pending" ? (
                  <>
                    <option value="sync">{t("bulkAction.sync")}</option>
                    {canRemove && (
                      <option value="revoke">{t("bulkAction.revoke")}</option>
                    )}
                  </>
                ) : (
                  <>
                    {canChangeLicense && (
                      <option value="license:ChatGPT">
                        {t("bulkAction.licenseChatGPT")}
                      </option>
                    )}
                    {canChangeLicense && (
                      <option value="license:Codex">
                        {t("bulkAction.licenseCodex")}
                      </option>
                    )}
                    {canRemove && (
                      <option value="remove">{t("bulkAction.remove")}</option>
                    )}
                  </>
                )}
              </select>
            )}
            {/* Action buttons (Sync ChatGPT + Mời thành viên) đã được lift
                lên WorkspaceLayout header để nằm cùng hàng với tabs. */}
          </div>
        </div>

        <div
          className="flex flex-wrap gap-2"
          style={{ padding: "0 16px 12px" }}
        >
          <Chip
            active={statusFilter === "active"}
            onClick={() => setStatusFilter("active")}
            label={t("member.statusActive")}
            count={activeCount}
          />
          <Chip
            active={statusFilter === "pending"}
            onClick={() => setStatusFilter("pending")}
            label={t("member.statusPending")}
            count={pendingCount}
          />
        </div>

        <div style={{ overflowX: "auto" }}>
          {/* data-table-compact: cỡ chữ nhỏ + padding hẹp + nowrap → mọi ô nằm
              trên 1 hàng ngang, không co/xuống dòng (tràn ngang thì scroll). */}
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                {canBulk && (
                  <th style={{ width: 40, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={selectableMembers.length === 0}
                      onChange={toggleSelectAll}
                      title={t("bulkRemove.selectAll")}
                    />
                  </th>
                )}
                <th>{t("member.colEmail")}</th>
                <th style={{ textAlign: "center" }}>{t("member.colRole")}</th>
                <th style={{ textAlign: "center" }}>{t("member.colLicenseType")}</th>
                <th style={{ textAlign: "center" }}>{t("member.colStatus")}</th>
                <th>{t("member.colSubscription")}</th>
                <th>{t("member.colJoinedAt")}</th>
                <th style={{ textAlign: "right" }}>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={colCount} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {!isLoading && filteredMembers.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="cell-muted" style={{ textAlign: "center", padding: 32 }}>
                    {user?.is_super_admin
                      ? t("member.emptySuper")
                      : t("member.emptySub")}
                  </td>
                </tr>
              )}
              {filteredMembers.map((m) => {
                const selectable =
                  canBulk && (m.status === "active" || m.status === "pending");
                return (
                <tr key={m.id}>
                  {canBulk && (
                    <td style={{ textAlign: "center" }}>
                      {selectable && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(m.id)}
                          onChange={() => toggleSelect(m.id)}
                        />
                      )}
                    </td>
                  )}
                  <td className="cell-email">{m.email}</td>
                  <td style={{ textAlign: "center" }}>
                    {m.chatgpt_role ? (
                      <span className="role-tag">
                        {t(
                          `member.role${m.chatgpt_role
                            .charAt(0)
                            .toUpperCase()}${m.chatgpt_role.slice(1)}`,
                        )}
                      </span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {canChangeLicense && m.status === "active" ? (
                      <select
                        value={m.license_type ?? ""}
                        onChange={(e) =>
                          changeLicenseType.mutate({
                            memberId: m.id,
                            licenseType: e.target.value as LicenseType,
                          })
                        }
                        className="form-input"
                        style={{ padding: "4px 8px", fontSize: 12, width: "auto" }}
                      >
                        {!m.license_type && (
                          <option value="" disabled>
                            —
                          </option>
                        )}
                        {LICENSE_TYPES.map((lt) => (
                          <option key={lt} value={lt}>
                            {lt}
                          </option>
                        ))}
                      </select>
                    ) : m.license_type ? (
                      <span className="role-tag">{m.license_type}</span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={STATUS_BADGE[m.status] ?? "badge badge-neutral"}>
                      {t(
                        `member.status${m.status
                          .charAt(0)
                          .toUpperCase()}${m.status.slice(1)}`,
                      )}
                    </span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    <SubscriptionCell member={m} t={t} formatDate={formatDate} />
                  </td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>
                    {formatDateTime(m.last_invited_at ?? m.created_at)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <div
                      className="flex items-center justify-end"
                      style={{ gap: 6 }}
                    >
                      {/* Đồng bộ 1 tài khoản lẻ — CHỈ ở member 'pending': tìm email
                          ở tab Lời mời, không thấy thì fallback tab Người dùng;
                          thấy → set 'active'; không thấy → báo không tồn tại. */}
                      {m.status === "pending" && (
                        <button
                          onClick={() => syncMember.mutate(m.email)}
                          disabled={syncMember.isPending}
                          className="row-action"
                          title={t("member.syncAction")}
                        >
                          {t("member.syncAction")}
                        </button>
                      )}
                      {canRemove && m.status === "pending" && (
                        <button
                          onClick={async () => {
                            const ok = await confirm(
                              t("member.confirmRevoke", { email: m.email }),
                              {
                                title: t("member.confirmRevokeTitle"),
                                okText: t("member.revokeAction"),
                                cancelText: t("common.cancel"),
                                danger: true,
                              },
                            );
                            if (ok) revokeInvites.mutate([m.email]);
                          }}
                          className="row-action warn"
                        >
                          {t("member.revokeAction")}
                        </button>
                      )}
                      {canRemove && m.status === "active" && (
                        <button
                          onClick={async () => {
                            const ok = await confirm(
                              t("member.confirmRemove", { email: m.email }),
                              {
                                title: t("member.confirmRemoveTitle"),
                                okText: t("member.removeAction"),
                                cancelText: t("common.cancel"),
                                danger: true,
                              },
                            );
                            if (ok) remove.mutate(m.id);
                          }}
                          className="row-action"
                        >
                          {t("member.removeAction")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  delta,
  deltaKind,
}: {
  label: string;
  value: number | string;
  delta?: string;
  deltaKind?: "up" | "down";
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {delta && (
        <div
          className={
            "metric-delta" +
            (deltaKind === "up"
              ? " up"
              : deltaKind === "down"
              ? " down"
              : "")
          }
        >
          {delta}
        </div>
      )}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input
        className="search-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* SyncProgressBanner + InviteProgressRow đã GỠ (2026-06-17): mọi task đang chạy
   (sync / mời / thao tác) giờ hiển thị tiến trình + timeline + nút Huỷ ở panel cột
   phải WorkspaceTaskRail, không còn banner tiến trình giữa trang. */

/** Dòng error cho invite task vừa FAILED — show error_code + message. */
function InviteFailedRow({ task }: { task: QueueItem }) {
  const t = useT();
  const payload = task.payload as Record<string, unknown>;
  const emails: string[] = Array.isArray(payload.emails)
    ? (payload.emails as string[])
    : typeof payload.email === "string"
      ? [payload.email]
      : [];
  const emailsLabel =
    emails.length === 0
      ? "—"
      : emails.length === 1
        ? emails[0]
        : `${emails[0]} +${emails.length - 1}`;

  return (
    <div
      style={{
        fontSize: 12,
        background: "rgba(255,255,255,0.7)",
        border: "1px solid #fcc",
        borderRadius: 6,
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontWeight: 600 }}>{emailsLabel}</span>
        {task.error_code && (
          <span
            style={{
              fontSize: 10,
              background: "#c00",
              color: "white",
              padding: "1px 6px",
              borderRadius: 3,
              fontFamily: "var(--font-mono)",
            }}
          >
            {task.error_code}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {task.completed_at
            ? new Date(task.completed_at).toLocaleTimeString("vi-VN")
            : ""}
        </span>
      </div>
      {task.error_message && (
        <div
          style={{
            color: "var(--ink-2)",
            fontSize: 11.5,
            wordBreak: "break-word",
          }}
          title={t("invite.errorFullTooltip")}
        >
          {task.error_message}
        </div>
      )}
    </div>
  );
}

/**
 * Cell hiển thị subscription status cho 1 member row.
 *
 * Logic:
 *   - subscription_end_at = null: hiển thị "—" (không giới hạn).
 *   - end_at < now: badge ĐỎ "Hết hạn DD/MM" + days expired.
 *   - end_at < now + 7 days: badge VÀNG "Còn N ngày" — admin chú ý.
 *   - else: badge XÁM nhạt "DD/MM (N ngày)".
 *
 * Tooltip kèm `subscription_months` để admin biết originally bao nhiêu tháng.
 */
function SubscriptionCell({
  member,
  t,
  formatDate,
}: {
  member: Member;
  t: ReturnType<typeof useT>;
  formatDate: (value: string | Date, options?: Intl.DateTimeFormatOptions) => string;
}) {
  if (!member.subscription_end_at) {
    return <span className="cell-muted">—</span>;
  }
  const endMs = new Date(member.subscription_end_at).getTime();
  const nowMs = Date.now();
  const diffDays = Math.round((endMs - nowMs) / (24 * 60 * 60 * 1000));
  const endStr = formatDate(member.subscription_end_at, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const monthsLabel = member.subscription_months
    ? t("member.subscriptionMonths", { n: member.subscription_months })
    : "";
  const tooltip = monthsLabel ? `${endStr} · ${monthsLabel}` : endStr;

  if (diffDays <= 0) {
    return (
      <span
        className="badge badge-danger"
        title={tooltip}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        ⏰ {t("member.subExpired", { n: -diffDays })}
      </span>
    );
  }
  if (diffDays <= 7) {
    return (
      <span
        className="badge badge-warning"
        title={tooltip}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        ⚠ {t("member.subDaysLeft", { n: diffDays })}
      </span>
    );
  }
  return (
    <span
      style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}
      title={tooltip}
    >
      {endStr}
      <span style={{ color: "var(--ink-3)", marginLeft: 4 }}>
        ({t("member.subDaysLeftShort", { n: diffDays })})
      </span>
    </span>
  );
}
