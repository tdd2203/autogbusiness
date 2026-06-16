import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useAddedEmails } from "../hooks/useAddedEmails";
import { useFormatDate, useT } from "../i18n";
import type { AddedMember } from "../types";
import { SearchInput } from "./Members";

type SubAccount = {
  id: string;
  email: string;
  username: string;
  is_super_admin: boolean;
};

type PaymentFilter = "all" | "today" | "unpaid";

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

export default function AddedEmails() {
  const t = useT();
  const formatDate = useFormatDate();
  const { user } = useAuth();
  const isSuper = user?.is_super_admin === true;

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PaymentFilter>("all");
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { markPaid, transferOwner } = useAddedEmails({
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

  const filtered = useMemo(() => {
    let rows = members;
    if (filter === "today") rows = rows.filter((m) => isToday(m.created_at));
    else if (filter === "unpaid")
      rows = rows.filter((m) => m.payment_status !== "paid");
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
  }, [members, filter, search]);

  const total = members.length;
  const paidCount = members.filter((m) => m.payment_status === "paid").length;
  const unpaidCount = total - paidCount;

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
      </div>

      <div className="metrics" style={{ marginBottom: 24 }}>
        <Metric label={t("addedEmails.metricTotal")} value={total} />
        <Metric label={t("addedEmails.metricPaid")} value={paidCount} />
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
                {subAccounts.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
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
            <button
              className="btn btn-sm btn-primary"
              disabled={markPaid.isPending}
              onClick={() =>
                markPaid.mutate({ ids: selectedIds, paid: true })
              }
            >
              {t("addedEmails.approvePayment")}
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
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setSelected(new Set())}
            >
              {t("addedEmails.clearSelection")}
            </button>
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
                <th>{t("addedEmails.colAddedAt")}</th>
                <th>{t("addedEmails.colPayment")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td
                    colSpan={isSuper ? 8 : 7}
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
                    colSpan={isSuper ? 8 : 7}
                    className="cell-muted"
                    style={{ textAlign: "center", padding: 32 }}
                  >
                    {t("addedEmails.empty")}
                  </td>
                </tr>
              )}
              {filtered.map((m) => {
                const paid = m.payment_status === "paid";
                return (
                  <tr key={m.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(m.id)}
                        onChange={() => toggleOne(m.id)}
                      />
                    </td>
                    <td className="cell-email">{m.email}</td>
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
                    <td className="cell-muted" style={{ fontSize: 12 }}>
                      {formatDate(m.created_at)}
                    </td>
                    <td>
                      {paid ? (
                        <span
                          className="badge badge-success"
                          title={
                            m.paid_at
                              ? t("addedEmails.paidAtTooltip", {
                                  time: formatDate(m.paid_at),
                                })
                              : undefined
                          }
                        >
                          ✓ {t("addedEmails.statusPaid")}
                        </span>
                      ) : (
                        <span className="badge badge-neutral">
                          {t("addedEmails.statusUnpaid")}
                        </span>
                      )}
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
