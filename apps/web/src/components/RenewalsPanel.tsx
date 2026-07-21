import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useFormatDateTime, useT } from "../i18n";
import type { AddedMember, Member } from "../types";
import { toast } from "./Toast";
import { MemberDetailModal } from "./MemberDetailModal";
import { ChangeSubscriptionModal } from "./ChangeSubscriptionModal";
import { SearchInput } from "../pages/Members";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";

// Cột ngày hiển thị tới giây, khớp bảng Thành viên (Members.tsx / AddedEmails.tsx).
const PRECISE_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 30;

/** Hạn tiếp theo (cộng dồn, khớp BE): còn hạn → hạn cũ + tháng×30; hết hạn → bây giờ + tháng×30. */
function nextEndAfterRenew(member: Member, months: number): Date {
  const now = Date.now();
  const end = member.subscription_end_at
    ? new Date(member.subscription_end_at).getTime()
    : 0;
  const base = end > now ? end : now;
  return new Date(base + months * MONTH_DAYS * DAY_MS);
}

/** "DD/MM/YYYY - HH:MM:SS" — giống fmtRenewExpiry ở Members.tsx. */
function fmtRenewExpiry(
  formatDateTime: ReturnType<typeof useFormatDateTime>,
  value: string | Date,
): string {
  return formatDateTime(value, undefined, PRECISE_TIME).replace(" ", " - ");
}

/** Điều kiện "cần gia hạn": còn active/pending + đã hết hạn HOẶC ≤7 ngày. */
export function isRenewalDue(m: Member): boolean {
  if (m.status !== "active" && m.status !== "pending") return false;
  if (m.subscription_end_at == null) return false;
  const end = new Date(m.subscription_end_at).getTime();
  const now = Date.now();
  return end <= now || end - now <= SEVEN_DAYS_MS;
}

/**
 * Panel "Gia hạn" — gom thành viên SẮP hết hạn (≤7 ngày, còn hiệu lực) và ĐÃ hết hạn
 * (đang chờ scheduler nền tự xoá) thành MỘT danh sách để gia hạn tập trung.
 *
 * Trước đây là trang riêng theo workspace (pages/WorkspaceRenewals.tsx); nay nhận
 * `members` (AddedMember, gom XUYÊN workspace) từ trang "Email đã add" và gia hạn
 * TỪNG DÒNG theo workspace_id của chính nó → không cần :workspaceId route param.
 *
 * KHÔNG tự xoá ở đây: thành viên hết hạn được scheduler nền tự enqueue REMOVE_MEMBER
 * (apps/api/app/main.py, ân hạn ~1 giờ). Gia hạn = CỘNG DỒN (POST .../renew, tự phục
 * vụ, KHÔNG cần duyệt): chỉ gửi số tháng → BE cộng vào hạn hiện tại (còn hạn) hoặc từ
 * bây giờ (đã hết hạn). Xong invalidate ["added-members"]/["members"] → list tự cập nhật.
 */
export function RenewalsPanel({ members }: { members: AddedMember[] }) {
  const t = useT();
  const formatDateTime = useFormatDateTime();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  // Cột "Người sở hữu" chỉ hiện cho admin tổng; sub-admin chỉ thấy email mình add nên không cần.
  const isSuper = user?.is_super_admin === true;

  const [detailMember, setDetailMember] = useState<AddedMember | null>(null);
  const [renewMember, setRenewMember] = useState<AddedMember | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMonths, setBulkMonths] = useState(1);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [search, setSearch] = useState("");

  // Gộp SẮP + ĐÃ hết hạn thành 1 danh sách; đã hết hạn (khẩn nhất) lên trước, rồi
  // tới hạn gần nhất. Không chia section.
  const baseRows = useMemo(() => {
    const list = members.filter(isRenewalDue);
    return list.sort(
      (a, b) =>
        new Date(a.subscription_end_at as string).getTime() -
        new Date(b.subscription_end_at as string).getTime(),
    );
  }, [members]);

  // Lọc theo ô tìm kiếm (email hoặc tên). Tách khỏi baseRows để ô tìm kiếm vẫn
  // hiển thị (và xoá được) khi không có kết quả khớp.
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return baseRows;
    return baseRows.filter(
      (m) =>
        m.email.toLowerCase().includes(s) ||
        (m.name ?? "").toLowerCase().includes(s),
    );
  }, [baseRows, search]);

  const selectedCount = rows.filter((m) => selectedIds.has(m.id)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(rows.map((m) => m.id)));

  // Gia hạn HÀNG LOẠT: lặp endpoint per-member (POST .../renew) theo workspace_id
  // của TỪNG dòng (danh sách gom xuyên workspace) — chỉ gửi số tháng → BE cộng dồn
  // + tạo chu kỳ mới + reset 'chưa thanh toán'. Gia hạn là TỰ PHỤC VỤ (áp NGAY,
  // KHÔNG cần duyệt — kể cả sub-admin). Gom 1 toast tổng kết thay vì N toast.
  const bulkRenew = useMutation({
    mutationFn: async (vars: { rows: AddedMember[]; months: number }) => {
      const results = await Promise.allSettled(
        vars.rows.map((m) =>
          api(
            `/api/v1/workspaces/${m.workspace_id}/members/${m.id}/renew`,
            {
              method: "POST",
              body: JSON.stringify({ months: vars.months }),
            },
          ),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, fail: results.length - ok };
    },
    onSuccess: ({ ok, fail }) => {
      const base = t("renewals.bulkResultOk", { n: ok });
      toast.success(
        fail > 0 ? `${base} ${t("renewals.bulkResultPartial", { n: fail })}` : base,
      );
      setSelectedIds(new Set());
      setShowBulkConfirm(false);
      qc.invalidateQueries({ queryKey: ["added-members"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-logs"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // Danh sách thành viên đã chọn (giữ thứ tự bảng) — dùng cho popup preview.
  const selectedRows = useMemo(
    () => rows.filter((m) => selectedIds.has(m.id)),
    [rows, selectedIds],
  );

  return (
    <div>
      {/* Ghi chú luật tự xoá — để admin hiểu thành viên hết hạn sẽ tự bị gỡ. */}
      <div className="notice" style={{ marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="notice-body">{t("renewals.autoRemoveNote")}</div>
        </div>
      </div>

      {baseRows.length === 0 ? (
        <div className="surface-card" style={{ padding: 32, textAlign: "center" }}>
          <div className="cell-muted">{t("renewals.empty")}</div>
        </div>
      ) : (
        <div className="table-card renewals-card">
          <div className="table-head">
            <div className="table-title">
              {t("renewals.countLabel", { n: rows.length })}
            </div>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("renewals.searchPlaceholder")}
            />
            {/* Thanh gia hạn hàng loạt — hiện khi đã chọn ≥1 dòng. */}
            {selectedCount > 0 && (
              <div
                className="flex items-center"
                style={{ gap: 8, flexWrap: "wrap" }}
              >
                <span className="cell-muted" style={{ fontSize: 13 }}>
                  {t("renewals.selectedCount", { n: selectedCount })}
                </span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={bulkMonths}
                  onChange={(e) => setBulkMonths(Number(e.target.value))}
                  className="form-input"
                  style={{ width: 64, padding: "6px 8px", fontSize: 13 }}
                  title={t("renewals.monthsUnit")}
                />
                <span className="cell-muted" style={{ fontSize: 13 }}>
                  {t("renewals.monthsUnit")}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowBulkConfirm(true)}
                  disabled={bulkRenew.isPending || bulkMonths < 1}
                >
                  {t("renewals.bulkRenewBtn", { n: selectedCount })}
                </button>
              </div>
            )}
          </div>
          {isMobile ? (
            /* ---------- Mobile: danh sách THẺ (mỗi email 1 thẻ) ---------- */
            <div className="email-card-list">
              {rows.length === 0 ? (
                <div
                  className="cell-muted"
                  style={{ textAlign: "center", padding: 32 }}
                >
                  {t("renewals.searchEmpty")}
                </div>
              ) : (
                rows.map((m) => (
                  <RenewalCard
                    key={m.id}
                    member={m}
                    checked={selectedIds.has(m.id)}
                    onToggle={() => toggle(m.id)}
                    isSuper={isSuper}
                    t={t}
                    formatDateTime={formatDateTime}
                    onOpenDetail={setDetailMember}
                    onRenew={setRenewMember}
                  />
                ))
              )}
            </div>
          ) : (
            /* ---------- Desktop: bảng đầy đủ ---------- */
            <div style={{ overflowX: "auto" }}>
              <table className="data-table data-table-compact">
                <thead>
                  <tr>
                    <th style={{ width: 40, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label={t("renewals.selectAll")}
                      />
                    </th>
                    <th>{t("member.colEmail")}</th>
                    {isSuper && <th>Người sở hữu</th>}
                    <th>{t("addedEmails.colRenewedAt")}</th>
                    <th>{t("addedEmails.colExpiry")}</th>
                    <th>{t("renewals.colRemaining")}</th>
                    <th style={{ textAlign: "right" }}>{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={isSuper ? 7 : 6}
                        className="cell-muted"
                        style={{ textAlign: "center", padding: "24px 0" }}
                      >
                        {t("renewals.searchEmpty")}
                      </td>
                    </tr>
                  ) : (
                    rows.map((m) => (
                      <RenewalRow
                        key={m.id}
                        member={m}
                        checked={selectedIds.has(m.id)}
                        onToggle={() => toggle(m.id)}
                        isSuper={isSuper}
                        t={t}
                        formatDateTime={formatDateTime}
                        onOpenDetail={setDetailMember}
                        onRenew={setRenewMember}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Popup xác nhận gia hạn hàng loạt — preview email | hạn hiện tại | hạn tiếp theo. */}
      {showBulkConfirm && selectedRows.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          style={{ padding: 16 }}
        >
          <div
            className="bg-white rounded-lg shadow-xl"
            style={{ width: "100%", maxWidth: 640, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
          >
            <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--border)" }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                {t("renewals.renewBtn")}
              </h3>
              <div className="cell-muted" style={{ fontSize: 13, marginTop: 4 }}>
                {t("renewals.bulkConfirm", {
                  n: selectedRows.length,
                  months: bulkMonths,
                })}
              </div>
            </div>
            <div style={{ overflow: "auto", padding: "0 4px" }}>
              {isMobile ? (
                /* Mobile: mỗi email 1 thẻ — email trên, "hạn cũ → hạn mới" xuống
                   dòng, tránh 2 cột ngày mono chật cứng khi màn hẹp. */
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {selectedRows.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                        padding: "12px 16px",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <div
                        className="cell-email"
                        style={{ fontWeight: 600, wordBreak: "break-all" }}
                      >
                        {m.email}
                      </div>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontFamily: "var(--font-mono)",
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span className="cell-muted">
                          {fmtRenewExpiry(
                            formatDateTime,
                            m.subscription_end_at as string,
                          )}
                        </span>
                        <span className="cell-muted">→</span>
                        <span
                          style={{ color: "var(--success)", fontWeight: 600 }}
                        >
                          {fmtRenewExpiry(
                            formatDateTime,
                            nextEndAfterRenew(m, bulkMonths),
                          )}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                /* table-layout:fixed → cột cố định, email dài cắt gọn (…), 2 cột
                   ngày luôn hiện đủ, không tràn ngang. */
                <table
                  className="data-table data-table-compact"
                  style={{ tableLayout: "fixed", width: "100%" }}
                >
                  <thead>
                    <tr>
                      <th style={{ width: "44%" }}>{t("member.colEmail")}</th>
                      <th style={{ width: "28%" }}>{t("renewals.currentExpiry")}</th>
                      <th style={{ width: "28%" }}>{t("renewals.nextExpiry")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRows.map((m) => (
                      <tr key={m.id}>
                        <td
                          className="cell-email"
                          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                          title={m.email}
                        >
                          {m.email}
                        </td>
                        <td style={{ fontSize: 13, fontFamily: "var(--font-mono)" }}>
                          {fmtRenewExpiry(
                            formatDateTime,
                            m.subscription_end_at as string,
                          )}
                        </td>
                        <td
                          style={{
                            fontSize: 13,
                            fontFamily: "var(--font-mono)",
                            color: "var(--success)",
                            fontWeight: 600,
                          }}
                        >
                          {fmtRenewExpiry(
                            formatDateTime,
                            nextEndAfterRenew(m, bulkMonths),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid var(--border)",
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowBulkConfirm(false)}
                disabled={bulkRenew.isPending}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  bulkRenew.mutate({ rows: selectedRows, months: bulkMonths })
                }
                disabled={bulkRenew.isPending || bulkMonths < 1}
              >
                {bulkRenew.isPending
                  ? t("common.loading")
                  : t("renewals.bulkRenewBtn", { n: selectedRows.length })}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailMember && (
        <MemberDetailModal
          workspaceId={detailMember.workspace_id}
          member={members.find((m) => m.id === detailMember.id) ?? detailMember}
          onClose={() => setDetailMember(null)}
        />
      )}
      {renewMember && (
        <ChangeSubscriptionModal
          workspaceId={renewMember.workspace_id}
          member={members.find((m) => m.id === renewMember.id) ?? renewMember}
          onClose={() => setRenewMember(null)}
          renew
        />
      )}
    </div>
  );
}

function RenewalRow({
  member,
  checked,
  onToggle,
  isSuper,
  t,
  formatDateTime,
  onOpenDetail,
  onRenew,
}: {
  member: AddedMember;
  checked: boolean;
  onToggle: () => void;
  isSuper: boolean;
  t: ReturnType<typeof useT>;
  formatDateTime: ReturnType<typeof useFormatDateTime>;
  onOpenDetail: (m: AddedMember) => void;
  onRenew: (m: AddedMember) => void;
}) {
  const endMs = new Date(member.subscription_end_at as string).getTime();
  const diffDays = Math.round((endMs - Date.now()) / DAY_MS);
  const expired = diffDays <= 0;
  // Màu khẩn: đã hết hạn / <3 ngày → đỏ; <7 ngày → vàng; còn xa → xám.
  const color = expired || diffDays < 3
    ? "var(--danger)"
    : diffDays < 7
      ? "var(--warning)"
      : "var(--ink-3)";
  const remainingLabel = expired
    ? t("member.subExpired", { n: -diffDays })
    : `(${t("member.subDaysLeftShort", { n: diffDays })})`;
  const renewAnchor =
    member.subscription_purchased_at ??
    member.last_invited_at ??
    member.created_at;

  return (
    <tr>
      <td style={{ textAlign: "center" }}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </td>
      <td className="cell-email">
        <button
          type="button"
          className="cell-email-link"
          onClick={() => onOpenDetail(member)}
          title={t("memberDetail.openHint")}
        >
          {member.email}
        </button>
      </td>
      {isSuper && (
        <td className="cell-muted" style={{ fontSize: 12 }}>
          {member.invited_by_username ?? "—"}
        </td>
      )}
      <td className="cell-muted" style={{ fontSize: 13.5 }}>
        {fmtRenewExpiry(formatDateTime, renewAnchor)}
      </td>
      <td style={{ fontSize: 13.5, fontFamily: "var(--font-mono)" }}>
        {fmtRenewExpiry(formatDateTime, member.subscription_end_at as string)}
      </td>
      <td style={{ fontSize: 13.5, color, fontWeight: 600 }}>
        {remainingLabel}
      </td>
      <td style={{ textAlign: "right" }}>
        <button
          type="button"
          className="row-action"
          onClick={() => onRenew(member)}
          title={t("renewals.renewBtn")}
        >
          {t("renewals.renewBtn")}
        </button>
      </td>
    </tr>
  );
}

/** Thẻ gia hạn cho mobile — thay hàng bảng khi màn hẹp (không cuộn ngang 7 cột). */
function RenewalCard({
  member,
  checked,
  onToggle,
  isSuper,
  t,
  formatDateTime,
  onOpenDetail,
  onRenew,
}: {
  member: AddedMember;
  checked: boolean;
  onToggle: () => void;
  isSuper: boolean;
  t: ReturnType<typeof useT>;
  formatDateTime: ReturnType<typeof useFormatDateTime>;
  onOpenDetail: (m: AddedMember) => void;
  onRenew: (m: AddedMember) => void;
}) {
  const endMs = new Date(member.subscription_end_at as string).getTime();
  const diffDays = Math.round((endMs - Date.now()) / DAY_MS);
  const expired = diffDays <= 0;
  const color =
    expired || diffDays < 3
      ? "var(--danger)"
      : diffDays < 7
        ? "var(--warning)"
        : "var(--ink-3)";
  const remainingLabel = expired
    ? t("member.subExpired", { n: -diffDays })
    : `(${t("member.subDaysLeftShort", { n: diffDays })})`;
  const renewAnchor =
    member.subscription_purchased_at ??
    member.last_invited_at ??
    member.created_at;

  return (
    <div className="email-card">
      <div className="email-card-top">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={member.email}
        />
        <button
          type="button"
          className="email-card-email"
          onClick={() => onOpenDetail(member)}
          title={t("memberDetail.openHint")}
        >
          {member.email}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onRenew(member)}
        >
          {t("renewals.renewBtn")}
        </button>
      </div>
      <div className="email-card-badges">
        <span style={{ fontSize: 12.5, color, fontWeight: 600 }}>
          {remainingLabel}
        </span>
        {isSuper && member.invited_by_username && (
          <span className="email-card-ws">{member.invited_by_username}</span>
        )}
      </div>
      <div className="email-card-dates">
        <div>
          <div className="email-card-date-label">
            {t("addedEmails.colRenewedAt")}
          </div>
          <div className="email-card-date-val">
            {fmtRenewExpiry(formatDateTime, renewAnchor)}
          </div>
        </div>
        <div>
          <div className="email-card-date-label">
            {t("addedEmails.colExpiry")}
          </div>
          <div className="email-card-date-val">
            {fmtRenewExpiry(formatDateTime, member.subscription_end_at as string)}
          </div>
        </div>
      </div>
    </div>
  );
}
