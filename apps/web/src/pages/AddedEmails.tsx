import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useAddedEmails } from "../hooks/useAddedEmails";
import { useFormatDate, useFormatDateTime, useT } from "../i18n";
import type { AddedMember, SubscriptionCycle } from "../types";
import { SearchInput } from "./Members";
import { BulkUpdateExpiryModal } from "../components/BulkUpdateExpiryModal";
import { MemberDetailModal } from "../components/MemberDetailModal";

type SubAccount = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
};

type PaymentFilter = "all" | "today" | "unpaid" | "requested";

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

export default function AddedEmails() {
  const t = useT();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const { user } = useAuth();
  const isSuper = user?.is_super_admin === true;

  // Khởi tạo filter từ ?filter= (chuông thông báo mở thẳng "Chờ xác nhận").
  const [searchParams] = useSearchParams();
  const initialFilter: PaymentFilter =
    searchParams.get("filter") === "requested" ? "requested" : "all";

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PaymentFilter>(initialFilter);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkExpiry, setShowBulkExpiry] = useState(false);
  // Click email → mở modal chi tiết + lịch sử hoạt động của email đó.
  const [detailMember, setDetailMember] = useState<AddedMember | null>(null);

  const { requestPayment, markPaid, transferOwner } = useAddedEmails({
    onCleared: () => setSelected(new Set()),
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
  });

  // Workspace có mặt trong danh sách hiện tại → đổ vào dropdown lọc riêng.
  const workspaces = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      if (m.workspace_id)
        map.set(m.workspace_id, m.workspace_name ?? m.workspace_id);
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [members]);

  const filtered = useMemo(() => {
    let rows = members;
    if (selectedWorkspace)
      rows = rows.filter((m) => m.workspace_id === selectedWorkspace);
    // "Ngày thêm" = last_invited_at ?? created_at (xem Members.tsx): re-invite
    // giữ created_at cũ → filter "hôm nay" theo last_invited_at mới để email
    // vừa mời lại hôm nay không bị loại oan.
    if (filter === "today")
      rows = rows.filter((m) => isToday(m.last_invited_at ?? m.created_at));
    else if (filter === "unpaid")
      rows = rows.filter((m) => m.payment_status === "unpaid");
    else if (filter === "requested")
      rows = rows.filter((m) => m.payment_status === "requested");
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
  }, [members, filter, search, selectedWorkspace]);

  const total = members.length;
  const paidCount = members.filter((m) => m.payment_status === "paid").length;
  const requestedCount = members.filter(
    (m) => m.payment_status === "requested",
  ).length;
  const unpaidCount = members.filter(
    (m) => m.payment_status === "unpaid",
  ).length;

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

  return (
    <div className="page-fade">
      <div
        className="flex items-start justify-between"
        style={{ gap: 24, marginBottom: 32, flexWrap: "wrap" }}
      >
        <div>
          <div className="breadcrumb">{t("nav.addedEmails")}</div>
          <h1 className="display-h1">{t("addedEmails.title")}</h1>
          <p className="page-sub">{t("addedEmails.subtitle")}</p>
        </div>
        {/* Super-admin: áp ngay. Sub-admin: gửi yêu cầu đổi hạn chờ super-admin duyệt. */}
        <button
          className="btn btn-primary"
          onClick={() => setShowBulkExpiry(true)}
        >
          {t("bulkExpiry.openBtn")}
        </button>
      </div>

      {showBulkExpiry && (
        <BulkUpdateExpiryModal
          members={members}
          isSuper={isSuper}
          onClose={() => setShowBulkExpiry(false)}
          onDone={() => setSelected(new Set())}
        />
      )}

      {/* Chi tiết + lịch sử thay đổi của 1 email (AddedMember ⊇ Member nên
          truyền thẳng vào MemberDetailModal; endpoint logs theo workspace_id). */}
      {detailMember && (
        <MemberDetailModal
          workspaceId={detailMember.workspace_id}
          member={detailMember}
          onClose={() => setDetailMember(null)}
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
          value={requestedCount}
        />
        <Metric label={t("addedEmails.metricUnpaid")} value={unpaidCount} />
      </div>

      <div className="table-card">
        <div className="table-head">
          <div>
            <div className="table-title">{t("addedEmails.listTitle")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("addedEmails.countLabel", { n: filtered.length })}
            </div>
          </div>
          <div
            className="flex items-center gap-2"
            style={{ flexWrap: "wrap" }}
          >
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
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("addedEmails.searchPlaceholder")}
            />
          </div>
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
            {isSuper ? (
              <>
                {/* Bước 2 — super-admin xác nhận / huỷ thanh toán. */}
                <button
                  className="btn btn-sm btn-primary"
                  disabled={markPaid.isPending}
                  onClick={() =>
                    markPaid.mutate({ ids: selectedIds, paid: true })
                  }
                >
                  {t("addedEmails.confirmPayment")}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={markPaid.isPending}
                  onClick={() =>
                    markPaid.mutate({ ids: selectedIds, paid: false })
                  }
                >
                  {t("addedEmails.unmarkPayment")}
                </button>
              </>
            ) : (
              <>
                {/* Bước 1 — sub-admin gửi yêu cầu duyệt thanh toán. */}
                <button
                  className="btn btn-sm btn-primary"
                  disabled={requestPayment.isPending}
                  onClick={() =>
                    requestPayment.mutate({
                      ids: selectedIds,
                      requested: true,
                    })
                  }
                >
                  {t("addedEmails.requestPayment")}
                </button>
              </>
            )}
            {isSuper && (
              <>
                <span
                  style={{
                    width: 1,
                    height: 20,
                    background: "var(--border)",
                    margin: "0 4px",
                  }}
                />
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={transferOwner.isPending}
                  onClick={() =>
                    user &&
                    transferOwner.mutate({
                      ids: selectedIds,
                      targetUserId: user.id,
                    })
                  }
                  title="Đưa quyền sở hữu các email đã chọn về admin"
                >
                  Thu hồi về admin
                </button>
                <select
                  value=""
                  disabled={transferOwner.isPending}
                  onChange={(e) => {
                    if (e.target.value) {
                      transferOwner.mutate({
                        ids: selectedIds,
                        targetUserId: e.target.value,
                      });
                      e.target.value = "";
                    }
                  }}
                  className="form-input"
                  style={{ padding: "6px 10px", fontSize: 13, width: "auto" }}
                >
                  <option value="">Chuyển cho…</option>
                  {user && <option value={user.id}>Admin (bạn)</option>}
                  {subAccounts.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}

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
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td
                    colSpan={isSuper ? 9 : 8}
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
                    colSpan={isSuper ? 9 : 8}
                    className="cell-muted"
                    style={{ textAlign: "center", padding: 32 }}
                  >
                    {t("addedEmails.empty")}
                  </td>
                </tr>
              )}
              {filtered.map((m) => {
                return (
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
                    <td>
                      <span
                        className={
                          STATUS_BADGE[m.status] ?? "badge badge-neutral"
                        }
                      >
                        {t(
                          `member.status${m.status
                            .charAt(0)
                            .toUpperCase()}${m.status.slice(1)}`,
                        )}
                      </span>
                    </td>
                    {/* Ngày gia hạn = mốc neo subscription_purchased_at (fallback
                        last_invited_at ?? created_at cho row legacy) → khớp "Ngày hết
                        hạn" = mốc + 30. */}
                    <td className="cell-muted" style={{ fontSize: 12 }}>
                      {formatDateTime(
                        m.subscription_purchased_at ??
                          m.last_invited_at ??
                          m.created_at,
                        undefined,
                        PRECISE_TIME,
                      )}
                    </td>
                    <td className="cell-muted" style={{ fontSize: 12 }}>
                      {m.subscription_end_at
                        ? formatDateTime(
                            m.subscription_end_at,
                            undefined,
                            PRECISE_TIME,
                          )
                        : t("addedEmails.expiryNone")}
                    </td>
                    <td>
                      <PaymentCell
                        m={m}
                        isSuper={isSuper}
                        markPaid={markPaid}
                        requestPayment={requestPayment}
                        t={t}
                        formatDate={formatDate}
                      />
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
 * Ô "Thanh toán" — hiển thị theo TỪNG CHU KỲ (yêu cầu user 2026-07-08). Mỗi chu kỳ
 * có trạng thái + hành động riêng: super-admin xác nhận/huỷ, sub-admin gửi yêu cầu.
 * Member CHƯA gia hạn lần nào (cycles rỗng) → hiện badge cấp member (legacy) như cũ.
 */
function PaymentCell({
  m,
  isSuper,
  markPaid,
  requestPayment,
  t,
  formatDate,
}: {
  m: AddedMember;
  isSuper: boolean;
  markPaid: AddedEmailsMutations["markPaid"];
  requestPayment: AddedEmailsMutations["requestPayment"];
  t: ReturnType<typeof useT>;
  formatDate: ReturnType<typeof useFormatDate>;
}) {
  const cycles: SubscriptionCycle[] = m.cycles ?? [];
  if (cycles.length === 0) {
    return (
      <PaymentBadge
        status={m.payment_status}
        paidAt={m.paid_at}
        requestedAt={m.payment_requested_at}
        t={t}
        formatDate={formatDate}
      />
    );
  }
  const busy = markPaid.isPending || requestPayment.isPending;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {cycles.map((c) => (
        <div
          key={c.id}
          className="flex items-center"
          style={{ gap: 6, flexWrap: "wrap" }}
        >
          <span
            className="cell-muted"
            style={{ fontSize: 11, minWidth: 34, fontVariantNumeric: "tabular-nums" }}
          >
            {t("addedEmails.cycleLabel", { n: c.cycle_number })}
          </span>
          <PaymentBadge
            status={c.payment_status}
            paidAt={c.paid_at}
            requestedAt={c.payment_requested_at}
            t={t}
            formatDate={formatDate}
          />
          {isSuper ? (
            c.payment_status === "paid" ? (
              <button
                className="btn btn-sm btn-ghost"
                style={{ padding: "0 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() => markPaid.mutate({ cycleIds: [c.id], paid: false })}
              >
                {t("addedEmails.unmarkShort")}
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                style={{ padding: "0 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() => markPaid.mutate({ cycleIds: [c.id], paid: true })}
              >
                {t("addedEmails.confirmShort")}
              </button>
            )
          ) : (
            c.payment_status === "unpaid" && (
              <button
                className="btn btn-sm btn-primary"
                style={{ padding: "0 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() =>
                  requestPayment.mutate({ cycleIds: [c.id], requested: true })
                }
              >
                {t("addedEmails.requestShort")}
              </button>
            )
          )}
        </div>
      ))}
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
