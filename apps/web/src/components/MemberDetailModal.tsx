/**
 * Modal "Chi tiết thành viên" — mở khi click vào email ở bảng Danh sách thành viên.
 *
 * Hiển thị 2 phần:
 *   1. Thông tin hiện tại của member (vai trò, trạng thái, hạn dùng, giấy phép,
 *      giới hạn tín dụng, thanh toán, mốc thời gian).
 *   2. Timeline LỊCH SỬ HOẠT ĐỘNG — mọi sự kiện audit liên quan email đó, lấy từ
 *      GET /workspaces/{id}/members/{memberId}/logs (xem members/activity.md).
 *
 * Query-only; không sửa gì. Xem MemberDetailModal.md TRƯỚC KHI SỬA.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { LICENSE_FEATURE_ENABLED } from "../lib/featureFlags";
import { useFormatDateTime, useT } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { useCorrectAddDate } from "../hooks/useSubscriptionApprovals";
import type { Member, MemberLog } from "../types";

/** ISO → giá trị cho <input type="datetime-local"> ("YYYY-MM-DDTHH:mm", giờ địa phương). */
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-success",
  pending: "badge badge-warning",
  removed: "badge badge-danger",
};

const RESULT_BADGE: Record<string, string> = {
  SUCCESS: "badge badge-success",
  OK: "badge badge-success",
  COMPLETED: "badge badge-success",
  FAILED: "badge badge-danger",
  PENDING: "badge badge-neutral",
};

// Màu chấm timeline theo kết quả sự kiện.
const RESULT_DOT: Record<string, string> = {
  SUCCESS: "var(--success)",
  OK: "var(--success)",
  COMPLETED: "var(--success)",
  FAILED: "var(--danger)",
  PENDING: "var(--warning-accent)",
};

// Các action audit có nhãn tiếng Việt/Trung trong i18n ("memberLog.action.*").
// Action ngoài tập này hiển thị nguyên mã (vẫn đủ thông tin để truy vết).
const KNOWN_ACTIONS = new Set([
  "MEMBER_INVITE_QUEUED",
  "MEMBER_BULK_INVITE_QUEUED",
  "MEMBER_REMOVE_QUEUED",
  "MEMBER_BULK_REMOVE_QUEUED",
  "MEMBER_EXPIRED_REMOVE_QUEUED",
  "MEMBER_REMOVED_SYNCED",
  "MEMBER_CHANGE_ROLE_QUEUED",
  "MEMBER_ROLE_SYNCED",
  "MEMBER_CHANGE_LICENSE_TYPE_QUEUED",
  "MEMBER_BULK_CHANGE_LICENSE_TYPE_QUEUED",
  "MEMBER_LICENSE_TYPE_SYNCED",
  "MEMBER_SUBSCRIPTION_UPDATED",
  "MEMBER_SUBSCRIPTION_CHANGE_REQUESTED",
  "MEMBER_SUBSCRIPTION_CHANGE_APPROVED",
  "MEMBER_SUBSCRIPTION_CHANGE_REJECTED",
  "MEMBER_EXPIRY_BULK_SET",
  "MEMBER_EXPIRY_BULK_REQUESTED",
  "MEMBER_ADD_DATE_CORRECTED",
  "MEMBER_EMAIL_CHANGED",
  "MEMBER_USAGE_LIMIT_REQUESTED",
  "MEMBER_BULK_SET_USAGE_LIMIT_QUEUED",
  "MEMBER_USAGE_LIMIT_SYNCED",
  "MEMBER_PAYMENT_REQUESTED",
  "MEMBER_PAYMENT_MARKED",
  "MEMBER_OWNER_CHANGED",
  "MEMBER_OWNER_REVOKED",
  "MEMBER_OWNER_TRANSFERRED",
  "MEMBER_BULK_OWNER_ASSIGN",
  "MEMBER_BULK_UPSERT",
  "MEMBER_SYNC_PROMOTED_ACTIVE",
  "MEMBER_INVITE_VERIFY_RECONCILE",
]);

const PAYMENT_BADGE: Record<string, string> = {
  unpaid: "badge badge-neutral",
  requested: "badge badge-warning",
  paid: "badge badge-success",
};

// ── Chi tiết "cũ → mới" cho từng dòng lịch sử ────────────────────────────────
// Mỗi action ánh xạ tới các cặp giá trị đổi (pair: cũ → mới) hoặc giá trị đơn
// (single). Key khớp `data` mà backend ghi qua log_event (xem các router members/*).
// labelKey → i18n "memberLog.field.<labelKey>"; type quyết định cách format.
type FieldType = "date" | "months" | "credits" | "role" | "text";

// [labelKey, keyGiáTrịCũ, keyGiáTrịMới, type]
const LOG_PAIRS: Record<string, [string, string, string, FieldType][]> = {
  MEMBER_SUBSCRIPTION_UPDATED: [
    ["subscriptionEnd", "old_end_at", "new_end_at", "date"],
    ["months", "old_months", "new_months", "months"],
  ],
  MEMBER_SUBSCRIPTION_CHANGE_REQUESTED: [
    ["subscriptionEnd", "current_end_at", "requested_end_at", "date"],
  ],
  MEMBER_ADD_DATE_CORRECTED: [
    ["renewAt", "old_purchased_at", "new_purchased_at", "date"],
    ["subscriptionEnd", "old_end_at", "new_end_at", "date"],
  ],
  MEMBER_EMAIL_CHANGED: [["email", "old_email", "new_email", "text"]],
  MEMBER_CHANGE_ROLE_QUEUED: [["role", "old_role", "new_role", "role"]],
  MEMBER_CHANGE_LICENSE_TYPE_QUEUED: [
    ["license", "old_license_type", "new_license_type", "text"],
  ],
  MEMBER_BULK_CHANGE_LICENSE_TYPE_QUEUED: [
    ["license", "old_license_type", "new_license_type", "text"],
  ],
  MEMBER_USAGE_LIMIT_REQUESTED: [
    ["credits", "old_limit_credits", "limit_credits", "credits"],
  ],
  MEMBER_BULK_SET_USAGE_LIMIT_QUEUED: [
    ["credits", "old_limit_credits", "limit_credits", "credits"],
  ],
};

// [labelKey, key, type]
const LOG_SINGLES: Record<string, [string, string, FieldType][]> = {
  MEMBER_INVITE_QUEUED: [
    ["role", "role", "role"],
    ["subscriptionEnd", "subscription_end_at", "date"],
  ],
  MEMBER_SUBSCRIPTION_CHANGE_REQUESTED: [["months", "requested_months", "months"]],
  MEMBER_EMAIL_CHANGED: [["subscriptionEnd", "subscription_end_at", "date"]],
  MEMBER_ROLE_SYNCED: [["role", "new_role", "role"]],
  MEMBER_LICENSE_TYPE_SYNCED: [["license", "new_license_type", "text"]],
  MEMBER_USAGE_LIMIT_SYNCED: [["credits", "limit_credits", "credits"]],
  MEMBER_OWNER_TRANSFERRED: [["owner", "target_username", "text"]],
  MEMBER_EXPIRED_REMOVE_QUEUED: [["subscriptionEnd", "subscription_end_at", "date"]],
};

type TFn = (key: string, params?: Record<string, string | number>) => string;
type LogSeg =
  | { kind: "pair"; label: string; from: string; to: string }
  | { kind: "single"; label: string; value: string };

function fmtLogValue(
  type: FieldType,
  raw: unknown,
  t: TFn,
  formatDateTime: (d: string) => string,
): string {
  if (raw === null || raw === undefined || raw === "")
    return type === "date" ? t("memberLog.val.unlimited") : t("memberLog.val.none");
  switch (type) {
    case "date":
      return formatDateTime(String(raw));
    case "months":
      return t("memberLog.val.months", { n: Number(raw) });
    case "credits":
      return t("memberLog.val.credits", { n: Number(raw) });
    case "role": {
      const s = String(raw);
      return t(`member.role${s.charAt(0).toUpperCase()}${s.slice(1)}`);
    }
    default:
      return String(raw);
  }
}

/** Diễn giải "cũ → mới" / giá trị của 1 dòng log từ `data`. Rỗng nếu không có
 *  trường nào (dòng chỉ hiện tên hành động như cũ). `email` = email của member
 *  đang xem — dùng để bóc đúng entry trong log mời HÀNG LOẠT (data.entries[]). */
function describeLog(
  log: MemberLog,
  email: string,
  t: TFn,
  formatDateTime: (d: string) => string,
): LogSeg[] {
  const data = (log.data ?? {}) as Record<string, unknown>;
  const segs: LogSeg[] = [];

  // Mời hàng loạt: data.role là role chung của batch, còn hạn dùng của TỪNG email
  // nằm trong data.entries[]. Bóc entry khớp email này để hiện như mời đơn lẻ.
  if (log.action === "MEMBER_BULK_INVITE_QUEUED") {
    if (data.role != null && data.role !== "")
      segs.push({
        kind: "single",
        label: t("memberLog.field.role"),
        value: fmtLogValue("role", data.role, t, formatDateTime),
      });
    const entries = Array.isArray(data.entries)
      ? (data.entries as Record<string, unknown>[])
      : [];
    const mine = entries.find(
      (e) => String(e?.email ?? "").toLowerCase() === email.toLowerCase(),
    );
    if (mine && "subscription_end_at" in mine)
      segs.push({
        kind: "single",
        label: t("memberLog.field.subscriptionEnd"),
        value: fmtLogValue("date", mine.subscription_end_at, t, formatDateTime),
      });
    return segs;
  }
  for (const [labelKey, fromKey, toKey, type] of LOG_PAIRS[log.action] ?? []) {
    if (!(fromKey in data) && !(toKey in data)) continue;
    const from = fmtLogValue(type, data[fromKey], t, formatDateTime);
    const to = fmtLogValue(type, data[toKey], t, formatDateTime);
    // Bỏ cặp KHÔNG đổi (cũ == mới) — vd "Theo ngày cụ thể" giữ nguyên số tháng thì
    // không hiện "2 tháng → 2 tháng" gây nhiễu.
    if (from === to) continue;
    segs.push({
      kind: "pair",
      label: t(`memberLog.field.${labelKey}`),
      from,
      to,
    });
  }
  for (const [labelKey, key, type] of LOG_SINGLES[log.action] ?? []) {
    if (!(key in data)) continue;
    segs.push({
      kind: "single",
      label: t(`memberLog.field.${labelKey}`),
      value: fmtLogValue(type, data[key], t, formatDateTime),
    });
  }
  // Thanh toán ghi cờ bool (requested/paid) → diễn giải riêng.
  if (log.action === "MEMBER_PAYMENT_REQUESTED" && "requested" in data)
    segs.push({
      kind: "single",
      label: t("memberLog.field.payment"),
      value: t(
        data.requested ? "memberLog.val.paymentRequest" : "memberLog.val.paymentWithdraw",
      ),
    });
  if (log.action === "MEMBER_PAYMENT_MARKED" && "paid" in data)
    segs.push({
      kind: "single",
      label: t("memberLog.field.payment"),
      value: t(data.paid ? "memberLog.val.paymentPaid" : "memberLog.val.paymentUnpaid"),
    });
  return segs;
}

export function MemberDetailModal({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: Member;
  onClose: () => void;
}) {
  const t = useT();
  const formatDateTime = useFormatDateTime();
  const { user } = useAuth();
  const correctAddDate = useCorrectAddDate(workspaceId);

  // Mốc "Ngày gia hạn" (= ngày add đầu tiên) = subscription_purchased_at, fallback
  // last_invited_at ?? created_at cho row legacy. Super-admin sửa ĐÚNG 1 LẦN (khoá
  // bằng add_date_corrected_at) → tính lại hạn = mốc mới + tháng×30.
  const renewAnchor =
    member.subscription_purchased_at ??
    member.last_invited_at ??
    member.created_at;
  const canEditAddDate =
    user?.is_super_admin === true && !member.add_date_corrected_at;
  const [editingAddDate, setEditingAddDate] = useState(false);
  const [addDateInput, setAddDateInput] = useState(() =>
    toLocalInputValue(renewAnchor),
  );

  const saveAddDate = () => {
    if (!addDateInput || correctAddDate.isPending) return;
    const d = new Date(addDateInput);
    if (Number.isNaN(d.getTime())) return;
    correctAddDate.mutate(
      { memberId: member.id, addDate: d.toISOString() },
      { onSuccess: () => setEditingAddDate(false) },
    );
  };

  const renewValue: ReactNode = editingAddDate ? (
    <div style={{ display: "grid", gap: 6 }}>
      <input
        type="datetime-local"
        className="form-input"
        value={addDateInput}
        onChange={(e) => setAddDateInput(e.target.value)}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={saveAddDate}
          disabled={!addDateInput || correctAddDate.isPending}
        >
          {correctAddDate.isPending ? t("common.loading") : t("common.save")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setEditingAddDate(false)}
          disabled={correctAddDate.isPending}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  ) : (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      {renewAnchor ? formatDateTime(renewAnchor) : "—"}
      {canEditAddDate && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ padding: "0 6px", fontSize: 12 }}
          onClick={() => setEditingAddDate(true)}
        >
          {t("addDate.editBtn")}
        </button>
      )}
      {member.add_date_corrected_at && (
        <span className="cell-muted" style={{ fontSize: 11 }}>
          ({t("addDate.locked")})
        </span>
      )}
    </span>
  );

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["member-logs", workspaceId, member.id],
    queryFn: () =>
      api<MemberLog[]>(
        `/api/v1/workspaces/${workspaceId}/members/${member.id}/logs?limit=200`,
      ),
  });

  const actionLabel = (action: string) =>
    KNOWN_ACTIONS.has(action) ? t(`memberLog.action.${action}`) : action;

  const rows: { label: string; value: ReactNode }[] = [
    {
      label: t("member.colStatus"),
      value: (
        <span className={STATUS_BADGE[member.status] ?? "badge badge-neutral"}>
          {t(
            `member.status${member.status.charAt(0).toUpperCase()}${member.status.slice(1)}`,
          )}
        </span>
      ),
    },
    {
      label: t("member.colRole"),
      value: member.chatgpt_role
        ? t(
            `member.role${member.chatgpt_role.charAt(0).toUpperCase()}${member.chatgpt_role.slice(1)}`,
          )
        : "—",
    },
    ...(LICENSE_FEATURE_ENABLED
      ? [{ label: t("member.colLicenseType"), value: member.license_type ?? "—" }]
      : []),
    // Ngày gia hạn (mốc neo) — có nút sửa 1 lần cho super-admin. "Ngày hết hạn" =
    // mốc này + tháng×30.
    {
      label: t("memberDetail.renewAt"),
      value: renewValue,
    },
    {
      label: t("memberDetail.chatgptJoinedAt"),
      value: member.joined_at ? formatDateTime(member.joined_at) : "—",
    },
    {
      label: t("memberDetail.subscriptionEnd"),
      value: member.subscription_end_at
        ? formatDateTime(member.subscription_end_at)
        : t("memberDetail.unlimited"),
    },
    // Chu kỳ sử dụng — chỉ hiện khi mua > 1 tháng (theo yêu cầu user).
    ...(member.subscription_months && member.subscription_months > 1
      ? [
          {
            label: t("memberDetail.cycleLabel"),
            value: t("memberDetail.cycleValue", { n: member.subscription_months }),
          },
        ]
      : []),
    {
      label: t("memberDetail.usageLimit"),
      value:
        member.usage_limit_credits == null
          ? "—"
          : t("memberDetail.usageLimitValue", { n: member.usage_limit_credits }),
    },
    {
      label: t("memberDetail.payment"),
      value: (
        <span
          className={PAYMENT_BADGE[member.payment_status] ?? "badge badge-neutral"}
        >
          {t(`memberDetail.payment.${member.payment_status}`)}
        </span>
      ),
    },
    {
      label: t("memberDetail.lastSyncedAt"),
      value: member.last_synced_at ? formatDateTime(member.last_synced_at) : "—",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl"
        style={{ width: "100%", maxWidth: 640, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="cell-muted" style={{ fontSize: 12 }}>
              {t("memberDetail.title")}
            </div>
            <h3
              style={{
                margin: "2px 0 0",
                fontSize: 16,
                fontWeight: 600,
                wordBreak: "break-all",
              }}
            >
              {member.email}
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "18px 20px 20px", overflowY: "auto" }}>
          {/* Phần 1 — thông tin hiện tại: thẻ nền dịu, mỗi mục nhãn nhỏ in hoa + giá trị. */}
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg, 12px)",
              padding: "14px 16px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "14px 24px",
              marginBottom: 22,
            }}
          >
            {rows.map((r, i) => (
              <div key={i} style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "var(--ink-3)",
                    marginBottom: 3,
                  }}
                >
                  {r.label}
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
                  {r.value}
                </div>
              </div>
            ))}
          </div>

          {/* Phần 2 — timeline lịch sử hoạt động */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--ink-2)",
              }}
            >
              {t("memberDetail.activityTitle")}
            </span>
            {!isLoading && logs.length > 0 && (
              <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                {logs.length}
              </span>
            )}
          </div>

          {isLoading && (
            <div className="cell-muted" style={{ fontSize: 13, padding: "12px 0" }}>
              {t("common.loading")}
            </div>
          )}
          {!isLoading && logs.length === 0 && (
            <div className="cell-muted" style={{ fontSize: 13, padding: "12px 0" }}>
              {t("memberDetail.activityEmpty")}
            </div>
          )}
          {!isLoading && logs.length > 0 && (
            <div style={{ position: "relative", paddingLeft: 22 }}>
              {/* Đường dọc timeline nối các chấm. */}
              <div
                style={{
                  position: "absolute",
                  left: 5,
                  top: 8,
                  bottom: 8,
                  width: 2,
                  background: "var(--border)",
                }}
              />
              {logs.map((log) => {
                const segs = describeLog(log, member.email, t, formatDateTime);
                const dot = RESULT_DOT[log.result] ?? "var(--ink-3)";
                return (
                  <div
                    key={log.id}
                    style={{ position: "relative", marginBottom: 10 }}
                  >
                    {/* Chấm trạng thái trên đường timeline. */}
                    <div
                      style={{
                        position: "absolute",
                        left: -22,
                        top: 12,
                        width: 12,
                        height: 12,
                        borderRadius: "50%",
                        background: dot,
                        border: "2px solid var(--surface)",
                        boxShadow: "0 0 0 1px var(--border)",
                      }}
                    />
                    <div
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: "9px 12px",
                        background: "var(--surface)",
                        boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.04))",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {actionLabel(log.action)}
                        </span>
                        <span
                          className={RESULT_BADGE[log.result] ?? "badge badge-neutral"}
                          style={{ fontSize: 10 }}
                        >
                          {log.result.toLowerCase()}
                        </span>
                        <span
                          style={{
                            marginLeft: "auto",
                            fontSize: 11,
                            color: "var(--ink-3)",
                            fontFamily: "var(--font-mono)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatDateTime(log.timestamp)}
                        </span>
                      </div>
                      <div
                        className="cell-muted"
                        style={{ fontSize: 11.5, marginTop: 1 }}
                      >
                        {log.actor_label ??
                          (log.actor_type === "EXTENSION"
                            ? t("audit.actorExt")
                            : log.actor_type.toLowerCase())}
                      </div>
                      {/* Chi tiết thay đổi: hạn cũ → mới, số tháng, vai trò, email… */}
                      {segs.length > 0 && (
                        <div
                          style={{
                            marginTop: 7,
                            paddingTop: 7,
                            borderTop: "1px solid var(--border)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 3,
                          }}
                        >
                          {segs.map((s, i) => (
                            <div
                              key={i}
                              style={{
                                fontSize: 12,
                                display: "flex",
                                gap: 6,
                                flexWrap: "wrap",
                                alignItems: "baseline",
                              }}
                            >
                              <span
                                style={{ color: "var(--ink-3)", minWidth: 76 }}
                              >
                                {s.label}
                              </span>
                              {s.kind === "pair" ? (
                                <span>
                                  <span
                                    style={{
                                      textDecoration: "line-through",
                                      color: "var(--ink-3)",
                                    }}
                                  >
                                    {s.from}
                                  </span>
                                  <span style={{ color: "var(--ink-3)" }}> → </span>
                                  <span style={{ fontWeight: 600 }}>{s.to}</span>
                                </span>
                              ) : (
                                <span style={{ fontWeight: 600 }}>{s.value}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
