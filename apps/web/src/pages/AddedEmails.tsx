import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { queuePollInterval } from "../lib/queuePolling";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAddedEmails } from "../hooks/useAddedEmails";
import { useFormatDate, useFormatDateTime, useT } from "../i18n";
import type { AddedMember, QueueItem, SubscriptionCycle } from "../types";
import { SearchInput } from "./Members";
import { MemberDetailModal } from "../components/MemberDetailModal";
import { ChangeEmailModal } from "../components/ChangeEmailModal";
import { TransferSubscriptionModal } from "../components/TransferSubscriptionModal";
import { ChangeSubscriptionModal } from "../components/ChangeSubscriptionModal";
import { NotifyLinkModal } from "../components/NotifyLinkModal";
import { RowActionsMenu, type RowActionItem } from "../components/RowActionsMenu";
import { RemovedEmailsList } from "../components/RemovedEmailsList";
import { confirm, toast } from "../components/Toast";
import { useAddedMemberActions } from "../hooks/useAddedMemberActions";
import OrderQrModal from "../components/OrderQrModal";
import type { OrderQr } from "../lib/wallet";

type SubAccount = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
};

type PaymentFilter = "all" | "today" | "unpaid" | "requested";
// Tab trạng thái CHÍNH (giống bảng Thành viên trong workspace, nhưng ở đây gom mọi
// không gian): "active" = Đã tham gia, "pending" = Chờ tham gia.
// "removed" = tab "Đã xoá": email đã rời team trong 30 ngày gần nhất, CHỈ ĐỌC
// (danh sách đến từ query riêng ?removed=true, không nằm trong `members`).
type StatusTab = "active" | "pending" | "removed";

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-success",
  pending: "badge badge-warning",
  removed: "badge badge-danger",
};

// Cột "Ngày gia hạn" / "Ngày hết hạn" hiển thị thời gian chi tiết tới giây.
const PRECISE_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

// Icon 16px (Feather, stroke=currentColor) cho các item menu hàng loạt không nằm
// trong DEFAULT_ICONS của RowActionsMenu (thanh toán / chuyển chủ).
const ICON_PAYMENT = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <line x1="2" y1="10" x2="22" y2="10" />
  </svg>
);
const ICON_OWNER = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export default function AddedEmails() {
  const t = useT();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const { user, hasPermission } = useAuth();
  const isSuper = user?.is_super_admin === true;
  const isMobile = useIsMobile();

  // Quyền cho menu thao tác ⋯ theo dòng (khớp Members.tsx). Gán workspace CHỈ
  // giới hạn việc mời (add) → các email owner đã thêm luôn được đổi hạn/đổi
  // email/xoá; ở đây vẫn gate theo permission gốc như backend yêu cầu.
  const canRemove = hasPermission("MEMBER_REMOVE");
  const canInvite = hasPermission("MEMBER_INVITE");
  const canChangeEmail = canRemove && hasPermission("MEMBER_INVITE");
  const canChangeSubscription = hasPermission("MEMBER_INVITE");

  // Khởi tạo filter từ ?filter= (chuông thông báo mở thẳng "Chờ xác nhận").
  const [searchParams] = useSearchParams();
  const initialFilter: PaymentFilter =
    searchParams.get("filter") === "requested" ? "requested" : "all";

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PaymentFilter>(initialFilter);
  // Tab trạng thái: mặc định "Đã tham gia" (khớp Members.tsx). Chuyển sang "Chờ
  // tham gia" để xem + đồng bộ/thu hồi hàng loạt các lời mời pending mọi không gian.
  const [statusTab, setStatusTab] = useState<StatusTab>("active");
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Click email → mở modal chi tiết + lịch sử hoạt động của email đó.
  const [detailMember, setDetailMember] = useState<AddedMember | null>(null);
  // Email đang mở modal "Đổi email" / "Đổi hạn dùng" từ menu ⋯ theo dòng (null = đóng).
  const [changeEmailMember, setChangeEmailMember] = useState<AddedMember | null>(
    null,
  );
  const [changeSubMember, setChangeSubMember] = useState<AddedMember | null>(
    null,
  );
  // "Chuyển hạn sử dụng đến" — khác Đổi email ở chỗ email nhận ĐƯỢC PHÉP đang là
  // thành viên (hạn còn lại cộng dồn). Xem hooks/useTransferSubscription.md.
  const [transferMember, setTransferMember] = useState<AddedMember | null>(null);
  // Email đang mở modal "Thông báo" — lấy link gửi cho khách để họ nhận nhắc gia hạn
  // của đúng email đó. Có mặt ngay sau khi mời thành công (email vào danh sách này).
  const [notifyMember, setNotifyMember] = useState<AddedMember | null>(null);
  // Ví thiếu tiền → QR thanh toán. Dùng chung cho mời lại email hết hạn và cho
  // nút "Thanh toán" kỳ còn nợ (hoá đơn kind='cycle').
  const [qrOrder, setQrOrder] = useState<OrderQr | null>(null);

  const { payCycles, requestPayment, markPaid, transferOwner } = useAddedEmails({
    onCleared: () => setSelected(new Set()),
    onPaymentRequired: (order) => setQrOrder(order),
  });

  // Đại lý đã bật Ví: bấm "Thanh toán" là TRẢ TIỀN THẬT (trừ ví, thiếu thì ra QR) —
  // kỳ tự thành "đã thanh toán", không phải chờ super-admin bấm xác nhận. Đại lý
  // chưa bật Ví giữ đường cũ: gửi yêu cầu duyệt. Vì sao đổi (user 2026-08-29): ca
  // hoàn phí mù 28-29/8 đẩy 7 email đã giao dịch vụ về diện "chưa thanh toán"; bấm
  // "Xác nhận" chỉ đóng dấu đã trả trong khi không đồng nào về két.
  const chargeable = !!user?.wallet_beta && !isSuper;
  const payAction = {
    isPending: chargeable ? payCycles.isPending : requestPayment.isPending,
    run: (vars: { ids?: string[]; cycleIds?: string[] }) =>
      chargeable
        ? payCycles.mutate(vars)
        : requestPayment.mutate({ ...vars, requested: true }),
  };
  // Thao tác theo dòng (Đồng bộ / Thu hồi / Xoá / Mời lại) — workspaceId truyền theo
  // từng lời gọi vì mỗi email có thể thuộc workspace khác nhau. Xem useAddedMemberActions.
  const rowActions = useAddedMemberActions({
    onPaymentRequired: (order) => setQrOrder(order),
  });

  // Super-admin: danh sách tài khoản phụ để xem riêng từng người.
  const { data: subAccounts = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<SubAccount[]>("/api/v1/users"),
    enabled: isSuper,
    select: (rows) => rows.filter((u) => !u.is_super_admin),
  });

  const queryParam =
    isSuper && selectedUserId ? `?user_id=${selectedUserId}` : "";
  const { data: members = [], isLoading } = useQuery({
    queryKey: ["added-members", isSuper ? selectedUserId : "self"],
    queryFn: () => api<AddedMember[]>(`/api/v1/added-members${queryParam}`),
    // Phục vụ TỪ CACHE — KHÔNG refetch theo thời gian / khi vào lại trang / focus
    // tab. Chỉ gọi lại DB khi dữ liệu THỰC SỰ đổi, qua invalidate ["added-members"]
    // từ: (1) mutation của chính user, (2) watcher recent-tasks-global khi task nền
    // (mời/xoá/đồng bộ/tự gỡ hết hạn) hoàn tất. (User 2026-07-20: dữ liệu lấy cache,
    // chỉ khi thay đổi mới get từ DB.) invalidate vẫn ép refetch dù staleTime=Infinity.
    staleTime: Infinity,
    // Ghi đè mặc định toàn cục (bật ở main.tsx): giữ đúng thiết kế cache ở trên,
    // KHÔNG refetch khi focus tab — mọi cập nhật đi qua invalidate của watcher.
    refetchOnWindowFocus: false,
  });

  // Tab "Đã xoá" — danh sách RIÊNG (?removed=true): email đã rời team trong 30 ngày
  // gần nhất, backend sắp mới-xoá-trước. Tách khỏi query chính vì hai tập không giao
  // nhau (list chính lọc status != 'removed') và tab này ít khi mở → chỉ gọi khi user
  // thực sự vào tab (`enabled`), khỏi tốn 1 truy vấn cho mọi lần mở trang.
  //
  // Key giữ TIỀN TỐ ["added-members", ...] → mọi invalidate ["added-members"] sẵn có
  // (mutation + watcher task nền) cũng làm mới tab này, khỏi đi thêm đường riêng.
  const { data: removedMembers = [], isLoading: removedLoading } = useQuery({
    queryKey: ["added-members", isSuper ? selectedUserId : "self", "removed"],
    queryFn: () =>
      api<AddedMember[]>(
        `/api/v1/added-members${queryParam ? `${queryParam}&` : "?"}removed=true`,
      ),
    enabled: statusTab === "removed",
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Auto-refresh list khi task extension (Thu hồi / Xoá / Đồng bộ 1 email) mà
  // owner enqueue TỪ TRANG NÀY chuyển sang terminal (COMPLETED/FAILED).
  //
  // Vì sao cần: các thao tác theo dòng chỉ ENQUEUE task; extension mới thực thi
  // trên ChatGPT rồi báo COMPLETED sau. `useAddedMemberActions.refresh()` invalidate
  // ["added-members"] NGAY lúc enqueue — lúc đó DB CHƯA đổi (member còn pending) →
  // refetch tức thì không thấy khác gì → user tưởng "không hoạt động", phải F5.
  // Watcher này (mô phỏng Members.tsx) bắt thời điểm task VỪA hoàn tất → invalidate
  // ["added-members"] LẦN 2 lúc DB đã đổi → dòng tự biến mất/cập nhật, KHỎI F5.
  //
  // Trang gom email XUYÊN nhiều workspace → poll QUEUE TOÀN CỤC (không workspace_id):
  // sub-admin chỉ thấy task mình tạo (đúng phạm vi list), super-admin thấy tất cả.
  // Dùng key ["recent-tasks-global"] (khác ["recent-tasks", wsId] của Members) →
  // refresh() invalidate ["recent-tasks-global"] để refetch ngay sau enqueue.
  const { data: recentTasks = [] } = useQuery({
    queryKey: ["recent-tasks-global"],
    queryFn: () => api<QueueItem[]>("/api/v1/queue?limit=50"),
    // Poll 2s khi còn task chạy; idle nhịp tim 10s (khớp Members.tsx) để bắt cả
    // task do tab/phiên khác của owner tạo. refresh() sau enqueue → refetch ngay →
    // thấy PENDING → poll bật 2s.
    refetchInterval: queuePollInterval(2000, 10000),
  });

  // Chỉ invalidate khi 1 task VỪA chuyển đang-chạy → terminal NGAY TRƯỚC MẮT user
  // (status lần trước là PENDING/IN_PROGRESS). Lần đầu thấy task (kể cả task lịch
  // sử đã terminal lúc mở trang) chỉ ghi nhận status → tránh invalidate/toast thừa.
  const lastStatusRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const mutatingTypes = new Set([
      "INVITE_MEMBER",
      "REMOVE_MEMBER",
      "CHANGE_ROLE",
      "CHANGE_LICENSE_TYPE",
      "SET_USAGE_LIMIT",
      "REVOKE_INVITES",
      "SYNC_DATA",
      "SYNC_MEMBER",
      "SYNC_MEMBERS_BATCH",
    ]);
    const justFinished: QueueItem[] = [];
    for (const task of recentTasks) {
      if (!mutatingTypes.has(task.type)) continue;
      const prev = lastStatusRef.current.get(task.id);
      lastStatusRef.current.set(task.id, task.status);
      const isTerminal = task.status === "COMPLETED" || task.status === "FAILED";
      const wasActive = prev === "PENDING" || prev === "IN_PROGRESS";
      if (isTerminal && wasActive) justFinished.push(task);
    }
    if (justFinished.length === 0) return;
    qc.invalidateQueries({ queryKey: ["added-members"] });
    for (const task of justFinished) {
      const typeLabel = t(`taskType.${task.type}`);
      if (task.status === "COMPLETED") {
        toast.success(t("task.completedToast", { type: typeLabel }));
      } else {
        toast.error(t("task.failedToast", { type: typeLabel }));
      }
    }
  }, [recentTasks, qc, t]);

  // Workspace có mặt trong danh sách hiện tại → đổ vào dropdown lọc riêng. Ở tab
  // "Đã xoá" thì lấy theo danh sách email đã xoá — không gian của email còn sống
  // chưa chắc còn email nào bị xoá và ngược lại.
  const workspaces = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of statusTab === "removed" ? removedMembers : members) {
      if (m.workspace_id)
        map.set(m.workspace_id, m.workspace_name ?? m.workspace_id);
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [members, removedMembers, statusTab]);

  // Số đếm cho 2 tab "Đã tham gia / Chờ tham gia": tôn trọng bộ lọc không gian
  // (dropdown workspace) để badge khớp danh sách đang xem, nhưng KHÔNG phụ thuộc ô
  // tìm kiếm hay filter thanh toán (2 thứ đó chỉ thu hẹp TRONG tab). selectedUserId
  // đã lọc sẵn ở tầng query nên members ở đây vốn đã đúng phạm vi tài khoản.
  const wsScoped = useMemo(
    () =>
      selectedWorkspace
        ? members.filter((m) => m.workspace_id === selectedWorkspace)
        : members,
    [members, selectedWorkspace],
  );
  const tabActiveCount = wsScoped.filter((m) => m.status === "active").length;
  const tabPendingCount = wsScoped.filter((m) => m.status === "pending").length;

  const filtered = useMemo(() => {
    // Tab "Đã xoá" đọc danh sách riêng; hai tab kia lọc theo status trong `members`.
    let rows =
      statusTab === "removed"
        ? removedMembers
        : members.filter((m) => m.status === statusTab);
    if (selectedWorkspace)
      rows = rows.filter((m) => m.workspace_id === selectedWorkspace);
    // Chip lọc thanh toán nói về email CÒN SỐNG (add hôm nay / chưa trả / chờ duyệt)
    // → tab "Đã xoá" bỏ qua hẳn, và UI cũng ẩn nhóm chip đó đi.
    if (statusTab !== "removed") {
      // "Ngày thêm" = last_invited_at ?? created_at (xem Members.tsx): re-invite
      // giữ created_at cũ → filter "hôm nay" theo last_invited_at mới để email
      // vừa mời lại hôm nay không bị loại oan.
      if (filter === "today")
        rows = rows.filter((m) => isToday(m.last_invited_at ?? m.created_at));
      else if (filter === "unpaid")
        rows = rows.filter((m) => m.payment_status === "unpaid");
      else if (filter === "requested")
        rows = rows.filter((m) => m.payment_status === "requested");
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter(
        (m) =>
          m.email.toLowerCase().includes(s) ||
          (m.name ?? "").toLowerCase().includes(s) ||
          (m.workspace_name ?? "").toLowerCase().includes(s),
      );
    }
    return rows;
  }, [
    members,
    removedMembers,
    filter,
    search,
    selectedWorkspace,
    statusTab,
  ]);

  const total = members.length;
  const paidCount = members.filter((m) => m.payment_status === "paid").length;

  // Nhắc nhở hết hạn cho CHỦ SỞ HỮU email (bản đơn giản, không có nút remove —
  // remove là việc của admin ở trang Members). Mục đích: nhắc owner liên hệ
  // khách hàng để gia hạn TRƯỚC khi background scheduler tự xoá email hết hạn.
  // Tính trên `members` (đã lọc visibility ở backend) chứ không phải `filtered`
  // để con số phản ánh đúng tổng email hết hạn của owner, không bị filter/search
  // hiện tại che bớt. Điều kiện khớp Members.tsx: còn active/pending + đã quá hạn.
  const expiredMembers = members.filter(
    (m) =>
      m.subscription_end_at &&
      (m.status === "active" || m.status === "pending") &&
      new Date(m.subscription_end_at).getTime() <= Date.now(),
  );

  // 2 thẻ thống kê giữa:
  //   "Chờ tham gia"     = email đã thêm nhưng chưa vào team (status pending).
  //   "Chưa thanh toán"  = email còn nợ tiền (payment_status 'unpaid').
  //
  // ⚠️ Thẻ này PHẢI đếm ĐÚNG thứ mà chip lọc cùng tên lọc ra (`payment_status ===
  // "unpaid"`). Trước 30/8/2026 nó đếm `isRenewalDue` (đã hết hạn hoặc còn ≤7 ngày)
  // trong khi chip lọc theo tiền → bấm vào thẻ ghi 9 lại ra danh sách khác hẳn, và
  // email nợ tiền nhưng còn hạn dài thì không đếm vào đâu cả. Nhãn cũ "Đến hạn gia
  // hạn" nay trả về đúng chỗ của nó là Members.tsx (`metrics.duePayment`), nơi con
  // số ĐÚNG là hạn dùng chứ không phải tiền.
  const pendingCount = members.filter((m) => m.status === "pending").length;
  const unpaidCount = members.filter(
    (m) => m.payment_status === "unpaid",
  ).length;

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((m) => selected.has(m.id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (filtered.every((m) => prev.has(m.id))) {
        const next = new Set(prev);
        filtered.forEach((m) => next.delete(m.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((m) => next.add(m.id));
      return next;
    });
  }

  const selectedIds = Array.from(selected);

  // Các dòng đang chọn là PENDING (kèm workspace_id để gom theo không gian). Tab
  // "Chờ tham gia" chỉ chứa pending nên selection ở đó đều lọt; vẫn lọc phòng khi
  // còn chọn sót từ tab khác.
  const pendingSelectedRows = members
    .filter((m) => selected.has(m.id) && m.status === "pending")
    .map((m) => ({ workspaceId: m.workspace_id, email: m.email }));

  // Đồng bộ hàng loạt (kiểm tra đã tham gia) các lời mời đã chọn — xuyên workspace.
  async function handleBulkSync() {
    if (pendingSelectedRows.length === 0) return;
    const n = pendingSelectedRows.length;
    const ok = await confirm(t("bulkSync.confirmBody", { n }), {
      title: t("bulkSync.confirmTitle", { n }),
      okText: t("bulkSync.confirmOk", { n }),
      cancelText: t("common.cancel"),
    });
    if (ok)
      rowActions.bulkSync.mutate(pendingSelectedRows, {
        onSuccess: () => setSelected(new Set()),
      });
  }

  // Mời lại hàng loạt các lời mời pending đã chọn — xuyên workspace. Backend chỉ
  // nhận email CÒN HẠN (miễn phí) và tự bỏ qua email hết hạn (báo lại số bị bỏ) →
  // lệnh hàng loạt không bao giờ bật modal QR giữa chừng.
  async function handleBulkReinvite() {
    const rows = members
      .filter((m) => selected.has(m.id) && m.status === "pending")
      .map((m) => ({ workspaceId: m.workspace_id, memberId: m.id }));
    if (rows.length === 0) return;
    const n = rows.length;
    const ok = await confirm(t("bulkReinvite.confirmBody", { n }), {
      title: t("bulkReinvite.confirmTitle", { n }),
      okText: t("bulkReinvite.confirmOk", { n }),
      cancelText: t("common.cancel"),
    });
    if (ok)
      rowActions.bulkReinvite.mutate(rows, {
        onSuccess: () => setSelected(new Set()),
      });
  }

  // Thu hồi hàng loạt các lời mời pending đã chọn — xuyên workspace.
  async function handleBulkRevoke() {
    if (pendingSelectedRows.length === 0) return;
    const n = pendingSelectedRows.length;
    const ok = await confirm(t("bulkRevoke.confirmBody", { n }), {
      title: t("bulkRevoke.confirmTitle", { n }),
      okText: t("bulkRevoke.confirmOk", { n }),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (ok)
      rowActions.bulkRevoke.mutate(pendingSelectedRows, {
        onSuccess: () => setSelected(new Set()),
      });
  }

  // Đang chạy 1 thao tác hàng loạt bất kỳ → khoá select để tránh bấm chồng.
  const bulkBusy =
    markPaid.isPending ||
    payCycles.isPending ||
    requestPayment.isPending ||
    transferOwner.isPending ||
    rowActions.bulkSync.isPending ||
    rowActions.bulkReinvite.isPending ||
    rowActions.bulkRevoke.isPending;

  // MỘT menu gom mọi thao tác hàng loạt (giống tab Thành viên trong workspace).
  // markPaid/requestPayment/transferOwner tự clear selection qua onCleared.
  const bulkMenuItems: RowActionItem[] = [
    // Tab "Chờ tham gia" → Đồng bộ + Thu hồi lời mời.
    ...(statusTab === "pending"
      ? [
          {
            key: "sync",
            label: t("bulkAction.sync"),
            disabled: bulkBusy,
            onClick: () => void handleBulkSync(),
          },
          {
            key: "reinvite",
            label: t("bulkAction.reinvite"),
            disabled: bulkBusy,
            onClick: () => void handleBulkReinvite(),
          },
          ...(canRemove
            ? [
                {
                  key: "revoke",
                  label: t("bulkAction.revoke"),
                  danger: true,
                  disabled: bulkBusy,
                  onClick: () => void handleBulkRevoke(),
                },
              ]
            : []),
        ]
      : []),
    // Thanh toán thủ công — CẢ 2 tab (email chờ tham gia vẫn có thể còn kỳ chưa
    // thanh toán do gia hạn / mời lại).
    isSuper
      ? {
          key: "confirm-payment",
          label: t("addedEmails.confirmPayment"),
          icon: ICON_PAYMENT,
          disabled: bulkBusy,
          onClick: () => markPaid.mutate({ ids: selectedIds, paid: true }),
        }
      : {
          key: "request-payment",
          label: t("addedEmails.requestPayment"),
          icon: ICON_PAYMENT,
          disabled: bulkBusy,
          onClick: () => payAction.run({ ids: selectedIds }),
        },
    // Chuyển chủ nhanh (chỉ super-admin) — áp cho cả 2 tab.
    ...(isSuper
      ? [
          { key: "owner-head", label: t("bulkTransferOwner.group"), heading: true },
          {
            key: "owner:self",
            label: t("bulkTransferOwner.toSelf"),
            icon: ICON_OWNER,
            disabled: bulkBusy,
            onClick: () =>
              user &&
              transferOwner.mutate({ ids: selectedIds, targetUserId: user.id }),
          },
          ...subAccounts.map((u) => ({
            key: `owner:${u.id}`,
            label: u.username,
            icon: ICON_OWNER,
            disabled: bulkBusy,
            onClick: () =>
              transferOwner.mutate({ ids: selectedIds, targetUserId: u.id }),
          })),
        ]
      : []),
  ];

  // Menu ⋯ theo dòng — DÙNG CHUNG cho bảng (desktop) và thẻ email (mobile):
  //   active (đã tham gia) → Đổi hạn / Đổi email / Xoá;
  //   pending (chờ tham gia) → Đồng bộ / Mời lại / Đổi email / Thu hồi.
  /** Nút "Thông báo" HIỆN SẴN trên mỗi dòng email (không giấu trong menu ⋯): mời
   *  xong là thấy ngay chỗ lấy link gửi cho khách. Nút đổi màu khi email đã có
   *  người nhận → nhìn bảng là biết email nào đã gắn thông báo, email nào chưa. */
  function notifyButton(m: AddedMember) {
    const bound = !!m.notify_telegram_chat_id;
    const waiting = !!m.notify_telegram_target && !m.notify_telegram_chat_id;
    return (
      <button
        type="button"
        className="btn btn-sm"
        onClick={(e) => {
          e.stopPropagation();
          setNotifyMember(m);
        }}
        title={
          bound
            ? t("telegram.notifyLinkHasRecipient", { who: m.notify_telegram_target ?? "" })
            : waiting
              ? t("telegram.targetPending")
              : t("telegram.notifyAction")
        }
        style={{
          padding: "2px 8px",
          fontSize: 12,
          whiteSpace: "nowrap",
          color: bound
            ? "var(--success)"
            : waiting
              ? "var(--warning)"
              : "var(--ink-2)",
        }}
      >
        {t("telegram.notifyAction")}
      </button>
    );
  }

  function rowMenu(m: AddedMember) {
    if (m.status === "active") {
      return (
        <RowActionsMenu
          ariaLabel={t("common.actions")}
          items={[
            /* "Mời lại" cho member ĐANG ACTIVE chỉ hiện khi lần ĐỒNG BỘ gần nhất
               KHÔNG thấy email trong workspace (sync_missing_at) — DB ghi active
               nhưng người đó đã rời đội. Sync còn thấy → backend chặn 409, nên
               không bày nút (user 2026-08-22). */
            ...(canInvite && m.sync_missing_at
              ? [
                  {
                    key: "reinvite",
                    label: t("member.reinviteAction"),
                    disabled: rowActions.reinvite.isPending,
                    onClick: async () => {
                      const ok = await confirm(
                        t("member.confirmReinviteMissing", { email: m.email }),
                        {
                          title: t("member.reinviteAction"),
                          okText: t("member.reinviteAction"),
                          cancelText: t("common.cancel"),
                        },
                      );
                      if (ok)
                        rowActions.reinvite.mutate({
                          workspaceId: m.workspace_id,
                          memberId: m.id,
                        });
                    },
                  },
                ]
              : []),
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
                  {
                    key: "transfer-expiry",
                    label: t("member.transferExpiryAction"),
                    onClick: () => setTransferMember(m),
                  },
                ]
              : []),
            ...(canRemove
              ? [
                  {
                    key: "remove",
                    label: t("member.removeAction"),
                    danger: true,
                    disabled: rowActions.remove.isPending,
                    onClick: async () => {
                      const ok = await confirm(
                        t("member.confirmRemove", { email: m.email }),
                        {
                          title: t("member.confirmRemoveTitle"),
                          okText: t("member.removeAction"),
                          cancelText: t("common.cancel"),
                          danger: true,
                        },
                      );
                      if (ok)
                        rowActions.remove.mutate({
                          workspaceId: m.workspace_id,
                          memberId: m.id,
                        });
                    },
                  },
                ]
              : []),
          ]}
        />
      );
    }
    if (m.status === "pending") {
      return (
        <RowActionsMenu
          ariaLabel={t("common.actions")}
          items={[
            {
              key: "sync",
              label: t("member.syncAction"),
              disabled: rowActions.sync.isPending,
              onClick: () =>
                rowActions.sync.mutate({
                  workspaceId: m.workspace_id,
                  email: m.email,
                }),
            },
            ...(canInvite
              ? [
                  {
                    key: "reinvite",
                    label: t("member.reinviteAction"),
                    disabled: rowActions.reinvite.isPending,
                    onClick: async () => {
                      const ok = await confirm(
                        t("member.confirmReinvite", { email: m.email }),
                        {
                          title: t("member.reinviteAction"),
                          okText: t("member.reinviteAction"),
                          cancelText: t("common.cancel"),
                        },
                      );
                      if (ok)
                        rowActions.reinvite.mutate({
                          workspaceId: m.workspace_id,
                          memberId: m.id,
                        });
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
                  {
                    key: "transfer-expiry",
                    label: t("member.transferExpiryAction"),
                    onClick: () => setTransferMember(m),
                  },
                ]
              : []),
            ...(canRemove
              ? [
                  {
                    key: "revoke",
                    label: t("member.revokeAction"),
                    danger: true,
                    disabled: rowActions.revoke.isPending,
                    onClick: async () => {
                      const ok = await confirm(
                        t("member.confirmRevoke", { email: m.email }),
                        {
                          title: t("member.confirmRevokeTitle"),
                          okText: t("member.revokeAction"),
                          cancelText: t("common.cancel"),
                          danger: true,
                        },
                      );
                      if (ok)
                        rowActions.revoke.mutate({
                          workspaceId: m.workspace_id,
                          email: m.email,
                        });
                    },
                  },
                ]
              : []),
          ]}
        />
      );
    }
    return null;
  }

  // Nhãn trạng thái (Đã tham gia / Chờ tham gia / Đã gỡ) + class badge tương ứng.
  const statusBadge = (m: AddedMember) => (
    <span className={STATUS_BADGE[m.status] ?? "badge badge-neutral"}>
      {t(
        `member.status${m.status.charAt(0).toUpperCase()}${m.status.slice(1)}`,
      )}
    </span>
  );

  // Ngày gia hạn = mốc neo subscription_purchased_at (fallback last_invited_at ??
  // created_at cho row legacy) → khớp "Ngày hết hạn" = mốc + 30.
  const renewedAt = (m: AddedMember) =>
    formatDateTime(
      m.subscription_purchased_at ?? m.last_invited_at ?? m.created_at,
      undefined,
      PRECISE_TIME,
    );
  const expiryAt = (m: AddedMember) =>
    m.subscription_end_at
      ? formatDateTime(m.subscription_end_at, undefined, PRECISE_TIME)
      : t("addedEmails.expiryNone");

  return (
    <div className="page-fade">
      <div
        className="flex justify-between"
        style={{
          gap: isMobile ? 14 : 24,
          marginBottom: isMobile ? 20 : 32,
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="breadcrumb">{t("nav.addedEmails")}</div>
          {/* Mobile chỉ hiển thị đường dẫn (breadcrumb) — bỏ tiêu đề lớn cho đỡ
              thừa 1 dòng trùng nội dung. Desktop vẫn giữ tiêu đề. */}
          {!isMobile && (
            <h1 className="display-h1">{t("addedEmails.title")}</h1>
          )}
        </div>
        {/* Nút "Cập nhật hạn hàng loạt" đã ẩn theo yêu cầu. */}
      </div>

      {/* Chi tiết + lịch sử thay đổi của 1 email (AddedMember ⊇ Member nên
          truyền thẳng vào MemberDetailModal; endpoint logs theo workspace_id). */}
      {detailMember && (
        <MemberDetailModal
          workspaceId={detailMember.workspace_id}
          // Bản MỚI NHẤT từ list (đã refetch sau khi xử lý kỳ trong modal) theo id →
          // các kỳ trong modal tự cập nhật NGAY, khỏi đóng/mở lại. Fallback snapshot.
          member={members.find((x) => x.id === detailMember.id) ?? detailMember}
          onClose={() => setDetailMember(null)}
        />
      )}

      {/* Đổi email / Đổi hạn dùng từ menu ⋯ theo dòng. Mỗi email có workspace_id
          riêng → truyền thẳng workspace của dòng (AddedMember ⊇ Member). */}
      {changeEmailMember && (
        <ChangeEmailModal
          workspaceId={changeEmailMember.workspace_id}
          member={changeEmailMember}
          onClose={() => setChangeEmailMember(null)}
        />
      )}
      {transferMember && (
        <TransferSubscriptionModal
          workspaceId={transferMember.workspace_id}
          member={transferMember}
          onClose={() => setTransferMember(null)}
        />
      )}
      {changeSubMember && (
        <ChangeSubscriptionModal
          workspaceId={changeSubMember.workspace_id}
          member={changeSubMember}
          onClose={() => setChangeSubMember(null)}
        />
      )}
      {notifyMember && (
        <NotifyLinkModal
          member={notifyMember}
          onClose={() => setNotifyMember(null)}
        />
      )}

      {/* Ví thiếu (mời lại email hết hạn / trả kỳ còn nợ) → QR; quét xong tự thực thi. */}
      {qrOrder && (
        <OrderQrModal
          order={qrOrder}
          onClose={() => setQrOrder(null)}
          onPaid={() => setQrOrder(null)}
        />
      )}

      {/* Nhắc nhở hết hạn (đơn giản) cho chủ sở hữu — không nút, chỉ nhắc liên
          hệ khách gia hạn kẻo email tự bị xoá. Bản đầy đủ + nút remove ở Members. */}
      {expiredMembers.length > 0 && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          <div className="notice-icon">⏰</div>
          <div style={{ flex: 1 }}>
            <div className="notice-title">
              {t("addedEmails.expiredReminderTitle", {
                n: expiredMembers.length,
              })}
            </div>
            <div className="notice-body" style={{ marginTop: 4 }}>
              {t("addedEmails.expiredReminderBody")}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--ink-2)",
              }}
            >
              {expiredMembers
                .slice(0, 5)
                .map((m) => m.email)
                .join(", ")}
              {expiredMembers.length > 5
                ? ` +${expiredMembers.length - 5}`
                : ""}
            </div>
          </div>
        </div>
      )}

      <div className="metrics" style={{ marginBottom: 24 }}>
        <Metric label={t("addedEmails.metricTotal")} value={total} />
        <Metric label={t("addedEmails.metricPaid")} value={paidCount} />
        <Metric
          label={t("addedEmails.metricRequested")}
          value={pendingCount}
        />
        <Metric label={t("addedEmails.metricUnpaid")} value={unpaidCount} />
      </div>

      <div className="table-card added-emails-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("addedEmails.listTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("addedEmails.countLabel", { n: filtered.length })}
            </div>
          </div>
          {(() => {
            // Nhóm select (tài khoản/không gian) + chip lọc — dùng lại cho cả 2
            // bố cục. Trên mobile: ô tìm chiếm 1 dòng riêng, nhóm lọc cuộn ngang.
            const filtersEl = (
              <>
                {isSuper && (
                  <select
                    value={selectedUserId}
                    onChange={(e) => {
                      setSelectedUserId(e.target.value);
                      setSelected(new Set());
                    }}
                    className="form-input"
                    style={{ padding: "6px 10px", fontSize: 13, width: "auto" }}
                  >
                    <option value="">{t("addedEmails.allSubAccounts")}</option>
                    {user && <option value={user.id}>Admin (bạn)</option>}
                    {subAccounts.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))}
                  </select>
                )}
                {workspaces.length > 1 && (
                  <select
                    value={selectedWorkspace}
                    onChange={(e) => {
                      setSelectedWorkspace(e.target.value);
                      setSelected(new Set());
                    }}
                    className="form-input"
                    style={{ padding: "6px 10px", fontSize: 13, width: "auto" }}
                  >
                    <option value="">{t("addedEmails.allWorkspaces")}</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                )}
                {/* Lọc theo thanh toán chỉ có nghĩa với email còn sống → ẩn ở tab
                    "Đã xoá" (bảng ở đó không có cột thanh toán). */}
                {statusTab !== "removed" && (
                  <>
                    <FilterChip
                      active={filter === "all"}
                      onClick={() => setFilter("all")}
                    >
                      {t("addedEmails.filterAll")}
                    </FilterChip>
                    <FilterChip
                      active={filter === "today"}
                      onClick={() => setFilter("today")}
                    >
                      {t("addedEmails.filterToday")}
                    </FilterChip>
                    <FilterChip
                      active={filter === "requested"}
                      onClick={() => setFilter("requested")}
                    >
                      {t("addedEmails.filterRequested")}
                    </FilterChip>
                    <FilterChip
                      active={filter === "unpaid"}
                      onClick={() => setFilter("unpaid")}
                    >
                      {t("addedEmails.filterUnpaid")}
                    </FilterChip>
                  </>
                )}
              </>
            );
            const searchEl = (
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("addedEmails.searchPlaceholder")}
              />
            );
            return isMobile ? (
              <div
                className="flex"
                style={{ flexDirection: "column", gap: 10, width: "100%" }}
              >
                {searchEl}
                <div className="ae-filter-scroll">{filtersEl}</div>
              </div>
            ) : (
              <div
                className="flex items-center gap-2"
                style={{ flexWrap: "wrap" }}
              >
                {filtersEl}
                {searchEl}
              </div>
            );
          })()}
        </div>

        {/* Tab trạng thái CHÍNH — kiểu GẠCH CHÂN như trang quản trị ChatGPT (yêu cầu
            user 2026-08-24): nhãn phẳng, tab đang xem gạch chân đậm, và MỘT đường kẻ
            chạy hết bề ngang thẻ ở dưới. Dùng lại đúng .tabs-bar/.tab đã có ở đầu
            trang workspace nên hai chỗ trông như một. "Chờ tham gia" bật bộ thao tác
            đồng bộ/thu hồi hàng loạt. */}
        <div className="tabs-bar tabs-bar-inset">
          {(
            [
              {
                key: "active" as const,
                label: t("member.statusActive"),
                count: tabActiveCount,
              },
              {
                key: "pending" as const,
                label: t("member.statusPending"),
                count: tabPendingCount,
              },
              {
                // "Đã xoá" — email đã rời team trong 30 ngày gần nhất (chỉ đọc). Số
                // đếm chỉ hiện khi đã tải xong danh sách: query này lười, chưa vào
                // tab thì chưa gọi → hiện "0" lúc đó là NÓI SAI, không phải "chưa biết".
                key: "removed" as const,
                label: t("member.statusRemoved"),
                count:
                  statusTab === "removed" && !removedLoading
                    ? filtered.length
                    : undefined,
              },
            ] satisfies { key: StatusTab; label: string; count?: number }[]
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={statusTab === tab.key ? "tab active" : "tab"}
              onClick={() => {
                setStatusTab(tab.key);
                setSelected(new Set());
              }}
            >
              {tab.label}
              {typeof tab.count === "number" && (
                <span className="count">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {selectedIds.length > 0 && (
          <div
            className="flex items-center"
            style={{
              gap: 12,
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              background: "var(--surface-2)",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
              {t("addedEmails.selectedCount", { n: selectedIds.length })}
            </span>
            {/* MỘT nút "Thao tác hàng loạt ▾" mở menu đẹp (icon + nhóm), thay cho
                select thô. Item bám tab: "Chờ tham gia" → Đồng bộ + Thu hồi lời mời;
                cả 2 tab → thanh toán + Chuyển chủ nhanh (super-admin). */}
            <RowActionsMenu
              ariaLabel={t("bulkAction.placeholder", { n: selectedIds.length })}
              triggerClassName="btn btn-sm btn-primary"
              trigger={
                <span
                  className="flex items-center"
                  style={{ gap: 7, whiteSpace: "nowrap" }}
                >
                  {bulkBusy
                    ? t("bulkRemove.submitBusy")
                    : t("bulkAction.placeholder", { n: selectedIds.length })}
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              }
              items={bulkMenuItems}
            />
          </div>
        )}

        {statusTab === "removed" ? (
          /* ---------- Tab "Đã xoá": bảng CHỈ ĐỌC riêng (mobile + desktop) ------- */
          <RemovedEmailsList
            rows={filtered}
            isLoading={removedLoading}
            isSuper={isSuper}
            onOpenDetail={setDetailMember}
          />
        ) : isMobile ? (
          /* ---------- Mobile: danh sách THẺ (mỗi email 1 thẻ) ---------- */
          <div className="email-card-list">
            {isLoading && (
              <div
                className="cell-muted"
                style={{ textAlign: "center", padding: 32 }}
              >
                {t("common.loading")}
              </div>
            )}
            {!isLoading && filtered.length === 0 && (
              <div
                className="cell-muted"
                style={{ textAlign: "center", padding: 32 }}
              >
                {t("addedEmails.empty")}
              </div>
            )}
            {filtered.map((m) => (
              <div key={m.id} className="email-card">
                <div className="email-card-top">
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    onChange={() => toggleOne(m.id)}
                    aria-label={m.email}
                  />
                  {/* Click email → modal chi tiết + lịch sử thay đổi. */}
                  <button
                    type="button"
                    className="email-card-email"
                    onClick={() => setDetailMember(m)}
                    title={t("memberDetail.openHint")}
                  >
                    {m.email}
                  </button>
                  {notifyButton(m)}
                  {rowMenu(m)}
                </div>
                <div className="email-card-badges">
                  {m.workspace_name && (
                    <span className="email-card-ws">{m.workspace_name}</span>
                  )}
                  {statusBadge(m)}
                  <PaymentCell
                    m={m}
                    isSuper={isSuper}
                    markPaid={markPaid}
                    payAction={payAction}
                    chargeable={chargeable}
                    t={t}
                    formatDate={formatDate}
                  />
                </div>
                <div className="email-card-dates">
                  <div>
                    <div className="email-card-date-label">
                      {t("addedEmails.colRenewedAt")}
                    </div>
                    <div className="email-card-date-val">{renewedAt(m)}</div>
                  </div>
                  <div>
                    <div className="email-card-date-label">
                      {t("addedEmails.colExpiry")}
                    </div>
                    <div className="email-card-date-val">{expiryAt(m)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* ---------- Desktop: bảng đầy đủ ---------- */
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAll}
                      aria-label={t("addedEmails.selectAll")}
                    />
                  </th>
                  <th>{t("member.colEmail")}</th>
                  <th>{t("member.colName")}</th>
                  <th>{t("addedEmails.colWorkspace")}</th>
                  {isSuper && <th>Người sở hữu</th>}
                  <th>{t("member.colStatus")}</th>
                  <th>{t("addedEmails.colRenewedAt")}</th>
                  <th>{t("addedEmails.colExpiry")}</th>
                  <th>{t("addedEmails.colPayment")}</th>
                  <th style={{ width: 44 }} aria-label={t("common.actions")} />
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td
                      colSpan={isSuper ? 10 : 9}
                      className="cell-muted"
                      style={{ textAlign: "center", padding: 32 }}
                    >
                      {t("common.loading")}
                    </td>
                  </tr>
                )}
                {!isLoading && filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={isSuper ? 10 : 9}
                      className="cell-muted"
                      style={{ textAlign: "center", padding: 32 }}
                    >
                      {t("addedEmails.empty")}
                    </td>
                  </tr>
                )}
                {filtered.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(m.id)}
                        onChange={() => toggleOne(m.id)}
                      />
                    </td>
                    <td className="cell-email">
                      {/* Click email → modal chi tiết + lịch sử thay đổi. */}
                      <button
                        type="button"
                        className="cell-email-link"
                        onClick={() => setDetailMember(m)}
                        title={t("memberDetail.openHint")}
                      >
                        {m.email}
                      </button>
                    </td>
                    <td className="cell-muted">{m.name ?? "—"}</td>
                    <td className="cell-muted" style={{ fontSize: 12 }}>
                      {m.workspace_name ?? "—"}
                    </td>
                    {isSuper && (
                      <td className="cell-muted" style={{ fontSize: 12 }}>
                        {m.invited_by_username ?? "—"}
                      </td>
                    )}
                    <td>{statusBadge(m)}</td>
                    <td className="cell-muted" style={{ fontSize: 12 }}>
                      {renewedAt(m)}
                    </td>
                    <td className="cell-muted" style={{ fontSize: 12 }}>
                      {expiryAt(m)}
                    </td>
                    <td>
                      <PaymentCell
                        m={m}
                        isSuper={isSuper}
                        markPaid={markPaid}
                        payAction={payAction}
                        chargeable={chargeable}
                        t={t}
                        formatDate={formatDate}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div
                        style={{
                          display: "flex",
                          gap: 4,
                          alignItems: "center",
                          justifyContent: "flex-end",
                        }}
                      >
                        {notifyButton(m)}
                        {rowMenu(m)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

type AddedEmailsMutations = ReturnType<typeof useAddedEmails>;

/** Badge trạng thái thanh toán 1 chu kỳ (hoặc member legacy): paid ✓ / requested / unpaid ✗. */
function PaymentBadge({
  status,
  paidAt,
  requestedAt,
  t,
  formatDate,
}: {
  status: "unpaid" | "requested" | "paid";
  paidAt: string | null;
  requestedAt: string | null;
  t: ReturnType<typeof useT>;
  formatDate: ReturnType<typeof useFormatDate>;
}) {
  if (status === "paid")
    return (
      <span
        className="badge badge-success badge-plain"
        title={
          paidAt
            ? t("addedEmails.paidAtTooltip", { time: formatDate(paidAt) })
            : undefined
        }
      >
        ✓ {t("addedEmails.statusPaid")}
      </span>
    );
  if (status === "requested")
    return (
      <span
        className="badge badge-warning badge-plain"
        title={
          requestedAt
            ? t("addedEmails.requestedAtTooltip", {
                time: formatDate(requestedAt),
              })
            : undefined
        }
      >
        {t("addedEmails.statusRequested")}
      </span>
    );
  return (
    <span className="badge badge-danger badge-plain">
      ✗ {t("addedEmails.statusUnpaid")}
    </span>
  );
}

/**
 * Ô "Thanh toán" — gom hiển thị theo số chu kỳ để bảng KHÔNG bị dài khi 1 email có
 * nhiều kỳ (user 2026-07-11: 10 kỳ xếp chồng rất xấu):
 *   - 0 chu kỳ  → badge cấp member (legacy) như cũ.
 *   - 1 chu kỳ  → 1 badge + nút hành động của kỳ đó (gọn 1 dòng).
 *   - ≥2 chu kỳ → TÓM TẮT: chip "đã trả X/N" + nhắc số kỳ cần chú ý + MỘT nút gộp
 *     (sub-admin gửi yêu cầu MỌI kỳ chưa gửi; super-admin xác nhận MỌI kỳ đang chờ).
 * Chi tiết + xử lý RIÊNG LẺ từng kỳ chuyển vào modal Chi tiết thành viên (click email).
 */
function PaymentCell({
  m,
  isSuper,
  markPaid,
  payAction,
  chargeable,
  t,
  formatDate,
}: {
  m: AddedMember;
  isSuper: boolean;
  markPaid: AddedEmailsMutations["markPaid"];
  /** Nút "Thanh toán" của đại lý: trả thật (ví Ví) hoặc gửi yêu cầu duyệt. */
  payAction: { isPending: boolean; run: (v: { ids?: string[]; cycleIds?: string[] }) => void };
  /** Đại lý đã bật Ví → bấm là trừ tiền thật, trả được cả kỳ đã lỡ gửi yêu cầu. */
  chargeable: boolean;
  t: ReturnType<typeof useT>;
  formatDate: ReturnType<typeof useFormatDate>;
}) {
  const cycles: SubscriptionCycle[] = m.cycles ?? [];
  const busy = markPaid.isPending || payAction.isPending;
  // Kỳ nào đại lý còn bấm được: trả tiền thật thì cả kỳ đang chờ duyệt cũng trả được
  // (khỏi phải rút yêu cầu trước); gửi yêu cầu thì chỉ kỳ chưa gửi.
  const payable = (status: string) =>
    chargeable ? status !== "paid" : status === "unpaid";

  // Member chưa có chu kỳ nào (mời sau migration, chưa từng gia hạn): dùng trạng
  // thái thanh toán CẤP MEMBER + nút inline theo member_ids (giống nút bulk-select
  // vốn đã chạy cho nhóm này) → nhất quán với hàng có chu kỳ, khỏi phải tick chọn.
  if (cycles.length === 0) {
    return (
      <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
        <PaymentBadge
          status={m.payment_status}
          paidAt={m.paid_at}
          requestedAt={m.payment_requested_at}
          t={t}
          formatDate={formatDate}
        />
        {isSuper
          ? m.payment_status === "requested" && (
              <button
                className="btn btn-sm btn-primary"
                style={{ padding: "0 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() => markPaid.mutate({ ids: [m.id], paid: true })}
              >
                {t("addedEmails.confirmShort")}
              </button>
            )
          : payable(m.payment_status) && (
              <button
                className="btn btn-sm btn-primary"
                style={{ padding: "0 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() => payAction.run({ ids: [m.id] })}
              >
                {t("addedEmails.requestShort")}
              </button>
            )}
      </div>
    );
  }

  // Một chu kỳ: badge + hành động của kỳ đó trên 1 dòng (giữ như cũ).
  if (cycles.length === 1) {
    const c = cycles[0];
    return (
      <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
        <PaymentBadge
          status={c.payment_status}
          paidAt={c.paid_at}
          requestedAt={c.payment_requested_at}
          t={t}
          formatDate={formatDate}
        />
        {isSuper
          ? c.payment_status === "requested" && (
              <button
                className="btn btn-sm btn-primary"
                style={{ padding: "0 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() => markPaid.mutate({ cycleIds: [c.id], paid: true })}
              >
                {t("addedEmails.confirmShort")}
              </button>
            )
          : payable(c.payment_status) && (
              <button
                className="btn btn-sm btn-primary"
                style={{ padding: "0 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() => payAction.run({ cycleIds: [c.id] })}
              >
                {t("addedEmails.requestShort")}
              </button>
            )}
      </div>
    );
  }

  // ≥2 chu kỳ: TÓM TẮT gọn. Đếm theo trạng thái để hiện "đã trả X/N" + nút gộp.
  const paid = cycles.filter((c) => c.payment_status === "paid");
  const requested = cycles.filter((c) => c.payment_status === "requested");
  const unpaid = cycles.filter((c) => c.payment_status === "unpaid");
  const total = cycles.length;
  const allPaid = paid.length === total;
  // Nút gộp bám vai trò: sub-admin gửi yêu cầu mọi kỳ CHƯA gửi; super-admin xác nhận
  // mọi kỳ ĐANG CHỜ. Chỉ 1 nút để bảng gọn (xử lý lẻ từng kỳ ở modal).
  const actionable = isSuper ? requested : cycles.filter((c) => payable(c.payment_status));

  return (
    <div
      style={{ display: "grid", gap: 4 }}
      title={t("addedEmails.cyclesDetailHint")}
    >
      <span
        className={
          allPaid ? "badge badge-success badge-plain" : "badge badge-neutral badge-plain"
        }
        style={{ fontVariantNumeric: "tabular-nums", width: "fit-content" }}
      >
        {allPaid
          ? t("addedEmails.cyclesAllPaid", { n: total })
          : t("addedEmails.cyclesPaidCount", { paid: paid.length, total })}
      </span>
      {!allPaid && (
        <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
          {/* Số kỳ cần chú ý theo vai trò: super-admin → chờ xác nhận; sub-admin →
              chưa gửi. Nếu không còn kỳ để mình xử lý, hiện phần còn lại dạng mờ. */}
          {isSuper ? (
            requested.length > 0 ? (
              <span style={{ fontSize: 11, color: "var(--warning)", fontWeight: 600 }}>
                {t("addedEmails.cyclesToConfirmHint", { n: requested.length })}
              </span>
            ) : (
              unpaid.length > 0 && (
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {t("addedEmails.cyclesUnpaidHint", { n: unpaid.length })}
                </span>
              )
            )
          ) : unpaid.length > 0 ? (
            <span style={{ fontSize: 11, color: "var(--warning)", fontWeight: 600 }}>
              {t("addedEmails.cyclesUnpaidHint", { n: unpaid.length })}
            </span>
          ) : (
            requested.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {t("addedEmails.cyclesRequestedHint", { n: requested.length })}
              </span>
            )
          )}
          {actionable.length > 0 && (
            <button
              className="btn btn-sm btn-primary"
              style={{ padding: "0 8px", fontSize: 11 }}
              disabled={busy}
              onClick={() =>
                isSuper
                  ? markPaid.mutate({
                      cycleIds: actionable.map((c) => c.id),
                      paid: true,
                    })
                  : payAction.run({ cycleIds: actionable.map((c) => c.id) })
              }
            >
              {isSuper
                ? t("addedEmails.confirmNShort", { n: actionable.length })
                : t("addedEmails.requestNShort", { n: actionable.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={active ? "btn btn-sm btn-primary" : "btn btn-sm btn-ghost"}
    >
      {children}
    </button>
  );
}
