import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { LICENSE_FEATURE_ENABLED } from "../lib/featureFlags";
import { useAuth } from "../hooks/useAuth";
import { useFormatDate, useFormatDateTime, useT } from "../i18n";
import type { Member, QueueItem, WorkspaceMemberStats } from "../types";
import { useRemoveMembers } from "../hooks/useRemoveMembers";
import { useMemberMutations } from "../hooks/useMemberMutations";
import { useReinvite } from "../hooks/useReinvite";
import OrderQrModal from "../components/OrderQrModal";
import type { OrderQr } from "../lib/wallet";
import { TaskCompletionBanner } from "../components/TaskCompletionBanner";
import { WorkspaceTaskRail } from "../components/WorkspaceTaskRail";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { ChangeEmailModal } from "../components/ChangeEmailModal";
import { ChangeSubscriptionModal } from "../components/ChangeSubscriptionModal";
import { MemberDetailModal } from "../components/MemberDetailModal";
import { confirm, toast } from "../components/Toast";
import { downloadXlsx } from "../lib/xlsx";
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

// Cột "Ngày gia hạn" / "Ngày hết hạn" hiển thị chi tiết tới giây (khớp trang
// "Email đã add" — xem AddedEmails.tsx).
const PRECISE_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

/** "DD/MM/YYYY - HH:MM:SS" — dấu "-" ngăn giữa ngày và giờ. Ngày dạng số
 *  (vi-VN/zh-CN) không chứa space nên thay space đầu tiên là an toàn. */
function fmtRenewExpiry(
  formatDateTime: ReturnType<typeof useFormatDateTime>,
  value: string | Date,
): string {
  return formatDateTime(value, undefined, PRECISE_TIME).replace(" ", " - ");
}

/** Tài khoản phụ (sub-admin) — đổ vào dropdown lọc theo chủ sở hữu (super-admin). */
type SubAccount = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
};

// Giá trị sentinel cho mục lọc "Chưa có chủ" (member từ SYNC, invited_by null).
const NO_OWNER = "__none__";

export default function Members() {
  const t = useT();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { hasPermission, user } = useAuth();
  const isSuper = user?.is_super_admin === true;
  const qc = useQueryClient();

  // Invite form đã được lift sang InviteMemberModal (WorkspaceLayout header).
  // Members.tsx chỉ còn hiển thị danh sách + filter + progress.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  // Lọc theo chủ sở hữu (super-admin): "" = tất cả, NO_OWNER = chưa có chủ,
  // còn lại = id sub-admin/super đã invite. KHÔNG hiển thị cột chủ sở hữu —
  // chỉ dùng để lọc danh sách (yêu cầu: không bày chủ sở hữu trên mỗi mail).
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  // Xoá hàng loạt qua checkbox chọn nhiều dòng. Modal dán email nằm ở
  // WorkspaceLayout header (cạnh nút Mời) — đồng bộ với flow mời thành viên.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Member đang mở modal "Đổi email" (null = đóng). Đổi email = xoá cũ + mời mới,
  // giữ nguyên hạn dùng — xem components/ChangeEmailModal + hooks/useChangeEmail.md.
  const [changeEmailMember, setChangeEmailMember] = useState<Member | null>(null);
  // Member đang mở modal "Đổi hạn dùng" (null = đóng). Đổi hạn CÓ DUYỆT: super-admin
  // áp ngay, sub-admin tạo yêu cầu — xem hooks/useSubscriptionApprovals.md.
  const [changeSubMember, setChangeSubMember] = useState<Member | null>(null);
  // Member đang mở modal "Chi tiết" (null = đóng). Click vào email ở bảng → mở
  // panel thông tin + lịch sử hoạt động — xem components/MemberDetailModal.
  const [detailMember, setDetailMember] = useState<Member | null>(null);
  // Banner "sắp hết hạn": click để bung DANH SÁCH ĐẦY ĐỦ (mặc định chỉ hiện 5 +N).

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () =>
      api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    enabled: !!workspaceId,
    // Poll nhẹ: scheduler nền tự gỡ hết hạn + sync promote pending→active có thể
    // đổi danh sách mà không có thao tác của user → tự nạp lại (dừng khi tab ẩn).
    refetchInterval: 20_000,
  });

  // Super-admin: danh sách tài khoản phụ để lọc member theo chủ sở hữu (id →
  // tên hiển thị trong dropdown). Sub-admin chỉ thấy member của mình → không cần.
  const { data: subAccounts = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<SubAccount[]>("/api/v1/users"),
    enabled: isSuper,
    select: (rows) => rows.filter((u) => !u.is_super_admin),
  });

  // Chỉ liệt kê chủ sở hữu THỰC SỰ có member trong workspace này (id → tên),
  // tránh dropdown đầy sub-admin không liên quan. hasNoOwner = có member từ
  // SYNC (invited_by null) → thêm mục "Chưa có chủ".
  const ownerOptions = useMemo(() => {
    if (!isSuper) return { opts: [] as { value: string; label: string }[], hasNoOwner: false };
    const nameById = new Map<string, string>(
      subAccounts.map((u) => [u.id, u.username]),
    );
    if (user) nameById.set(user.id, t("member.ownerSelf"));
    let hasNoOwner = false;
    const present = new Set<string>();
    for (const m of members) {
      if (m.invited_by_user_id) present.add(m.invited_by_user_id);
      else hasNoOwner = true;
    }
    const opts = Array.from(present, (id) => ({
      value: id,
      label: nameById.get(id) ?? id,
    })).sort((a, b) => a.label.localeCompare(b.label));
    return { opts, hasNoOwner };
  }, [isSuper, subAccounts, members, user, t]);

  // Thống kê workspace: tổng member toàn workspace + seat. Để sub-admin (chỉ
  // thấy member mình mời trong bảng) vẫn biết TỔNG số người + còn bao seat trống.
  const { data: stats } = useQuery({
    queryKey: ["member-stats", workspaceId],
    queryFn: () =>
      api<WorkspaceMemberStats>(
        `/api/v1/workspaces/${workspaceId}/members/stats`,
      ),
    enabled: !!workspaceId && hasPermission("MEMBER_VIEW"),
    refetchInterval: 20_000,
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
  // Theo dõi status LẦN TRƯỚC của từng task (theo id) để chỉ phản ứng khi task
  // VỪA chuyển từ đang-chạy (PENDING/IN_PROGRESS) → terminal (COMPLETED/FAILED)
  // NGAY TRƯỚC MẮT user. Lần đầu thấy 1 task (kể cả task lịch sử đã COMPLETED khi
  // mới mở trang) chỉ ghi nhận status, KHÔNG toast → tránh spam toast cho mọi task
  // cũ / lịch sử. Nhờ vậy chỉ "đúng task user vừa trigger" (đi qua PENDING ở tab
  // này rồi hoàn tất) mới hiện thông báo.
  const lastStatusRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const memberMutatingTypes = new Set([
      "INVITE_MEMBER",
      "REMOVE_MEMBER",
      "CHANGE_ROLE",
      "CHANGE_LICENSE_TYPE",
      "SET_USAGE_LIMIT",
      "REVOKE_INVITES",
      "SYNC_DATA",
      // SYNC_MEMBER (đồng bộ 1 tài khoản lẻ): khi extension hoàn tất → member có
      // thể chuyển pending→active → invalidate để list tự cập nhật, KHỎI reload tay.
      "SYNC_MEMBER",
      // SYNC_MEMBERS_BATCH (đồng bộ hàng loạt): cùng lý do — nhiều member có thể
      // chuyển pending→active sau 1 mẻ → invalidate để list refresh.
      "SYNC_MEMBERS_BATCH",
    ]);
    const justFinished: typeof recentTasks = [];
    for (const task of recentTasks) {
      if (!memberMutatingTypes.has(task.type)) continue;
      const prev = lastStatusRef.current.get(task.id);
      lastStatusRef.current.set(task.id, task.status);
      const isTerminal = task.status === "COMPLETED" || task.status === "FAILED";
      // Chỉ tính là "vừa hoàn tất" khi LẦN TRƯỚC còn đang chạy. prev===undefined
      // = lần đầu thấy (task lịch sử) → bỏ qua, không toast/không invalidate.
      const wasActive = prev === "PENDING" || prev === "IN_PROGRESS";
      if (isTerminal && wasActive) justFinished.push(task);
    }
    if (justFinished.length > 0) {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] });
      qc.invalidateQueries({ queryKey: ["member-stats", workspaceId] });
      for (const task of justFinished) {
        const typeLabel = t(`taskType.${task.type}`);
        if (task.status === "COMPLETED") {
          toast.success(t("task.completedToast", { type: typeLabel }));
        } else {
          toast.error(t("task.failedToast", { type: typeLabel }));
        }
      }
    }
  }, [recentTasks, qc, workspaceId, t]);

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
    bulkSetOwner,
    revokeInvites,
    syncMember,
    bulkSyncMembers,
  } = useMemberMutations(workspaceId, {
    onBulkChangeLicenseCleared: () => setSelectedIds(new Set()),
    onBulkSetOwnerCleared: () => setSelectedIds(new Set()),
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

  // Mời lại (re-invite) member CHỜ THAM GIA khi lời mời lỗi. Hết hạn + ví thiếu →
  // 402 QR (mở OrderQrModal); còn hạn → miễn phí.
  const [reinviteQr, setReinviteQr] = useState<OrderQr | null>(null);
  const reinvite = useReinvite(workspaceId, {
    onPaymentRequired: (order) => setReinviteQr(order),
  });

  const canRemove = hasPermission("MEMBER_REMOVE");
  // Mời / mời lại cần quyền mời.
  const canInvite = hasPermission("MEMBER_INVITE");
  // Đổi email sinh ra cả thao tác xoá lẫn mời → cần cả 2 quyền (khớp backend).
  const canChangeEmail = canRemove && hasPermission("MEMBER_INVITE");
  // Đổi hạn dùng cần quyền mời (sub-admin gửi yêu cầu chờ duyệt, super-admin áp ngay).
  const canChangeSubscription = hasPermission("MEMBER_INVITE");
  // Đổi license type chỉ super-admin (tái dùng quyền như đổi role). Đã ẩn toàn bộ
  // qua cờ LICENSE_FEATURE_ENABLED (xem lib/featureFlags.ts) — ChatGPT mặc định
  // "ChatGPT" nên cơ chế đổi giấy phép không còn khớp; cờ = false ⇒ canChangeLicense
  // luôn false ⇒ mọi UI đổi giấy phép (dropdown đơn + option hàng loạt) tự ẩn.
  const canChangeLicense =
    LICENSE_FEATURE_ENABLED && user?.is_super_admin === true;
  // Đặt giới hạn tín dụng: quyền MEMBER_SET_USAGE_LIMIT (super-admin luôn có).
  const canSetUsageLimit = hasPermission("MEMBER_SET_USAGE_LIMIT");
  // Có thể thao tác hàng loạt (checkbox + thanh "Cập nhật hàng loạt") khi có ít
  // nhất 1 trong các quyền: xoá / đổi giấy phép / đặt giới hạn tín dụng.
  const canBulk = canRemove || canChangeLicense || canSetUsageLimit;
  // Mở modal Cập nhật hàng loạt (đặt giới hạn) với email điền sẵn — do
  // WorkspaceLayout cung cấp qua Outlet context.
  const { openBulkUpdate } = useOutletContext<{
    openBulkUpdate: (action?: string, emails?: string[]) => void;
  }>();

  // Số liệu tổng quan cho KHỐI 4 THẺ TO ở đầu trang (theo mockup).
  const total = members.length;
  const activeCount = members.filter((m) => m.status === "active").length;
  const pendingCount = members.filter((m) => m.status === "pending").length;
  const activeRate = total > 0 ? Math.round((activeCount / total) * 100) : 0;

  // Số đếm cho 2 TAB "Đang hoạt động / Chờ tham gia" trong danh sách: TÔN TRỌNG
  // bộ lọc chủ sở hữu (super-admin) để khớp danh sách đang xem — chọn 1 chủ thì
  // badge tab hiện đúng số của chủ đó. KHÔNG phụ thuộc ô tìm kiếm (search chỉ thu
  // hẹp trong tab). Các thẻ tổng quan ở đầu trang vẫn là số TOÀN workspace.
  const ownerScopedMembers = useMemo(() => {
    if (!isSuper || !ownerFilter) return members;
    return ownerFilter === NO_OWNER
      ? members.filter((m) => !m.invited_by_user_id)
      : members.filter((m) => m.invited_by_user_id === ownerFilter);
  }, [members, isSuper, ownerFilter]);
  const tabActiveCount = ownerScopedMembers.filter(
    (m) => m.status === "active",
  ).length;
  const tabPendingCount = ownerScopedMembers.filter(
    (m) => m.status === "pending",
  ).length;

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
  // "Đến hạn gia hạn" (thẻ tổng quan #4): gộp đã hết hạn + sắp hết hạn ≤7 ngày
  // = tập cần gia hạn (khớp badge tab "Gia hạn"). Chỉ hiện SỐ LƯỢNG, không liệt kê
  // email.
  const dueMembers = [...expiredMembers, ...expiringSoonMembers];

  const filteredMembers = useMemo(() => {
    let rows = members.filter((m) => m.status === statusFilter);
    // Lọc theo chủ sở hữu (client-side; super-admin đã nhận toàn bộ member).
    if (isSuper && ownerFilter) {
      rows =
        ownerFilter === NO_OWNER
          ? rows.filter((m) => !m.invited_by_user_id)
          : rows.filter((m) => m.invited_by_user_id === ownerFilter);
    }
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
  }, [members, search, statusFilter, isSuper, ownerFilter]);

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

    if (value === "set-usage-limit") {
      // Option LUÔN hiển thị; chưa được cấp quyền thì báo liên hệ admin (không chạy).
      if (!canSetUsageLimit) {
        toast.error(t("usageLimit.needPermission"));
        return;
      }
      // Mở modal Cập nhật hàng loạt ở chế độ đặt giới hạn, điền sẵn email đã chọn.
      // Modal lo nhập số + ngân sách + (sub-admin) gửi chờ duyệt.
      openBulkUpdate("set-usage-limit", emails);
      setSelectedIds(new Set());
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
      return;
    }

    if (value.startsWith("owner:")) {
      // "Chuyển chủ nhanh" (super-admin): value = "owner:<userId>" | "owner:self"
      // | "owner:" (thu hồi → chưa có chủ). Đổi thuần dữ liệu, không có task.
      const raw = value.slice("owner:".length);
      const targetUserId = raw === "" ? null : raw === "self" ? user!.id : raw;
      const targetName =
        raw === ""
          ? t("bulkTransferOwner.noOwner")
          : raw === "self"
            ? t("member.ownerSelf")
            : subAccounts.find((u) => u.id === raw)?.username ?? raw;
      const ok = await confirm(
        t("bulkTransferOwner.confirmBody", { n: ids.length, name: targetName }),
        {
          title: t("bulkTransferOwner.confirmTitle", { n: ids.length }),
          okText: t("bulkTransferOwner.confirmOk", { name: targetName }),
          cancelText: t("common.cancel"),
          danger: raw === "",
        },
      );
      if (ok) bulkSetOwner.mutate({ memberIds: ids, targetUserId, targetName });
    }
  }

  // Xuất các dòng ĐÃ CHỌN ra file .xlsx thật (không phải CSV). Lý do bỏ CSV: mở
  // bằng Excel bị lệ thuộc "dấu phân tách" theo locale máy (VN/macOS thường dùng
  // dấu ";") → dữ liệu dồn hết vào cột A + luôn có cảnh báo "Possible Data Loss".
  // .xlsx tách cột chuẩn, không cảnh báo. Trình sinh nằm ở lib/xlsx.ts (không thêm
  // dependency). Cột khớp đúng bảng: Email · Vai trò · Trạng thái · Ngày gia hạn ·
  // Ngày hết hạn.
  function exportSelectedExcel() {
    const selected = members.filter((m) => selectedIds.has(m.id));
    if (selected.length === 0) return;
    const roleLabel = (m: Member) =>
      m.chatgpt_role
        ? t(
            `member.role${m.chatgpt_role.charAt(0).toUpperCase()}${m.chatgpt_role.slice(1)}`,
          )
        : "";
    const statusLabel = (m: Member) =>
      t(`member.status${m.status.charAt(0).toUpperCase()}${m.status.slice(1)}`);
    const header = [
      t("member.colEmail"),
      t("member.colRole"),
      t("member.colStatus"),
      t("addedEmails.colRenewedAt"),
      t("addedEmails.colExpiry"),
    ];
    const rows = selected.map((m) => [
      m.email,
      roleLabel(m),
      statusLabel(m),
      fmtRenewExpiry(
        formatDateTime,
        m.subscription_purchased_at ?? m.last_invited_at ?? m.created_at,
      ),
      m.subscription_end_at
        ? fmtRenewExpiry(formatDateTime, m.subscription_end_at)
        : "",
    ]);
    downloadXlsx(
      `thanh-vien-${new Date().toISOString().slice(0, 10)}.xlsx`,
      header,
      rows,
      t("member.listTitle"),
    );
  }

  // Cột cố định (email, role, status, subscription, joinedAt, actions) = 6, cộng
  // checkbox (nếu canBulk) + cột "Giấy phép" (nếu bật cờ license).
  const colCount =
    6 + (canBulk ? 1 : 0) + (LICENSE_FEATURE_ENABLED ? 1 : 0);

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
      {/* Banner "sắp hết hạn (≤7 ngày)" đã GỠ — thông tin này giờ nằm ở thẻ tổng
         quan "Đến hạn thanh toán" (liệt kê email). Banner ĐỎ "đã hết hạn" (kèm nút
         dọn) vẫn giữ vì có hành động cleanup. */}

      {/* KHỐI 4 THẺ TỔNG QUAN (theo mockup): Tổng · Active (nổi bật xanh, có thanh
          tỉ lệ) · Lời mời chờ · Đến hạn thanh toán (email cần gia hạn). */}
      <div className="metrics" style={{ marginBottom: 22 }}>
        {/* Tổng thành viên — phụ đề seat / tổng workspace chỉ super-admin có. */}
        <div className="metric">
          <div className="metric-head">
            <span className="metric-label">{t("metrics.totalMembers")}</span>
            <span className="metric-dot" />
          </div>
          <div className="metric-value">{total}</div>
          {isSuper && stats && (
            <div className="metric-delta">
              {stats.seat_total != null
                ? t("members.seatUsage", {
                    used: stats.seat_used ?? stats.total,
                    total: stats.seat_total,
                  })
                : t("members.totalInWorkspace", { n: stats.total })}
            </div>
          )}
        </div>

        {/* Đang active — thẻ nổi bật: số + % + thanh tỉ lệ, chấm nhịp. */}
        <div className="metric metric-active">
          <div className="metric-head">
            <span className="metric-label">{t("metrics.activeMembers")}</span>
            <span className="metric-dot live" />
          </div>
          <div className="metric-row">
            <span className="metric-value">{activeCount}</span>
            <span className="metric-pct">{activeRate}%</span>
          </div>
          <div className="metric-bar">
            <i style={{ width: `${activeRate}%` }} />
          </div>
          <div className="metric-delta">{t("metrics.activeSub")}</div>
        </div>

        {/* Lời mời đang chờ. */}
        <div className="metric">
          <div className="metric-head">
            <span className="metric-label">{t("metrics.pendingInvites")}</span>
            <span className={pendingCount > 0 ? "metric-dot warn" : "metric-dot"} />
          </div>
          <div className="metric-value">{pendingCount}</div>
          <div className="metric-delta">{t("metrics.pendingSub")}</div>
        </div>

        {/* Đến hạn thanh toán — email thành viên sắp/đã hết hạn cần gia hạn.
            Chấm đỏ nếu đã có người quá hạn, hổ phách nếu chỉ sắp tới hạn. */}
        <div className="metric">
          <div className="metric-head">
            <span className="metric-label">{t("metrics.duePayment")}</span>
            <span
              className={
                dueMembers.length === 0
                  ? "metric-dot"
                  : expiredMembers.length > 0
                    ? "metric-dot danger"
                    : "metric-dot warn"
              }
            />
          </div>
          <div className="metric-row">
            <span className="metric-value">{dueMembers.length}</span>
            {expiredMembers.length > 0 && (
              <span className="metric-errpill">
                {t("metrics.dueExpired", { n: expiredMembers.length })}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Panel "Hàng đợi tác vụ" — nằm trên bảng danh sách thành viên.
          Desktop-only (tự ẩn <1024px), cần quyền QUEUE_VIEW. */}
      {workspaceId && hasPermission("QUEUE_VIEW") && (
        <WorkspaceTaskRail workspaceId={workspaceId} tasks={recentTasks} />
      )}

      <div className="table-card">
        {/* Header danh sách KHÔNG kẻ vạch dưới — để header + chip lọc liền mạch
            (theo mockup). Vạch phân cách nằm ở dải tiêu đề cột bên dưới chip. */}
        <div className="table-head" style={{ borderBottom: "none", paddingBottom: 8 }}>
          <div>
            <div className="table-title">{t("member.listTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("members.countLabel", { n: total })}
              {/* Tổng toàn workspace + seat CHỈ super-admin. Tài khoản phụ chỉ thấy
                 số thành viên CỦA HỌ ("121 thành viên"), không thấy tổng workspace. */}
              {isSuper && stats && (
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
            {/* Lọc theo chủ sở hữu — super-admin: KHÔNG hiển thị chủ sở hữu trên
                từng mail, chỉ lọc danh sách. Chỉ hiện khi có >1 nguồn để lọc. */}
            {isSuper && (ownerOptions.opts.length > 0 || ownerOptions.hasNoOwner) && (
              <select
                value={ownerFilter}
                onChange={(e) => {
                  setOwnerFilter(e.target.value);
                  setSelectedIds(new Set());
                }}
                className="form-input"
                style={{ padding: "6px 10px", fontSize: 13, width: "auto" }}
                title={t("member.ownerFilterAll")}
              >
                <option value="">{t("member.ownerFilterAll")}</option>
                {ownerOptions.opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                {ownerOptions.hasNoOwner && (
                  <option value={NO_OWNER}>{t("bulkUpdate.noOwner")}</option>
                )}
              </select>
            )}
            {canBulk && selectedCount > 0 && (
              <select
                className="form-input"
                value=""
                disabled={
                  bulkRemoveSelected.isPending ||
                  bulkChangeLicense.isPending ||
                  bulkSetOwner.isPending ||
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
                  bulkSetOwner.isPending ||
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
                    {/* LUÔN hiển thị — chưa có quyền thì bấm sẽ báo liên hệ admin. */}
                    <option value="set-usage-limit">
                      {t("bulkAction.setUsageLimit")}
                    </option>
                    {canRemove && (
                      <option value="remove">{t("bulkAction.remove")}</option>
                    )}
                  </>
                )}
                {/* Chuyển chủ NHANH (chỉ super-admin) — áp dụng cho cả 2 tab vì
                    "chủ sở hữu" độc lập với trạng thái active/pending. Chọn 1 tài
                    khoản phụ để gán, "Tôi" để kéo về mình, hoặc "Thu hồi" (về chưa
                    có chủ). Là thay đổi thuần dữ liệu, không tạo task extension. */}
                {isSuper && (
                  <optgroup label={t("bulkTransferOwner.group")}>
                    <option value="owner:self">
                      {t("bulkTransferOwner.toSelf")}
                    </option>
                    {subAccounts.map((u) => (
                      <option key={u.id} value={`owner:${u.id}`}>
                        {u.username}
                      </option>
                    ))}
                    <option value="owner:">
                      {t("bulkTransferOwner.revoke")}
                    </option>
                  </optgroup>
                )}
              </select>
            )}
            {/* Xuất Excel — hiện cùng lúc với ô "Cập nhật đã chọn" (có ≥1 dòng
                được chọn). Dùng .btn để khớp CHIỀU CAO với .form-input của select
                (items-center canh giữa 2px chênh lệch), whiteSpace:nowrap chống
                vỡ chữ; khi hàng header wrap thì nút tự xuống dưới select. */}
            {canBulk && selectedCount > 0 && (
              <button
                type="button"
                onClick={exportSelectedExcel}
                className="btn btn-ghost"
                style={{ padding: "9px 12px", fontSize: 13, whiteSpace: "nowrap" }}
                title={t("bulkAction.exportExcel")}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  width={15}
                  height={15}
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M12 15V3" />
                </svg>
                {t("bulkAction.exportExcel")}
              </button>
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
            count={tabActiveCount}
          />
          <Chip
            active={statusFilter === "pending"}
            onClick={() => setStatusFilter("pending")}
            label={t("member.statusPending")}
            count={tabPendingCount}
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
                {LICENSE_FEATURE_ENABLED && (
                  <th style={{ textAlign: "center" }}>
                    {t("member.colLicenseType")}
                  </th>
                )}
                <th style={{ textAlign: "center" }}>{t("member.colStatus")}</th>
                <th>{t("addedEmails.colRenewedAt")}</th>
                <th>{t("addedEmails.colExpiry")}</th>
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
                  <td className="cell-email">
                    {/* Click email → mở modal chi tiết + lịch sử hoạt động. */}
                    <button
                      type="button"
                      className="cell-email-link"
                      onClick={() => setDetailMember(m)}
                      title={t("memberDetail.openHint")}
                    >
                      {m.email}
                    </button>
                  </td>
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
                  {LICENSE_FEATURE_ENABLED && (
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
                  )}
                  <td style={{ textAlign: "center" }}>
                    <span className={STATUS_BADGE[m.status] ?? "badge badge-neutral"}>
                      {t(
                        `member.status${m.status
                          .charAt(0)
                          .toUpperCase()}${m.status.slice(1)}`,
                      )}
                    </span>
                  </td>
                  {/* Ngày gia hạn = MỐC NEO subscription_purchased_at (set = giờ mời
                      khi invite, hoặc ngày mua khi đổi hạn) → "Ngày hết hạn" = mốc + 30
                      luôn khớp. Fallback last_invited_at ?? created_at cho row legacy
                      chưa có mốc. Khớp cột cùng tên ở trang "Email đã add". */}
                  <td className="cell-muted" style={{ fontSize: 13.5 }}>
                    {fmtRenewExpiry(
                      formatDateTime,
                      m.subscription_purchased_at ??
                        m.last_invited_at ??
                        m.created_at,
                    )}
                  </td>
                  <td style={{ fontSize: 13.5 }}>
                    <SubscriptionCell
                      member={m}
                      t={t}
                      formatDate={formatDate}
                      formatDateTime={formatDateTime}
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <div
                      className="flex items-center justify-end"
                      style={{ gap: 6 }}
                    >
                      {/* Member CHỜ THAM GIA: gom thao tác vào kebab "⋯" giống tab
                          đang hoạt động. Gồm:
                          - Đồng bộ: tìm email ở tab Lời mời, không thấy thì fallback
                            tab Người dùng; thấy → 'active', không thấy → báo mất.
                          - Đổi email: thu hồi lời mời cũ (fallback xoá nếu đã kịp
                            tham gia) + mời email mới, giữ nguyên hạn dùng.
                          - Thu hồi (danger): huỷ lời mời đang chờ. */}
                      {m.status === "pending" && (
                        <RowActionsMenu
                          ariaLabel={t("common.actions")}
                          items={[
                            {
                              key: "sync",
                              label: t("member.syncAction"),
                              disabled: syncMember.isPending,
                              onClick: () => syncMember.mutate(m.email),
                            },
                            ...(canInvite
                              ? [
                                  {
                                    key: "reinvite",
                                    label: t("member.reinviteAction"),
                                    disabled: reinvite.isPending,
                                    onClick: async () => {
                                      const ok = await confirm(
                                        t("member.confirmReinvite", {
                                          email: m.email,
                                        }),
                                        {
                                          title: t("member.reinviteAction"),
                                          okText: t("member.reinviteAction"),
                                          cancelText: t("common.cancel"),
                                        },
                                      );
                                      if (ok) reinvite.mutate(m.id);
                                    },
                                  },
                                ]
                              : []),
                            ...(canChangeEmail
                              ? [
                                  {
                                    key: "change-email",
                                    label: t("member.changeEmailAction"),
                                    onClick: () => setChangeEmailMember(m),
                                  },
                                ]
                              : []),
                            ...(canRemove
                              ? [
                                  {
                                    key: "revoke",
                                    label: t("member.revokeAction"),
                                    danger: true,
                                    onClick: async () => {
                                      const ok = await confirm(
                                        t("member.confirmRevoke", {
                                          email: m.email,
                                        }),
                                        {
                                          title: t("member.confirmRevokeTitle"),
                                          okText: t("member.revokeAction"),
                                          cancelText: t("common.cancel"),
                                          danger: true,
                                        },
                                      );
                                      if (ok) revokeInvites.mutate([m.email]);
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                      )}
                      {m.status === "active" &&
                        (canRemove || canChangeEmail || canChangeSubscription) && (
                          <RowActionsMenu
                            ariaLabel={t("common.actions")}
                            items={[
                              ...(canChangeSubscription
                                ? [
                                    {
                                      key: "change-subscription",
                                      label: t("subscription.changeAction"),
                                      onClick: () => setChangeSubMember(m),
                                    },
                                  ]
                                : []),
                              ...(canChangeEmail
                                ? [
                                    {
                                      key: "change-email",
                                      label: t("member.changeEmailAction"),
                                      onClick: () => setChangeEmailMember(m),
                                    },
                                  ]
                                : []),
                              ...(canRemove
                                ? [
                                    {
                                      key: "remove",
                                      label: t("member.removeAction"),
                                      danger: true,
                                      onClick: async () => {
                                        const ok = await confirm(
                                          t("member.confirmRemove", {
                                            email: m.email,
                                          }),
                                          {
                                            title: t("member.confirmRemoveTitle"),
                                            okText: t("member.removeAction"),
                                            cancelText: t("common.cancel"),
                                            danger: true,
                                          },
                                        );
                                        if (ok) remove.mutate(m.id);
                                      },
                                    },
                                  ]
                                : []),
                            ]}
                          />
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

      {changeEmailMember && workspaceId && (
        <ChangeEmailModal
          workspaceId={workspaceId}
          member={changeEmailMember}
          onClose={() => setChangeEmailMember(null)}
        />
      )}

      {changeSubMember && workspaceId && (
        <ChangeSubscriptionModal
          workspaceId={workspaceId}
          member={changeSubMember}
          onClose={() => setChangeSubMember(null)}
        />
      )}

      {detailMember && workspaceId && (
        <MemberDetailModal
          workspaceId={workspaceId}
          // Lấy bản MỚI NHẤT từ list (đã refetch sau mutation) theo id, fallback
          // snapshot lúc mở → sửa trong modal (vd đổi Ngày gia hạn) hiển thị NGAY
          // sau khi lưu, KHỎI reload tay. Luật: mutation phải kèm làm mới dữ liệu.
          member={members.find((m) => m.id === detailMember.id) ?? detailMember}
          onClose={() => setDetailMember(null)}
        />
      )}

      {/* Mời lại email HẾT HẠN + ví thiếu → QR thanh toán; quét xong tự thực thi. */}
      {reinviteQr && (
        <OrderQrModal
          order={reinviteQr}
          onClose={() => setReinviteQr(null)}
          onPaid={() => setReinviteQr(null)}
        />
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
 *   - end_at < now: badge ĐỎ "Hết hạn N ngày" + days expired.
 *   - end_at < now + 7 days: badge VÀNG "Còn N ngày" — admin chú ý.
 *   - else: "DD/MM/YYYY - HH:MM:SS (còn Nd)" — ngày hết hạn chi tiết tới giây.
 *
 * Tooltip kèm `subscription_months` để admin biết originally bao nhiêu tháng.
 */
function SubscriptionCell({
  member,
  t,
  formatDate,
  formatDateTime,
}: {
  member: Member;
  t: ReturnType<typeof useT>;
  formatDate: (value: string | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: ReturnType<typeof useFormatDateTime>;
}) {
  // Chỉ báo "chờ duyệt" khi có yêu cầu đổi hạn đang chờ super-admin duyệt. Hiện
  // cạnh hạn HIỆN TẠI (chưa áp dụng) + tooltip cho biết hạn đề xuất.
  const pending =
    member.subscription_request_status === "requested" ? (
      <span
        className="badge badge-warning"
        style={{ marginRight: 4 }}
        title={
          member.pending_subscription_end_at
            ? t("subscription.pendingTooltip", {
                date: formatDate(member.pending_subscription_end_at),
              })
            : t("subscription.pendingUnlimitedTooltip")
        }
      >
        ⏳ {t("subscription.pendingBadge")}
      </span>
    ) : null;

  if (!member.subscription_end_at) {
    return (
      <span>
        {pending}
        <span className="cell-muted">—</span>
      </span>
    );
  }
  const endMs = new Date(member.subscription_end_at).getTime();
  const nowMs = Date.now();
  const diffDays = Math.round((endMs - nowMs) / (24 * 60 * 60 * 1000));
  const endStr = fmtRenewExpiry(formatDateTime, member.subscription_end_at);
  const monthsLabel = member.subscription_months
    ? t("member.subscriptionMonths", { n: member.subscription_months })
    : "";
  const tooltip = monthsLabel ? `${endStr} · ${monthsLabel}` : endStr;

  // LUÔN hiển thị RÕ ngày hết hạn (mono, tới giây); kèm chip số ngày đổi màu theo
  // mức khẩn: đỏ = đã hết hạn, vàng = còn ≤7 ngày, xám = còn xa. (Trước đây ca
  // hết hạn / ≤7 ngày chỉ hiện "Còn N ngày" mà giấu mất ngày — user report 2026-07-06.)
  // Chip số ngày = TEXT THUẦN (không badge → không dấu chấm, không emoji), format
  // "(còn Nd)". Chỉ đổi MÀU text theo mức khẩn (user 2026-07-06):
  //   < 3 ngày → ĐỎ · < 7 ngày → VÀNG · còn xa → xám.
  const urgencyColor =
    diffDays < 3
      ? "var(--danger)"
      : diffDays < 7
        ? "var(--warning)"
        : "var(--ink-3)";
  // Đang còn hạn: "(còn Nd)". Đã hết hạn: "Hết hạn N ngày".
  const daysLabel =
    diffDays <= 0
      ? t("member.subExpired", { n: -diffDays })
      : `(${t("member.subDaysLeftShort", { n: diffDays })})`;
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
      title={tooltip}
    >
      {pending}
      {/* CẢ Ô đổi màu theo mức khẩn: < 7 ngày → ngày hết hạn cũng nhuộm màu cảnh
          báo (đỏ/vàng), không chỉ riêng "(còn Nd)" — user report 2026-07-06. */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 13.5,
          color: diffDays < 7 ? urgencyColor : "var(--ink-2)",
          fontWeight: diffDays < 7 ? 600 : 400,
        }}
      >
        {endStr}
      </span>
      <span
        style={{
          fontSize: 12.5,
          color: urgencyColor,
          fontWeight: diffDays < 7 ? 600 : 400,
        }}
      >
        {daysLabel}
      </span>
    </span>
  );
}
