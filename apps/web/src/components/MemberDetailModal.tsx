/**
 * Modal "Chi tiết thành viên" — mở khi click vào email ở bảng Danh sách thành viên.
 *
 * Hiển thị 3 phần:
 *   1. Thông tin hiện tại của member (vai trò, trạng thái, hạn dùng, giấy phép,
 *      giới hạn tín dụng, thanh toán, mốc thời gian).
 *   2. KỲ THANH TOÁN + DÒNG TIỀN — kỳ hạn đã mua và tiền THỰC SỰ đã thu của email
 *      đó, lấy từ GET .../members/{memberId}/payments (xem members/payments.md).
 *      Hai khối đặt cạnh nhau CÓ CHỦ ĐÍCH: "còn hạn dùng" và "đã thu tiền" là hai
 *      chuyện khác nhau, ca stockbox.m (thu 2 lần → hoàn 2 lần → vẫn còn 1 tháng)
 *      chỉ lộ ra khi nhìn đồng thời.
 *   3. Timeline LỊCH SỬ HOẠT ĐỘNG — mọi sự kiện audit liên quan email đó, lấy từ
 *      GET /workspaces/{id}/members/{memberId}/logs (xem members/activity.md).
 *
 * Chủ yếu query. Ngoại lệ ghi: (1) sửa "Ngày gia hạn" 1 lần (super-admin);
 * (2) nút "Huỷ" thanh toán (paid → unpaid, super-admin) ở hàng Thanh toán —
 * chuyển từ bảng "Email đã add" sang, thao tác sửa sai hiếm dùng.
 * Xem MemberDetailModal.md TRƯỚC KHI SỬA.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { toast } from "./Toast";
import { LICENSE_FEATURE_ENABLED } from "../lib/featureFlags";
import { roleKeySuffix } from "../lib/memberRole";
import { currentStintCycles, sortCycles, startsNewStint } from "../lib/cycles";
import { useFormatDate, useFormatDateTime, useT, useTranslateEnum } from "../i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAuth } from "../hooks/useAuth";
import { usePlatform } from "../hooks/usePlatform";
import { useCorrectAddDate } from "../hooks/useSubscriptionApprovals";
import { useSetMemberFee, useWalletAdminUsers, usePaymentSettings } from "../hooks/useWallet";
import { formatVnd } from "../lib/wallet";
import type { AddedMember, Member, MemberLog, Workspace } from "../types";

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

// Màu chấm timeline theo kết quả sự kiện.
const RESULT_DOT: Record<string, string> = {
  SUCCESS: "var(--success)",
  OK: "var(--info)",
  COMPLETED: "var(--success)",
  FAILED: "var(--danger)",
  PENDING: "var(--warning)",
};

// Nền quầng (ring) quanh chấm + nền chip trạng thái nhỏ trên timeline.
const RESULT_RING: Record<string, string> = {
  SUCCESS: "var(--success-bg)",
  OK: "var(--info-bg)",
  COMPLETED: "var(--success-bg)",
  FAILED: "var(--danger-bg)",
  PENDING: "var(--warning-bg)",
};

// (②) Nhãn + biểu tượng kết quả — thay mã thô "completed/failed" bằng tiếng Việt
// rõ ràng, dùng lại nhãn i18n audit.status.* để nhất quán với trang Nhật ký.
const RESULT_META: Record<string, { icon: string; key: string }> = {
  SUCCESS: { icon: "✓", key: "audit.status.success" },
  OK: { icon: "✓", key: "audit.status.success" },
  COMPLETED: { icon: "✓", key: "audit.status.success" },
  FAILED: { icon: "✕", key: "audit.status.failed" },
  PENDING: { icon: "◔", key: "audit.gstatus.queued" },
};

// Ngày+giờ chi tiết TỚI GIÂY (khớp cột trang "Email đã add" + bảng thành viên) —
// mọi mốc thời gian trong thẻ thông tin đều hiện giây.
const WITH_SECONDS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

/** Giờ ngắn "HH:MM:SS" (24h) cho từng dòng timeline — ngày gom ở tiêu đề nhóm. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// Các action audit có nhãn tiếng Việt/Trung trong i18n ("memberLog.action.*").
// Action ngoài tập này hiển thị nguyên mã (vẫn đủ thông tin để truy vết).
const KNOWN_ACTIONS = new Set([
  "MEMBER_INVITE_QUEUED",
  "MEMBER_BULK_INVITE_QUEUED",
  "MEMBER_INVITE_VERIFIED",
  "MEMBER_INVITE_FAILED",
  "MEMBER_INVITE_PENDING_VERIFY",
  "MEMBER_REMOVE_QUEUED",
  "MEMBER_BULK_REMOVE_QUEUED",
  "MEMBER_EXPIRED_REMOVE_QUEUED",
  "MEMBER_REMOVED_SYNCED",
  "MEMBER_REMOVE_STUCK",
  "MEMBER_REMOVE_FAKE_DETECTED",
  "MEMBER_REMOVE_UNVERIFIED",
  "MEMBER_REFUND_WHILE_IN_TEAM",
  "MEMBER_EXPORT_DATA_QUEUED",
  "MEMBER_DELETE_DATA_QUEUED",
  "MEMBER_CHANGE_ROLE_QUEUED",
  "MEMBER_ROLE_SYNCED",
  "MEMBER_CHANGE_LICENSE_TYPE_QUEUED",
  "MEMBER_BULK_CHANGE_LICENSE_TYPE_QUEUED",
  "MEMBER_LICENSE_TYPE_SYNCED",
  "MEMBER_SUBSCRIPTION_UPDATED",
  "MEMBER_SUBSCRIPTION_RENEWED",
  "MEMBER_SUBSCRIPTION_CHANGE_REQUESTED",
  "MEMBER_SUBSCRIPTION_CHANGE_APPROVED",
  "MEMBER_SUBSCRIPTION_CHANGE_REJECTED",
  "MEMBER_EXPIRY_BULK_SET",
  "MEMBER_EXPIRY_BULK_REQUESTED",
  "MEMBER_ADD_DATE_CORRECTED",
  "MEMBER_EMAIL_CHANGED",
  "MEMBER_SUBSCRIPTION_TRANSFERRED",
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

// Timeline chi tiết thành viên (yêu cầu user 2026-07-20) CHỈ hiển thị 4 nhóm
// nghiệp vụ: mời · xoá email (gỡ) · gia hạn · đổi chủ · đổi email. Các log khác
// (đổi thời hạn, đổi role/loại giấy phép/giới hạn dùng, đánh dấu thanh toán…)
// vẫn được backend lưu nhưng ẩn khỏi timeline này.
const MODAL_TIMELINE_ACTIONS = new Set([
  // mời
  "MEMBER_INVITE_QUEUED",
  "MEMBER_BULK_INVITE_QUEUED",
  "MEMBER_INVITE_PENDING_VERIFY",
  "MEMBER_INVITE_VERIFIED",
  "MEMBER_INVITE_FAILED",
  "MEMBER_INVITE_VERIFY_RECONCILE",
  "MEMBER_SYNC_PROMOTED_ACTIVE",
  // xoá email (gỡ thành viên / thu hồi lời mời)
  "MEMBER_REMOVE_QUEUED",
  "MEMBER_BULK_REMOVE_QUEUED",
  "MEMBER_EXPIRED_REMOVE_QUEUED",
  "MEMBER_REMOVED_SYNCED",
  "MEMBER_REMOVE_STUCK",
  "MEMBER_REMOVE_FAKE_DETECTED",
  "MEMBER_INVITE_REVOKED",
  // tiền: đã hoàn phí nhưng email vẫn ở trong team (nợ cần truy thu)
  "MEMBER_REFUND_WHILE_IN_TEAM",
  // gia hạn
  "MEMBER_SUBSCRIPTION_RENEWED",
  // đổi chủ
  "MEMBER_OWNER_CHANGED",
  "MEMBER_OWNER_REVOKED",
  "MEMBER_OWNER_TRANSFERRED",
  "MEMBER_BULK_OWNER_ASSIGN",
  // đổi email (thay thế 1-đổi-1: gỡ email cũ + mời email mới)
  "MEMBER_EMAIL_CHANGED",
  "MEMBER_SUBSCRIPTION_TRANSFERRED",
]);

// Dòng phải nói RÕ NƠI xảy ra: MỜI vào workspace nào, GỠ/XOÁ khỏi workspace nào.
// Timeline trộn được log của NHIỀU workspace (chuỗi đổi email dẫn sang không gian
// khác), nên thiếu chip này thì hai dòng liền nhau không phân biệt được nơi chốn
// (user 29/8/2026). Mọi action ở đây đều ghi `data.workspace_id` ở backend.
const WORKSPACE_CHIP_ACTIONS = new Set([
  "MEMBER_INVITE_QUEUED",
  "MEMBER_BULK_INVITE_QUEUED",
  "MEMBER_REMOVE_QUEUED",
  "MEMBER_BULK_REMOVE_QUEUED",
  "MEMBER_EXPIRED_REMOVE_QUEUED",
  "MEMBER_REMOVED_SYNCED",
  "MEMBER_INVITE_REVOKED",
  "MEMBER_REMOVE_STUCK",
  "MEMBER_REMOVE_FAKE_DETECTED",
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
  MEMBER_SUBSCRIPTION_RENEWED: [
    ["subscriptionEnd", "old_end_at", "new_end_at", "date"],
  ],
  MEMBER_SUBSCRIPTION_CHANGE_REQUESTED: [
    ["subscriptionEnd", "current_end_at", "requested_end_at", "date"],
  ],
  MEMBER_ADD_DATE_CORRECTED: [
    ["renewAt", "old_purchased_at", "new_purchased_at", "date"],
    ["subscriptionEnd", "old_end_at", "new_end_at", "date"],
  ],
  MEMBER_EMAIL_CHANGED: [["email", "old_email", "new_email", "text"]],
  MEMBER_SUBSCRIPTION_TRANSFERRED: [
    ["email", "source_email", "target_email", "text"],
    ["subscriptionEnd", "old_target_end_at", "new_end_at", "date"],
  ],
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
  MEMBER_SUBSCRIPTION_RENEWED: [["months", "months", "months"]],
  MEMBER_EMAIL_CHANGED: [["subscriptionEnd", "subscription_end_at", "date"]],
  MEMBER_SUBSCRIPTION_TRANSFERRED: [
    ["subscriptionEnd", "source_end_at", "date"],
  ],
  MEMBER_ROLE_SYNCED: [["role", "new_role", "role"]],
  MEMBER_LICENSE_TYPE_SYNCED: [["license", "new_license_type", "text"]],
  MEMBER_USAGE_LIMIT_SYNCED: [["credits", "limit_credits", "credits"]],
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
    case "role":
      return t(`member.role${roleKeySuffix(String(raw))}`);
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
  memberId: string,
  derivedOwnerFrom: string | null | undefined,
  t: TFn,
  formatDateTime: (d: string) => string,
  wsName: (id: unknown) => string | null,
): LogSeg[] {
  const data = (log.data ?? {}) as Record<string, unknown>;
  const segs: LogSeg[] = [];

  // Chip "Workspace" mở đầu dòng mời/gỡ (xem WORKSPACE_CHIP_ACTIONS). Tên tra từ
  // `data.workspace_id`; log cũ thiếu khoá đó hoặc tra không ra tên thì BỎ chip —
  // thà thiếu còn hơn đoán bừa workspace đang mở (log của member cũ trong chuỗi
  // đổi email có thể thuộc workspace khác) hay phơi UUID ra cho người đọc.
  if (WORKSPACE_CHIP_ACTIONS.has(log.action)) {
    const ws = wsName(data.workspace_id);
    if (ws)
      segs.push({
        kind: "single",
        label: t("memberLog.field.workspace"),
        value: ws,
      });
  }

  // Chuyển chủ sở hữu (hàng loạt): chủ cũ khác nhau tuỳ member → hiện "a → b".
  // Ưu tiên chủ cũ lưu sẵn trong entries[] (log mới, khớp theo member_id). Log CŨ
  // không có entries → suy ngược `derivedOwnerFrom` từ timeline của chính member
  // (chủ cũ = chủ do lần chuyển liền trước đã đặt). Không suy được → "→ b".
  if (log.action === "MEMBER_OWNER_TRANSFERRED") {
    const to = fmtLogValue("text", data.target_username, t, formatDateTime);
    const entries = Array.isArray(data.entries)
      ? (data.entries as Record<string, unknown>[])
      : [];
    const mine = entries.find((e) => String(e?.member_id ?? "") === memberId);
    let from: string | null | undefined;
    if (mine && "from_username" in mine) from = mine.from_username as string | null;
    else from = derivedOwnerFrom;
    if (from !== undefined) {
      segs.push({
        kind: "pair",
        label: t("memberLog.field.owner"),
        from: fmtLogValue("text", from, t, formatDateTime),
        to,
      });
    } else {
      segs.push({ kind: "single", label: t("memberLog.field.owner"), value: to });
    }
    return segs;
  }

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

/** (③) Dòng "người thực hiện": phân biệt rõ TỰ ĐỘNG (hệ thống / tiện ích trình
 *  duyệt) với THỦ CÔNG (quản trị viên). Đối tượng bị ảnh hưởng chính là member
 *  đang xem (email ở tiêu đề modal) nên không lặp lại. */
function actorLine(log: MemberLog, t: TFn): string {
  const label = log.actor_label ?? "";
  if (log.actor_type === "EXTENSION")
    return `${t("audit.actor.auto")} · ${t("audit.actor.extFull")}`;
  if (log.actor_type === "SYSTEM")
    return `${t("audit.actor.auto")} · ${t("audit.actor.system")}${label ? ` (${label})` : ""}`;
  return `${t("audit.actor.manual")} · ${label || log.actor_type.toLowerCase()}`;
}

/** Badge trạng thái thanh toán của 1 chu kỳ trong mục "Kỳ thanh toán" — dùng lại
 *  nhãn tab "Email đã add" (paid ✓ / requested / unpaid ✗). */
function CyclePaymentBadge({
  status,
  t,
}: {
  status: "unpaid" | "requested" | "paid";
  t: TFn;
}) {
  if (status === "paid")
    return (
      <span className="badge badge-success badge-plain">
        ✓ {t("addedEmails.statusPaid")}
      </span>
    );
  if (status === "requested")
    return (
      <span className="badge badge-warning badge-plain">
        {t("addedEmails.statusRequested")}
      </span>
    );
  return (
    <span className="badge badge-danger badge-plain">
      ✗ {t("addedEmails.statusUnpaid")}
    </span>
  );
}

/* ── DÒNG TIỀN của 1 email (GET .../members/{id}/payments) ───────────────────
   `entries` = SỔ CÁI VÍ, tiền thật: amount < 0 trừ ví (phí mời/gia hạn), > 0 cộng
   lại (hoàn phí). `orders` = hoá đơn QR khi ví không đủ — CHỈ để truy vết, KHÔNG
   cộng vào tổng (tiền QR vào ví rồi mới trừ phí, cộng nữa là đếm hai lần).
   Xem app/routers/members/payments.md. */
type MemberPaymentEntry = {
  id: string;
  kind: string;
  amount: number;
  balance_after: number;
  ref_type: string | null;
  ref_id: string | null;
  meta: Record<string, unknown> | null;
  /** Chỉ ở `invite_fee`: true ⇔ phí đã được hoàn (lượt mời hỏng). */
  reversed?: boolean;
  created_at: string;
  /** Email CŨ mà khoản này thuộc về (chỉ có khi email đang xem là email NHẬN của
   *  một lần đổi email). null/undefined = khoản của chính email đang xem. */
  from_email?: string | null;
};

/** 1 dòng của khối dòng tiền: khoản lẻ, hoặc CẶP phí ↔ hoàn của một lượt mời hỏng. */
type CashRow =
  | { type: "entry"; entry: MemberPaymentEntry }
  | { type: "voided"; fee: MemberPaymentEntry; refund: MemberPaymentEntry };

/** Bút toán mang tiền VỀ cho món nợ "đã hoàn phí mà email vẫn trong team". */
const RECLAIM_KINDS = new Set(["adjust", "cycle_fee"]);

/** Cửa sổ coi một lượt `invite_fee` mới là THU LẠI chứ không phải bán tháng mới —
 *  khớp `RECLAIM_REINVITE_WINDOW` bên members/reconcile.py. */
const RECLAIM_REINVITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Món nợ "đã hoàn phí nhưng email vẫn ở trong team" đã được thu lại chưa?
 *
 * Luật phải TRÙNG KHÍT với backend (`_flag_refunded_while_in_team` trong
 * members/reconcile.py), nếu không thì một bên im còn một bên vẫn đỏ: có bút toán
 * thu về ÍT NHẤT bằng lần hoàn gần nhất, xảy ra SAU lần hoàn đó.
 *
 * Ba cách tiền quay lại, đều tính:
 *   - `adjust`    — admin truy thu tay;
 *   - `cycle_fee` — đại lý tự bấm "Thanh toán" cho kỳ còn nợ (đường CHÍNH từ
 *     29/8/2026, cả khi trừ thẳng ví lẫn khi trả qua hoá đơn QR);
 *   - `invite_fee` chưa bị hoàn, trong `RECLAIM_REINVITE_WINDOW_MS` — lượt mời lại
 *     TRÓT LỌT của cùng loạt (mời hỏng đi theo chùm: hỏng → hoàn → thử lại ngay).
 *
 * ⚠️ `renew_fee` KHÔNG tính dù cũng là số âm, và `invite_fee` NGOÀI cửa sổ cũng
 * không: đó là mua THÊM một tháng, không phải trả nợ tháng đã dùng. Cũng vì thế mà
 * KHÔNG được rút gọn thành "thực thu > 0" — một lượt gia hạn tháng sau sẽ đóng dấu
 * "đã truy thu" cho khoản chưa ai thu đồng nào. Báo đỏ thừa thì khó chịu, báo xanh
 * oan thì GIẤU MẤT TIỀN — nên chỗ nào lưỡng lự thì nghiêng về đỏ.
 */
export function isRefundDebtSettled(entries: MemberPaymentEntry[]): boolean {
  const refunds = entries.filter(
    (e) => e.kind.endsWith("_refund") && e.amount > 0,
  );
  if (refunds.length === 0) return false;
  const latest = refunds.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
  return entries.some((e) => {
    // Thu về phải ĐỦ (>= số đã hoàn) và phải xảy ra SAU lần hoàn.
    if (e.amount > -latest.amount || e.created_at <= latest.created_at) {
      return false;
    }
    if (RECLAIM_KINDS.has(e.kind)) return true;
    return (
      e.kind === "invite_fee" &&
      !e.reversed &&
      Date.parse(e.created_at) - Date.parse(latest.created_at) <=
        RECLAIM_REINVITE_WINDOW_MS
    );
  });
}

/**
 * Ghép `invite_fee` (đã `reversed`) với `invite_refund` của cùng lượt mời.
 *
 * Mời hỏng ghi 2 bút toán ngược dấu ở 2 thời điểm khác nhau; để rời ra thì người xem
 * phải tự trừ nhẩm mới biết email này rốt cuộc có mất tiền hay không (user
 * 2026-08-26). Ở ĐÂY chỉ GỘP chứ không giấu như trang Ví: khối này sinh ra để đối
 * soát "email dùng miễn phí" (ca stockbox.m), giấu đi là mất luôn bằng chứng.
 *
 * Cùng `ref_id` (queue_item) là đủ vì mọi khoản trong khối đã thuộc về 1 email; thiếu
 * bút toán hoàn (rơi ngoài `limit`) thì để nguyên dòng phí.
 */
export function pairMemberCashflow(entries: MemberPaymentEntry[]): CashRow[] {
  // Ghép trước rồi mới dựng dòng: danh sách xếp MỚI→CŨ nên bút toán hoàn luôn đứng
  // TRƯỚC phí của nó, quét một lượt sẽ đẩy nhầm bút toán hoàn thành dòng riêng.
  const pairedRefund = new Map<string, MemberPaymentEntry>(); // fee.id → refund
  const usedRefund = new Set<string>();
  for (const fee of entries) {
    if (fee.kind !== "invite_fee" || !fee.reversed) continue;
    const refund = entries.find(
      (r) =>
        r.kind === "invite_refund" &&
        !usedRefund.has(r.id) &&
        r.ref_id === fee.ref_id &&
        r.amount === -fee.amount,
    );
    if (!refund) continue;
    usedRefund.add(refund.id);
    pairedRefund.set(fee.id, refund);
  }
  const rows: CashRow[] = [];
  for (const entry of entries) {
    if (usedRefund.has(entry.id)) continue; // đã kể trong cặp của phí
    const refund = pairedRefund.get(entry.id);
    if (refund) rows.push({ type: "voided", fee: entry, refund });
    else rows.push({ type: "entry", entry });
  }
  return rows;
}

/** Tiền của 1 hoá đơn đã mời cho email nào, kết quả ra sao (API tính, xem
    payments.md §2.2). `ok` = phí giữ nguyên · `failed` = phí đã hoàn (mời hỏng) ·
    `pending` = có trong hoá đơn nhưng chưa phát sinh phí. */
type MemberPaymentAllocation = {
  email: string;
  amount: number;
  status: "ok" | "failed" | "pending" | string;
  refunded_at: string | null;
};

type MemberPaymentOrder = {
  id: string;
  ref_code: string;
  kind: string;
  amount_vnd: number;
  status: string;
  paid_amount_vnd: number | null;
  created_at: string;
  paid_at: string | null;
  fulfillment_error: string | null;
  /** true ⇔ toàn bộ phí mời mà hoá đơn này trả cho đã được hoàn (mời hỏng). */
  fee_refunded?: boolean;
  /** true ⇔ RIÊNG email đang xem mời hỏng và đã được hoàn phí ("hoá đơn thất bại"). */
  member_fee_refunded?: boolean;
  /** Lúc hoàn phí cho email đang xem — mốc đếm thời hạn còn hiện hoá đơn thất bại. */
  member_refunded_at?: string | null;
  allocations?: MemberPaymentAllocation[];
  /** Email CŨ mà hoá đơn này thuộc về (xem MemberPaymentEntry.from_email). */
  from_email?: string | null;
};

/* ── HOÁ ĐƠN THẤT BẠI Ở LẠI BAO LÂU ─────────────────────────────────────────
   "Thất bại" ở đây KHÔNG phải là chưa nhận được tiền: tiền đã vào ví, nhưng lượt
   mời email này hỏng nên phí đã hoàn ⇒ hoá đơn không đổi lấy dịch vụ nào. Nó là
   bằng chứng đối soát nên phải còn thấy được một thời gian, nhưng để mãi thì panel
   ngập hoá đơn chết (user 2026-08-29):
     • CHƯA mời lại được email đó  → giữ 30 ngày (việc còn dở, người add còn phải xử lý)
     • ĐÃ có lượt mời thành công sau đó → giữ 7 ngày (đã xong, chỉ còn để đối chiếu) */
const FAILED_ORDER_DAYS = 30;
const FAILED_ORDER_DAYS_AFTER_OK = 7;
const DAY_MS = 86_400_000;

/** Hoá đơn còn được hiện trên panel của email này (lọc hoá đơn thất bại quá hạn). */
export function visibleMemberOrders(
  orders: MemberPaymentOrder[],
  entries: MemberPaymentEntry[],
  now: number = Date.now(),
): MemberPaymentOrder[] {
  // Mốc các lượt mời THÀNH CÔNG của email (phí đã trừ và không bị hoàn).
  const okAt = entries
    .filter((e) => e.kind === "invite_fee" && !e.reversed)
    .map((e) => Date.parse(e.created_at))
    .filter((n) => Number.isFinite(n));
  return orders.filter((o) => {
    if (!o.member_fee_refunded) return true;
    const at = Date.parse(
      o.member_refunded_at ?? o.paid_at ?? o.created_at ?? "",
    );
    if (!Number.isFinite(at)) return true; // thiếu mốc → cứ giữ, đừng giấu bằng chứng
    const days = okAt.some((t) => t > at)
      ? FAILED_ORDER_DAYS_AFTER_OK
      : FAILED_ORDER_DAYS;
    return now - at <= days * DAY_MS;
  });
}

type MemberPayments = {
  email: string;
  entries: MemberPaymentEntry[];
  orders: MemberPaymentOrder[];
  charged_total: number;
  refunded_total: number;
  net_total: number;
  /** Email CŨ đã được gom tiền về đây (gần nhất trước), rỗng nếu chưa từng đổi. */
  inherited_emails?: string[];
};

const ORDER_STATUS_BADGE: Record<string, string> = {
  paid: "badge badge-success badge-plain",
  pending: "badge badge-warning badge-plain",
  expired: "badge badge-neutral badge-plain",
  cancelled: "badge badge-neutral badge-plain",
};

/** Một ô số tổng (đã thu / đã hoàn / thực thu). */
function CashStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ink" | "danger" | "success";
}) {
  const color =
    tone === "danger"
      ? "var(--danger)"
      : tone === "success"
        ? "var(--success)"
        : "var(--ink)";
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: "8px 10px",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 3,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          fontWeight: 600,
          color,
          whiteSpace: "nowrap",
        }}
      >
        {formatVnd(value)}
      </div>
    </div>
  );
}

/** Email CŨ mà một dòng sổ cái thuộc về (null = của chính email đang xem). */
function cashRowFrom(row: CashRow): string | null {
  const e = row.type === "voided" ? row.fee : row.entry;
  return (e.from_email ?? null) || null;
}

const sameEmail = (a: string | null | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

/** Một email cũ trong chuỗi đổi email + phần tiền phát sinh dưới tên nó. */
type InheritedCashGroup = {
  email: string;
  rows: CashRow[];
  orders: MemberPaymentOrder[];
};

/**
 * Tách dòng tiền thành phần CỦA email đang xem và phần KẾ THỪA từ email cũ.
 *
 * API gom tiền của chuỗi đổi email về panel email nhận (`from_email` trên từng
 * khoản) vì ghế đang dùng chính là ghế đã trả tiền đó — để riêng thì panel email
 * mới hiện 0 ₫ trong khi khách đã đóng đủ (user 31/8/2026). Nhưng gom KHÔNG được
 * lẫn: mỗi email cũ phải đứng trong một khung riêng ghi rõ tiền này của ai.
 *
 * Nhóm rỗng bị loại: chuỗi đổi email có thể dài mà chỉ một chặng từng trả tiền,
 * hiện khung trống chỉ tổ làm người xem tưởng thiếu dữ liệu. Thứ tự nhóm theo đúng
 * `inheritedEmails` (gần nhất trước) để đọc ngược dòng thời gian.
 */
export function splitInheritedCashflow(
  rows: CashRow[],
  orders: MemberPaymentOrder[],
  inheritedEmails: string[] | undefined,
): {
  ownRows: CashRow[];
  ownOrders: MemberPaymentOrder[];
  groups: InheritedCashGroup[];
} {
  const groups = (inheritedEmails ?? [])
    .map((email) => ({
      email,
      rows: rows.filter((r) => sameEmail(cashRowFrom(r), email)),
      orders: orders.filter((o) => sameEmail(o.from_email, email)),
    }))
    .filter((g) => g.rows.length > 0 || g.orders.length > 0);
  return {
    ownRows: rows.filter((r) => !cashRowFrom(r)),
    ownOrders: orders.filter((o) => !o.from_email),
    groups,
  };
}

// Export để dựng preview/test riêng khối này (không cần đăng nhập cả dashboard).
export function MemberCashflow({
  data,
  t,
  txnKind,
  orderStatus,
  formatDateTime,
}: {
  data: MemberPayments;
  t: TFn;
  txnKind: (value: string) => string;
  orderStatus: (value: string) => string;
  formatDateTime: (d: string) => string;
}) {
  // Đã thu phí mà thực thu = 0 ⇒ mọi khoản đều đã hoàn: email đang dùng MIỄN PHÍ.
  // Đây chính là ca stockbox.m — cảnh báo ngay trên đầu khối, đừng bắt admin tự trừ.
  const allRefunded = data.charged_total > 0 && data.net_total === 0;
  // Cặp phí ↔ hoàn của lượt mời hỏng gộp thành 1 dòng (xem pairMemberCashflow).
  const rows = pairMemberCashflow(data.entries);
  // Hoá đơn thất bại chỉ ở lại 30/7 ngày (xem visibleMemberOrders).
  const visibleOrders = visibleMemberOrders(data.orders, data.entries);
  /* ĐỔI EMAIL: tiền của email cũ được API gom sang đây (`from_email`) vì ghế đang
     dùng chính là ghế đã trả tiền đó — để riêng thì panel email mới hiện 0 ₫ trong
     khi khách đã đóng đủ (user 31/8/2026). Nhưng gom KHÔNG được lẫn: mỗi email cũ
     đứng trong một KHUNG riêng ghi rõ tiền này của ai, còn phần trên chỉ là khoản
     phát sinh dưới tên email hiện tại. */
  const {
    ownRows,
    ownOrders,
    groups: inheritedGroups,
  } = splitInheritedCashflow(rows, visibleOrders, data.inherited_emails);
  return (
    <div>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            color: "var(--ink)",
          }}
        >
          {t("memberDetail.cashflowTitle")}
        </span>
        {rows.length > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--ink-2)",
              background: "var(--surface-2)",
              padding: "2px 9px",
              borderRadius: 999,
            }}
          >
            {rows.length}
          </span>
        )}
      </div>

      {/* 3 ô tổng: lưới auto-fit thay vì 3 cột cứng — màn hẹp (điện thoại) thì
          xuống 2/1 ô mỗi hàng, số tiền không bị bóp thành "330 0 ₫". */}
      <div
        style={{
          display: "grid",
          // 86px: vừa đủ để cột phải 320px trên desktop GIỮ NGUYÊN 3 ô một hàng
          // (chỗ trống thật ~279px), còn máy hẹp (~320px) thì tự xuống 2 hàng.
          gridTemplateColumns: "repeat(auto-fit, minmax(86px, 1fr))",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <CashStat
          label={t("memberDetail.cashCharged")}
          value={data.charged_total}
          tone="ink"
        />
        <CashStat
          label={t("memberDetail.cashRefunded")}
          value={data.refunded_total}
          tone={data.refunded_total > 0 ? "success" : "ink"}
        />
        <CashStat
          label={t("memberDetail.cashNet")}
          value={data.net_total}
          tone={allRefunded ? "danger" : "ink"}
        />
      </div>

      {/* 3 ô tổng đã cộng cả tiền kế thừa → nói ngay ra đây, kẻo người đối soát
          tưởng email mới tự thu được từng đó. */}
      {inheritedGroups.length > 0 && (
        <div
          style={{
            fontSize: 10.5,
            lineHeight: 1.45,
            color: "var(--ink-3)",
            marginBottom: 10,
          }}
        >
          {t("memberDetail.cashInheritedNote", {
            emails: inheritedGroups.map((g) => g.email).join(", "),
          })}
        </div>
      )}

      {allRefunded && (
        <div
          style={{
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--danger)",
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-border)",
            borderRadius: 10,
            padding: "8px 11px",
            marginBottom: 10,
          }}
        >
          {t("memberDetail.cashAllRefunded")}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {t("memberDetail.cashEmpty")}
        </div>
      ) : (
        <CashLedger rows={ownRows} t={t} txnKind={txnKind} formatDateTime={formatDateTime} />
      )}

      {ownOrders.length > 0 && (
        <CashOrders
          orders={ownOrders}
          email={data.email}
          t={t}
          orderStatus={orderStatus}
          formatDateTime={formatDateTime}
        />
      )}

      {inheritedGroups.map((g) => (
        <InheritedCashBox
          key={g.email}
          email={g.email}
          rows={g.rows}
          orders={g.orders}
          t={t}
          txnKind={txnKind}
          orderStatus={orderStatus}
          formatDateTime={formatDateTime}
        />
      ))}
    </div>
  );
}

/** Khung riêng cho tiền của MỘT email cũ đã đổi sang email đang xem.

    Gom sang là đúng (cùng một ghế, cùng một lần trả tiền) nhưng để trần lẫn vào sổ
    cái của email mới thì đối soát sai: không ai biết khoản nào phát sinh dưới tên
    nào. Vì vậy bọc lại — viền + nền khác + nhãn ghi thẳng email cũ (user
    31/8/2026). */
function InheritedCashBox({
  email,
  rows,
  orders,
  t,
  txnKind,
  orderStatus,
  formatDateTime,
}: {
  email: string;
  rows: CashRow[];
  orders: MemberPaymentOrder[];
  t: TFn;
  txnKind: (value: string) => string;
  orderStatus: (value: string) => string;
  formatDateTime: (d: string) => string;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 11px 11px",
        background: "var(--surface-2)",
        border: "1px dashed var(--border)",
        borderRadius: 12,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--ink-3)",
          marginBottom: 3,
        }}
      >
        {t("memberDetail.cashInheritedTitle")}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--ink-2)",
          wordBreak: "break-all",
          marginBottom: 3,
        }}
      >
        {email}
      </div>
      <div
        style={{
          fontSize: 10.5,
          lineHeight: 1.45,
          color: "var(--ink-3)",
          marginBottom: 8,
        }}
      >
        {t("memberDetail.cashInheritedHint")}
      </div>
      {rows.length > 0 && (
        <CashLedger
          rows={rows}
          t={t}
          txnKind={txnKind}
          formatDateTime={formatDateTime}
        />
      )}
      {orders.length > 0 && (
        <CashOrders
          orders={orders}
          email={email}
          t={t}
          orderStatus={orderStatus}
          formatDateTime={formatDateTime}
        />
      )}
    </div>
  );
}

/** Danh sách hoá đơn QR (kèm tiêu đề + chú thích "tiền vào ví"). */
function CashOrders({
  orders,
  email,
  t,
  orderStatus,
  formatDateTime,
}: {
  orders: MemberPaymentOrder[];
  email: string;
  t: TFn;
  orderStatus: (value: string) => string;
  formatDateTime: (d: string) => string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--ink-3)",
          marginBottom: 7,
        }}
      >
        {t("memberDetail.cashOrdersTitle")}
      </div>
      {/* Chống hiểu nhầm (user 2026-08-04): nhìn "330.000 ₫ · Đã thanh toán" mà
          không biết là tiền cộng hay trừ. Tiền QR là khách CHUYỂN VÀO ví; khoản
          trừ phí nằm ở sổ cái phía trên. Nói thẳng ra đây + mỗi dòng có dấu +. */}
      <div
        style={{
          fontSize: 10.5,
          lineHeight: 1.45,
          color: "var(--ink-3)",
          marginBottom: 7,
        }}
      >
        {t("memberDetail.cashOrdersHint")}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {orders.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            email={email}
            t={t}
            orderStatus={orderStatus}
            formatDateTime={formatDateTime}
          />
        ))}
      </div>
    </div>
  );
}

/** Sổ cái ví: mỗi dòng là một khoản, hoặc CẶP phí ↔ hoàn của lượt mời hỏng. */
function CashLedger({
  rows,
  t,
  txnKind,
  formatDateTime,
}: {
  rows: CashRow[];
  t: TFn;
  txnKind: (value: string) => string;
  formatDateTime: (d: string) => string;
}) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((row) => {
        /* Lượt mời HỎNG: phí trừ rồi hoàn lại đủ ⇒ email này không mất đồng nào
           cho lượt đó. Một dòng, số tiền gạch ngang + 0 ₫ — thay vì 2 dòng ngược
           dấu ở 2 chỗ để người xem tự trừ (user 2026-08-26). */
        if (row.type === "voided") {
          const { fee, refund } = row;
          return (
            <div
              key={fee.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 11px",
                background: "var(--bg)",
                border: "1px dashed var(--border)",
                borderRadius: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>
                  {t("memberDetail.cashVoidedTitle")}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  {formatDateTime(fee.created_at)} →{" "}
                  {t("memberDetail.cashVoidedRefundedAt", {
                    time: formatDateTime(refund.created_at),
                  })}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--ink-3)",
                    textDecoration: "line-through",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatVnd(fee.amount)}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink-2)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatVnd(0)}
                </div>
              </div>
            </div>
          );
        }
        const e = row.entry;
        const positive = e.amount > 0;
        return (
          <div
            key={e.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "8px 11px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
                {txnKind(e.kind)}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: "var(--ink-3)",
                  marginTop: 2,
                }}
              >
                {formatDateTime(e.created_at)}
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: positive ? "var(--success)" : "var(--ink)",
                  whiteSpace: "nowrap",
                }}
              >
                {positive ? "+" : ""}
                {formatVnd(e.amount)}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: "var(--ink-3)",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                }}
                title={t("memberDetail.cashBalanceAfter")}
              >
                {formatVnd(e.balance_after)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}


/** Một hoá đơn QR ở panel thành viên — bấm vào để xem tiền đó đã mời cho những ai.

    Hoá đơn thường trả cho cả LƯỢT mời (có lượt 17 email, 5.610.000₫): nhìn con số
    tổng không biết phần của email đang xem là bao nhiêu, càng không biết email nào
    trong lượt mời hỏng đã hoàn tiền (user 2026-08-29). Bung ra là thấy ✓/✕ từng
    email — API tính sẵn ở `allocations`, xem members/payments.md §2.2.

    "HOÁ ĐƠN THẤT BẠI" = lượt mời của CHÍNH email này hỏng nên phí đã hoàn về ví,
    KHÔNG phải là chưa nhận được tiền (tiền vẫn nằm ở ví). Vẫn trình bày y như cũ
    (gạch ngang + viền nét đứt), chỉ mờ đi và đổi nhãn thành "Đã hoàn tiền". */
function OrderCard({
  order: o,
  email,
  t,
  orderStatus,
  formatDateTime,
}: {
  order: MemberPaymentOrder;
  email: string;
  t: TFn;
  orderStatus: (value: string) => string;
  formatDateTime: (d: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const allocations = o.allocations ?? [];
  /* Nạp qua QR rồi lượt mời HỎNG → phí quay về ví ⇒ mã nạp này rốt cuộc không đổi
     lấy gì. Để nguyên "Đã thanh toán · +330.000" là nói dối người đối soát (user
     2026-08-27) → gạch ngang đúng như dòng phí đã hoàn ở sổ cái phía trên. Tiền vẫn
     nằm ở ví, chỉ là không còn ứng với dịch vụ nào — nói rõ ở tooltip. */
  const voided = o.member_fee_refunded === true || o.fee_refunded === true;
  const paidIn = o.status === "paid" && !voided;
  const canOpen = allocations.length > 0;
  // Esc đóng pop-up phân bổ TRƯỚC, không để phím đó rơi xuống đóng luôn modal chi
  // tiết thành viên bên dưới.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const failedHint = o.member_fee_refunded
    ? t("memberDetail.cashOrderFailedHint")
    : t("memberDetail.cashOrderVoidedHint");
  return (
    <div
      style={{
        padding: "8px 11px",
        background: "var(--bg)",
        border: voided ? "1px dashed var(--border)" : "1px solid var(--border)",
        borderRadius: 10,
        display: "grid",
        gap: 4,
        // Hoá đơn thất bại: hiện y như cũ, chỉ mờ hơn để không tranh chỗ với
        // hoá đơn còn hiệu lực (user 2026-08-29).
        opacity: voided ? 0.62 : 1,
        cursor: canOpen ? "pointer" : undefined,
      }}
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-expanded={canOpen ? open : undefined}
      onClick={canOpen ? () => setOpen((v) => !v) : undefined}
      onKeyDown={
        canOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen((v) => !v);
              }
            }
          : undefined
      }
    >
      {/* Cột dòng tiền chỉ rộng 320px → xếp 2 dòng thay vì nhồi mã + giờ + số tiền
          + trạng thái trên một hàng rồi để chữ tự gãy. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: voided ? "var(--ink-3)" : "var(--ink)",
            textDecoration: voided ? "line-through" : undefined,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={o.ref_code}
        >
          {o.ref_code}
        </span>
        <span
          className={
            voided
              ? "badge badge-neutral badge-plain"
              : (ORDER_STATUS_BADGE[o.status] ?? "badge badge-neutral badge-plain")
          }
          style={{ flexShrink: 0, whiteSpace: "nowrap" }}
          title={voided ? failedHint : undefined}
        >
          {voided ? t("memberDetail.cashOrderRefunded") : orderStatus(o.status)}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--ink-3)",
            whiteSpace: "nowrap",
          }}
        >
          {formatDateTime(o.paid_at ?? o.created_at)}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            fontWeight: paidIn ? 600 : 400,
            color: paidIn ? "var(--success)" : "var(--ink-3)",
            textDecoration: voided ? "line-through" : undefined,
            whiteSpace: "nowrap",
          }}
          title={
            voided
              ? failedHint
              : paidIn
                ? t("memberDetail.cashOrderPaidIn")
                : t("memberDetail.cashOrderNotIn")
          }
        >
          {paidIn ? "+" : ""}
          {formatVnd(o.paid_amount_vnd ?? o.amount_vnd)}
        </span>
      </div>
      {canOpen && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10.5,
            color: "var(--ink-3)",
          }}
        >
          <span style={{ display: "inline-block" }}>›</span>
          {t("memberDetail.cashOrderAllocShow", { n: allocations.length })}
        </div>
      )}
      {/* Phân bổ mở thành POP-UP RIÊNG, không bung tại chỗ: cột dòng tiền chỉ rộng
          320px, nhồi gần 20 dòng "email + số tiền" vào đó thì email bị cắt cụt, số
          tiền tràn khỏi mép và cả modal sinh thanh cuộn ngang (user 2026-08-29).
          Pop-up có bề ngang riêng nên đọc trọn email dài lẫn số tiền.
          Bấm nền / Esc để đóng; click bên trong CHẶN nổi bọt để không đóng lây
          modal chi tiết thành viên bên dưới. */}
      {canOpen && open && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            background: "rgba(0,0,0,.45)",
            cursor: "default",
          }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              width: "min(560px, 100%)",
              maxHeight: "calc(80vh / var(--ui-scale))",
              display: "flex",
              flexDirection: "column",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              boxShadow:
                "0 40px 90px -30px rgba(0,0,0,.45), 0 12px 30px -14px rgba(0,0,0,.3)",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: "13px 16px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--ink-3)",
                  }}
                >
                  {t("memberDetail.cashOrderAllocTitle", {
                    n: allocations.length,
                  })}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={o.ref_code}
                >
                  {o.ref_code}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--ink-3)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            <div
              style={{
                padding: "9px 11px",
                overflowY: "auto",
                display: "grid",
                gap: 3,
              }}
            >
              {allocations.map((a) => {
                const failed = a.status === "failed";
                const pending = a.status === "pending";
                const mine = a.email.toLowerCase() === email.toLowerCase();
                return (
                  <div
                    key={a.email}
                    title={t(
                      failed
                        ? "memberDetail.cashOrderAllocFailed"
                        : pending
                          ? "memberDetail.cashOrderAllocPending"
                          : "memberDetail.cashOrderAllocOk",
                    )}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 8px",
                      borderRadius: 8,
                      // Email đang xem nổi lên giữa cả lượt để khỏi phải dò mắt.
                      background: mine ? "var(--surface-2)" : undefined,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        flexShrink: 0,
                        width: 14,
                        textAlign: "center",
                        fontSize: 12,
                        fontWeight: 700,
                        color: failed
                          ? "var(--danger)"
                          : pending
                            ? "var(--ink-3)"
                            : "var(--success)",
                      }}
                    >
                      {failed ? "✕" : pending ? "◦" : "✓"}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        fontWeight: mine ? 700 : 400,
                        color: failed ? "var(--ink-3)" : "var(--ink-2)",
                        textDecoration: failed ? "line-through" : undefined,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={a.email}
                    >
                      {a.email}
                    </span>
                    <span
                      style={{
                        flexShrink: 0,
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--ink-3)",
                        textDecoration: failed ? "line-through" : undefined,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.amount > 0
                        ? formatVnd(a.amount)
                        : t("memberDetail.cashOrderAllocFree")}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type StepState = "done" | "current" | "todo" | "failed";

/** Stepper ngang vòng đời LỜI MỜI: Đã thanh toán → Đã mời → Chờ tham gia → Đã
 *  tham gia. Phí thu TRƯỚC nên "Đã thanh toán" luôn xong. Trạng thái từng bước
 *  phân giải từ trạng thái CUỐI của CHÍNH lệnh mời này (terminal verified/failed):
 *    - FAILED  → dừng ở "Đã mời" (✕), các bước sau bỏ ngỏ.
 *    - COMPLETED → "Đã mời" xong; nếu là lời mời ĐANG hiệu lực (isLive) thì đi
 *      tiếp theo status sống của member (pending→Chờ tham gia, active→Đã tham gia).
 *    - Không có terminal → chỉ "đang mời", TRỪ khi là lời mời hiệu lực + member đã
 *      active (dữ liệu cũ thiếu terminal) thì coi như đã tham gia.
 *  ⚠️ CHỈ lời mời hiệu lực (isLive = lần mời mới nhất) mới được suy theo
 *  member.status. Lời mời CŨ đã bị thay bằng lần mời sau KHÔNG mượn status sống —
 *  nếu không, lời mời HỎNG trước đó sẽ hiện nhầm "Đã tham gia" vì member cuối cùng
 *  vào được nhờ lần mời KHÁC (bug user báo 2026-07-15).
 *  Bước đã qua ✓ (xanh), bước hiện tại ● (đậm), bước chưa tới ○ (mờ), lỗi ✕ (đỏ). */
function InviteStepper({
  memberStatus,
  terminalResult,
  isLive,
  t,
}: {
  memberStatus: string;
  terminalResult: string | undefined;
  isLive: boolean;
  t: TFn;
}) {
  const failed = terminalResult === "FAILED";
  const completed = terminalResult === "COMPLETED";
  const liveActive = isLive && memberStatus === "active";
  const livePending = isLive && memberStatus === "pending";
  // Trạng thái 4 bước: [thanh toán, mời, chờ tham gia, tham gia].
  const s: StepState[] = ["done", "todo", "todo", "todo"];
  if (failed) {
    s[1] = "failed";
  } else if (completed) {
    s[1] = "done";
    if (liveActive) {
      s[2] = "done";
      s[3] = "current";
    } else if (livePending) {
      s[2] = "current";
    }
    // COMPLETED nhưng đã bị thay bằng lần mời sau (không live) → dừng ở "Đã mời".
  } else if (liveActive) {
    // Dữ liệu cũ: thiếu terminal nhưng member đã vào qua chính lời mời này.
    s[1] = "done";
    s[2] = "done";
    s[3] = "current";
  } else {
    s[1] = "current"; // chưa có kết quả → đang mời
  }
  const steps = [
    t("memberLog.stage.paid"),
    t("memberLog.stage.invited"),
    t("memberLog.stage.waiting"),
    t("memberLog.stage.joined"),
  ];
  const stateOf = (i: number): StepState => s[i];
  const ICON = { done: "✓", current: "●", todo: "○", failed: "✕" } as const;
  const colorOf = (state: "done" | "current" | "todo" | "failed", i: number) => {
    if (state === "done") return "var(--success)";
    if (state === "failed") return "var(--danger)";
    if (state === "current")
      return i === 3 ? "var(--success)" : "var(--warning-accent)";
    return "var(--ink-3)";
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 5,
        marginTop: 8,
      }}
    >
      {steps.map((label, i) => {
        const state = stateOf(i);
        const color = colorOf(state, i);
        return (
          <div
            key={i}
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            {i > 0 && (
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 1,
                  background:
                    stateOf(i - 1) === "done"
                      ? "var(--success)"
                      : "var(--border-strong)",
                  flexShrink: 0,
                }}
              />
            )}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: state === "current" || state === "failed" ? 600 : 500,
                color,
                whiteSpace: "nowrap",
              }}
            >
              <span aria-hidden style={{ fontSize: 9 }}>
                {ICON[state]}
              </span>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ruột của modal — chỉ biết HIỂN THỊ 1 email. Việc "đang xem email nào" do
 * `MemberDetailModal` (cuối file) giữ, vì bấm mũi tên "→ email mới" sẽ đổi cả
 * workspace lẫn member đang xem.
 */
function MemberDetailView({
  workspaceId,
  member,
  onClose,
  onOpenChainMember,
  onBack,
  backEmail,
}: {
  workspaceId: string;
  member: Member;
  onClose: () => void;
  /** Bấm 1 chặng trong chuỗi "đã đổi sang" → mở chi tiết email đó. */
  onOpenChainMember: (next: AddedMember) => void;
  /** Có mặt khi đang đứng ở một email mở TỪ mũi tên (có chỗ để quay lại). */
  onBack?: () => void;
  backEmail?: string;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const txnKindLabel = useTranslateEnum("memberDetail.txnKind");
  // Dưới 1180px không đủ chỗ cho 3 cột (thẻ thông tin | kỳ hạn + lịch sử | dòng
  // tiền) → dòng tiền xếp vào luồng dọc thay vì đứng thành cột riêng.
  const narrowModal = useIsMobile(1179);
  // Điện thoại (≤768px): bỏ hẳn bố cục cột — sidebar 284px + cột giữa cạnh nhau
  // trên màn 390px làm cột giữa còn ~60px, chữ gãy từng ký tự (ảnh user 14/8/2026).
  // Mobile xếp DỌC: thông tin → kỳ thanh toán → dòng tiền → lịch sử, cuộn 1 mạch.
  const isMobile = useIsMobile();
  const orderStatusLabel = useTranslateEnum("memberDetail.orderStatus");
  const { user } = useAuth();
  const correctAddDate = useCorrectAddDate(workspaceId);
  // Modal là HUB quản lý thanh toán theo KỲ: sub-admin gửi yêu cầu, super-admin xác
  // nhận / huỷ từng kỳ. KHÔNG tự đóng sau mỗi thao tác — list invalidate + member
  // prop bản sống (parent truyền members.find(...)) làm mới các kỳ TẠI CHỖ để user
  // xử lý nhiều kỳ liên tiếp mà không phải mở lại.
  const isSuperAdmin = user?.is_super_admin === true;
  const cycles = member.cycles ?? [];

  // Mốc thời gian trong thẻ thông tin: hiện chi tiết tới giây.
  const fmtSec = (v: string) => formatDateTime(v, undefined, WITH_SECONDS);

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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "nowrap",
        justifyContent: "flex-end",
        whiteSpace: "nowrap",
      }}
    >
      <span>{renewAnchor ? fmtSec(renewAnchor) : "—"}</span>
      {canEditAddDate && (
        <button
          type="button"
          onClick={() => setEditingAddDate(true)}
          title={t("addDate.editBtn")}
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            background: "var(--warning-bg)",
            color: "var(--warning)",
            border: "1px solid var(--warning-border)",
            padding: "1px 6px",
            borderRadius: 5,
            cursor: "pointer",
          }}
        >
          {t("addDate.editBtn")}
        </button>
      )}
      {/* Đã sửa 1 lần (add_date_corrected_at) → chỉ hiện ngày, KHÔNG hiện nút sửa
          (canEditAddDate=false) lẫn ghi chú "đã khoá" — theo yêu cầu user. */}
    </span>
  );

  // Phí mời RIÊNG của member (feature 003) — CHỈ super-admin đặt/sửa. NULL = phí
  // mặc định. Áp cho lần mời/gia hạn kế tiếp (không hồi tố lời mời đã trừ).
  const setMemberFee = useSetMemberFee(workspaceId);
  const [editingFee, setEditingFee] = useState(false);
  const [feeInput, setFeeInput] = useState<string>(
    member.fee_vnd != null ? String(member.fee_vnd) : "",
  );
  // Phí HIỆU LỰC = COALESCE(member.fee_vnd, phí đại lý người mời, phí hệ thống) —
  // mirror BE payment_flow.effective_fee. Trước đây modal chỉ đọc member.fee_vnd nên
  // khi super-admin đặt phí cho đại lý (users.invite_fee_vnd) member vẫn hiện "Mặc
  // định" (không đồng bộ). Super-admin đã có sẵn 2 nguồn dưới nên phân giải ở client.
  const { data: adminUsers } = useWalletAdminUsers(isSuperAdmin);
  const { data: paySettings } = usePaymentSettings(isSuperAdmin);
  const feeIsOverride = member.fee_vnd != null;
  const ownerFee = member.invited_by_user_id
    ? adminUsers?.find((u) => u.user_id === member.invited_by_user_id)?.invite_fee_vnd ?? null
    : null;
  const inheritedFee = ownerFee ?? paySettings?.invite_fee_vnd ?? null; // phí khi KHÔNG đặt riêng
  const effectiveFee = member.fee_vnd ?? inheritedFee; // đơn giá/tháng thực áp
  const saveFee = () => {
    if (setMemberFee.isPending) return;
    const trimmed = feeInput.trim();
    const fee_vnd = trimmed === "" ? null : Math.max(0, Math.floor(Number(trimmed)));
    if (fee_vnd != null && Number.isNaN(fee_vnd)) return;
    setMemberFee.mutate(
      { memberId: member.id, fee_vnd },
      { onSuccess: () => setEditingFee(false) },
    );
  };
  const feeValue: ReactNode = editingFee ? (
    <div style={{ display: "grid", gap: 6 }}>
      <input
        type="number"
        min={0}
        step={1000}
        placeholder={inheritedFee != null ? formatVnd(inheritedFee) : t("memberDetail.feeDefaultPlaceholder")}
        className="form-input"
        value={feeInput}
        onChange={(e) => setFeeInput(e.target.value)}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={saveFee} disabled={setMemberFee.isPending}>
          {setMemberFee.isPending ? t("common.loading") : t("common.save")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingFee(false)} disabled={setMemberFee.isPending}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  ) : (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end", whiteSpace: "nowrap" }}>
      <span>{effectiveFee != null ? formatVnd(effectiveFee) : t("memberDetail.feeDefault")}</span>
      {effectiveFee != null && (
        <span
          title={feeIsOverride ? t("memberDetail.feeOverrideTag") : t("memberDetail.feeDefault")}
          style={{ fontSize: 9.5, fontWeight: 500, color: "var(--ink-3)", background: "var(--surface-2)", border: "1px solid var(--border)", padding: "1px 5px", borderRadius: 5 }}
        >
          {feeIsOverride ? t("memberDetail.feeOverrideTag") : t("memberDetail.feeDefault")}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setFeeInput(member.fee_vnd != null ? String(member.fee_vnd) : "");
          setEditingFee(true);
        }}
        title={t("common.edit")}
        style={{ fontSize: 9.5, fontWeight: 500, background: "var(--warning-bg)", color: "var(--warning)", border: "1px solid var(--warning-border)", padding: "1px 6px", borderRadius: 5, cursor: "pointer" }}
      >
        {t("common.edit")}
      </button>
    </span>
  );

  const qc = useQueryClient();

  // MỞ MODAL = LÀM MỚI HÀNG member ĐANG XEM. Cột trái + KỲ THANH TOÁN đọc từ prop
  // `member` (hàng của list đã nạp trước đó), trong khi LỊCH SỬ và DÒNG TIỀN gọi API
  // ngay khi mở → trang mở từ lâu cho ra cảnh nửa tươi nửa cũ: lịch sử đã thấy lượt
  // mời lại mà hạn dùng/kỳ vẫn là số của kỳ cũ, nhìn như dữ liệu mâu thuẫn (ca thật
  // phanlebinh999@gmail.com 13/8/2026 — DB đúng, chỉ màn hình cũ). Invalidate list ở
  // đây để hàng đó refetch; ba trang gọi modal đều đã lấy bản mới nhất theo id nên
  // prop tự cập nhật. Prefix key → trúng mọi biến thể ("members"/workspaceId,
  // "added-members"/userId). Chỉ chạy khi đổi email đang xem, không lặp.
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["members"] });
    qc.invalidateQueries({ queryKey: ["added-members"] });
  }, [qc, member.id]);

  // Người nhận NHẮC GIA HẠN chỉ định cho riêng email này (feature 004). Bỏ trống =
  // nhắc về đại lý đã add. Nhập @username thì phải chờ người đó bấm /start bot mới
  // gửi được (ràng buộc Telegram) — trạng thái đó hiện bằng chip "chờ kết nối".
  const [editingNotify, setEditingNotify] = useState(false);
  const [notifyInput, setNotifyInput] = useState(member.notify_telegram_target ?? "");
  const saveNotifyTarget = useMutation({
    mutationFn: (target: string | null) =>
      api<{ target: string | null; chat_id: number | null; resolved: boolean }>(
        `/api/v1/workspaces/${workspaceId}/members/${member.id}/notify-target`,
        { method: "PATCH", body: JSON.stringify({ target }) },
      ),
    onSuccess: () => {
      setEditingNotify(false);
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["added-members"] });
      toast.success(t("telegram.targetSaved"));
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? String(e.detail) : t("telegram.targetError")),
  });
  const notifyValue: ReactNode = editingNotify ? (
    <div style={{ display: "grid", gap: 6 }}>
      <input
        className="form-input"
        placeholder={t("telegram.targetPlaceholder")}
        value={notifyInput}
        onChange={(e) => setNotifyInput(e.target.value)}
      />
      <div style={{ fontSize: 11, color: "var(--ink-3)", textAlign: "left" }}>
        {t("telegram.targetHint")}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={saveNotifyTarget.isPending}
          onClick={() => saveNotifyTarget.mutate(notifyInput.trim() || null)}
        >
          {saveNotifyTarget.isPending ? t("common.loading") : t("common.save")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={saveNotifyTarget.isPending}
          onClick={() => setEditingNotify(false)}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  ) : (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        justifyContent: "flex-end",
        whiteSpace: "nowrap",
      }}
    >
      <span>{member.notify_telegram_target ?? "—"}</span>
      {member.notify_telegram_target && (
        <span
          title={
            member.notify_telegram_chat_id
              ? t("telegram.targetReady")
              : t("telegram.targetPending")
          }
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            color: member.notify_telegram_chat_id ? "var(--success)" : "var(--warning)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            padding: "1px 5px",
            borderRadius: 5,
          }}
        >
          {member.notify_telegram_chat_id
            ? t("telegram.targetReady")
            : t("telegram.targetPending")}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setNotifyInput(member.notify_telegram_target ?? "");
          setEditingNotify(true);
        }}
        title={t("common.edit")}
        style={{
          fontSize: 9.5,
          fontWeight: 500,
          background: "var(--warning-bg)",
          color: "var(--warning)",
          border: "1px solid var(--warning-border)",
          padding: "1px 6px",
          borderRadius: 5,
          cursor: "pointer",
        }}
      >
        {t("common.edit")}
      </button>
    </span>
  );

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["member-logs", workspaceId, member.id],
    queryFn: () =>
      api<MemberLog[]>(
        `/api/v1/workspaces/${workspaceId}/members/${member.id}/logs?limit=200`,
      ),
  });

  // Tên workspace cho timeline (id → tên). Dùng CHUNG queryKey ["workspaces"] với
  // các màn khác nên mở modal thường ăn cache, không đẻ thêm request.
  const { data: workspaceList } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/v1/workspaces"),
    staleTime: 5 * 60_000,
  });
  const wsNameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of workspaceList ?? []) map.set(w.id, w.name);
    // Sub-admin bị gỡ khỏi workspace vẫn xem được log email mình mời, nhưng GET
    // /workspaces không trả workspace đó nữa → vá bằng tên đi kèm hàng member
    // (tab "Email đã add" trả `workspace_name`).
    const own = (member as Partial<AddedMember>).workspace_name;
    if (own && !map.has(member.workspace_id)) map.set(member.workspace_id, own);
    return (id: unknown): string | null =>
      typeof id === "string" && id ? (map.get(id) ?? null) : null;
  }, [workspaceList, member]);

  // Dòng tiền của email (sổ cái ví + hoá đơn QR) — xem members/payments.md.
  const { data: payments } = useQuery({
    queryKey: ["member-payments", workspaceId, member.id],
    queryFn: () =>
      api<MemberPayments>(
        `/api/v1/workspaces/${workspaceId}/members/${member.id}/payments`,
      ),
  });

  // "Đã hoàn phí nhưng email vẫn trong team" là một món NỢ — mà nợ thì có lúc trả
  // xong. Luật nhận biết phải TRÙNG KHÍT với backend (`_flag_refunded_while_in_team`
  // trong members/reconcile.py), nếu không thì một bên im còn một bên vẫn đỏ:
  // có bút toán `adjust` ÂM ĐÚNG BẰNG lần hoàn gần nhất, xảy ra SAU lần hoàn đó.
  //
  // ⚠️ KHÔNG dùng "thực thu > 0" cho tiện: một lượt GIA HẠN tháng sau cũng đẩy thực
  // thu lên dương, và thế là món nợ của tháng trước bị đóng dấu "đã truy thu" trong
  // khi chưa ai thu đồng nào. Cũng KHÔNG dò khoá `meta` (`recollect_of`,
  // `manual_invite_at`…) vì mỗi lần truy thu tay trên production đánh dấu một kiểu.
  const refundDebtSettled = useMemo(
    () => isRefundDebtSettled(payments?.entries ?? []),
    [payments],
  );

  const actionLabel = (log: MemberLog) => {
    const action = log.action;
    // Nợ đã truy thu xong → dòng này phải đọc như LỊCH SỬ, không phải như một lời
    // đòi tiền còn treo (user 26/8/2026: "đã điều chỉnh trừ rồi nhưng thông báo vẫn
    // gây nhầm lẫn"). Chấm đỏ + chữ "cần truy thu" chỉ dành cho nợ CHƯA thu.
    if (action === "MEMBER_REFUND_WHILE_IN_TEAM" && refundDebtSettled) {
      return t("memberLog.action.MEMBER_REFUND_WHILE_IN_TEAM_SETTLED");
    }
    // Invite qua dashboard LUÔN đi đường bulk (kể cả 1 email). Chỉ gọi là "Mời
    // hàng loạt" khi mẻ đó thực sự có >1 email; mẻ 1 email hiện là "Lời mời".
    if (action === "MEMBER_BULK_INVITE_QUEUED") {
      const data = (log.data ?? {}) as Record<string, unknown>;
      const n = Array.isArray(data.entries) ? data.entries.length : 0;
      return n === 1
        ? t("memberLog.action.MEMBER_INVITE_SINGLE")
        : t("memberLog.action.MEMBER_BULK_INVITE_QUEUED");
    }
    if (
      action === "MEMBER_REMOVED_SYNCED" &&
      (log.data as Record<string, unknown> | null)?.removal_reason === "expired"
    ) {
      return t("memberLog.action.MEMBER_EXPIRED_REMOVE_QUEUED");
    }
    return KNOWN_ACTIONS.has(action) ? t(`memberLog.action.${action}`) : action;
  };

  // Suy ngược "chủ cũ" cho từng lần CHUYỂN CHỦ (kể cả log cũ không lưu chủ cũ):
  // duyệt timeline theo thứ tự TĂNG (API trả giảm dần → duyệt ngược), giữ chủ hiện
  // tại; chủ cũ của mỗi lần chuyển = chủ ngay TRƯỚC lần đó (null nếu chưa rõ/chưa
  // có chủ). Chỉ cập nhật theo target_username của MEMBER_OWNER_TRANSFERRED.
  const ownerFromById = new Map<string, string | null>();
  {
    let curOwner: string | null = null;
    for (let i = logs.length - 1; i >= 0; i--) {
      const lg = logs[i];
      if (lg.action !== "MEMBER_OWNER_TRANSFERRED") continue;
      ownerFromById.set(lg.id, curOwner);
      const to = (lg.data as Record<string, unknown> | null)?.target_username;
      if (typeof to === "string" && to) curOwner = to;
    }
  }

  // TRẠNG THÁI CUỐI của lệnh mời: backend ghi MEMBER_INVITE_VERIFIED (COMPLETED)
  // / MEMBER_INVITE_FAILED (FAILED) gắn member khi task xong. Gộp vào ĐÚNG dòng
  // "Lời mời" (khớp theo queue_item_id) để hiện xanh/đỏ thay vì PENDING đóng băng,
  // rồi ẩn dòng terminal độc lập (tránh trùng). Không có terminal → giữ PENDING.
  const queueIdOf = (log: MemberLog): string | undefined => {
    const d = log.data as Record<string, unknown> | null;
    if (d && typeof d.queue_item_id === "string") return d.queue_item_id;
    // Đổi email / chuyển hạn: task mời email mới (gộp MEMBER_INVITE_VERIFIED vào
    // dòng này). Chuyển hạn kiểu "cộng dồn" KHÔNG sinh task mời → invite_queue_item_id
    // là null, rơi xuống nhánh dưới như thường.
    if (
      (log.action === "MEMBER_EMAIL_CHANGED" ||
        log.action === "MEMBER_SUBSCRIPTION_TRANSFERRED") &&
      d
    ) {
      if (typeof d.invite_queue_item_id === "string") return d.invite_queue_item_id;
    }
    // Mời hàng loạt log target_type=QUEUE_ITEM, target_id CHÍNH LÀ queue id.
    if (log.action === "MEMBER_BULK_INVITE_QUEUED" && log.target_id)
      return log.target_id;
    return undefined;
  };
  // Terminal của LỜI MỜI (verified/failed) và của GỠ (đã xoá / thu hồi lời mời).
  // Cả hai đều mang data.queue_item_id trùng với dòng *_QUEUED tương ứng → gộp
  // vào đúng dòng để lật "Đang chờ" → "Thành công/Thất bại", rồi ẩn dòng terminal
  // độc lập (tránh trùng). Revoke ghi result="OK" → chuẩn hoá về COMPLETED cho
  // chấm xanh nhất quán với "đã xoá".
  const INVITE_TERMINAL = new Set([
    "MEMBER_INVITE_VERIFIED",
    "MEMBER_INVITE_FAILED",
  ]);
  const REMOVE_TERMINAL = new Set([
    "MEMBER_REMOVED_SYNCED",
    "MEMBER_INVITE_REVOKED",
  ]);
  const isTerminal = (action: string) =>
    INVITE_TERMINAL.has(action) || REMOVE_TERMINAL.has(action);
  const terminalByQueue = new Map<
    string,
    { result: string; timestamp: string; kind: "invite" | "remove" }
  >();
  for (const lg of logs) {
    if (!isTerminal(lg.action)) continue;
    const qid = queueIdOf(lg);
    if (!qid) continue;
    const kind = REMOVE_TERMINAL.has(lg.action) ? "remove" : "invite";
    // "OK" (revoke) → COMPLETED để hiện chấm xanh "Thành công".
    const result = lg.result === "OK" ? "COMPLETED" : lg.result;
    terminalByQueue.set(qid, { result, timestamp: lg.timestamp, kind });
  }
  // Dòng đổi email nhìn TỪ PHÍA EMAIL CŨ (backend trả log này cho cả hai đầu — xem
  // activity.py): lời mời trong lệnh đổi là của email MỚI, KHÔNG phải của email đang
  // xem. Nên dòng này không được mượn stepper "Đã mời → Chờ tham gia" (nó sẽ kể
  // vòng đời của email khác), cũng không được coi là lời mời "đang hiệu lực".
  const isChangeAwayFromHere = (log: MemberLog) =>
    log.action === "MEMBER_EMAIL_CHANGED" &&
    String((log.data as Record<string, unknown> | null)?.old_member_id ?? "") ===
      member.id;
  const isInviteQueued = (log: MemberLog) =>
    log.action === "MEMBER_INVITE_QUEUED" ||
    log.action === "MEMBER_BULK_INVITE_QUEUED" ||
    (log.action === "MEMBER_EMAIL_CHANGED" && !isChangeAwayFromHere(log)) ||
    log.action === "MEMBER_SUBSCRIPTION_TRANSFERRED";
  const isRemoveQueued = (log: MemberLog) =>
    log.action === "MEMBER_REMOVE_QUEUED" ||
    log.action === "MEMBER_BULK_REMOVE_QUEUED" ||
    log.action === "MEMBER_EXPIRED_REMOVE_QUEUED";
  const terminalFor = (log: MemberLog) =>
    isInviteQueued(log) || isRemoveQueued(log)
      ? terminalByQueue.get(queueIdOf(log) ?? "")
      : undefined;

  // Lời mời "đang hiệu lực" = lần mời MỚI NHẤT (logs trả về giảm dần theo thời gian
  // nên `find` đầu tiên là mới nhất). CHỈ lời mời này được suy vòng đời theo
  // member.status sống — các lần mời cũ hơn (đã bị thay) chỉ hiện theo terminal của
  // chính nó, tránh gán nhầm "Đã tham gia" cho lời mời HỎNG trước đó.
  const liveInviteId = logs.find((l) => isInviteQueued(l))?.id;

  // Gom log theo NGÀY (giữ nguyên thứ tự API trả về) → mỗi nhóm 1 tiêu đề ngày,
  // các dòng bên dưới chỉ hiện giờ. Không sắp xếp lại → logic hiển thị bất biến.
  // Ẩn dòng terminal độc lập (đã gộp badge vào dòng "Lời mời" tương ứng).
  const groups: { date: string; items: MemberLog[] }[] = [];
  // Terminal chỉ được ẩn khi dòng *_QUEUED mang CÙNG queue_item_id có mặt trong
  // logs (badge đã gộp vào đó). Member bị tạo lại (invite FAILED → sync auto-create
  // row mới) chỉ còn log terminal khớp theo email — QUEUED trỏ member id cũ có thể
  // vắng → ẩn nốt terminal là timeline TRỐNG dù badge đếm >0 (bug user 2026-08-01).
  const queuedIdsPresent = new Set(
    logs
      .filter((l) => isInviteQueued(l) || isRemoveQueued(l))
      .map((l) => queueIdOf(l))
      .filter((q): q is string => !!q),
  );
  for (const log of logs) {
    // Ẩn terminal ĐÃ gộp (dòng QUEUED tương ứng có mặt). Terminal mồ côi (thiếu
    // queue_item_id, hoặc QUEUED không nằm trong kết quả) → hiện độc lập.
    const qid = isTerminal(log.action) ? queueIdOf(log) : undefined;
    if (qid && queuedIdsPresent.has(qid)) continue;
    // Chỉ giữ 4 nhóm nghiệp vụ (mời/xoá email/gia hạn/đổi chủ) — xem chú thích
    // MODAL_TIMELINE_ACTIONS.
    if (!MODAL_TIMELINE_ACTIONS.has(log.action)) continue;
    const date = formatDate(log.timestamp);
    const g = groups.find((x) => x.date === date);
    if (g) g.items.push(log);
    else groups.push({ date, items: [log] });
  }

  // Chuỗi email thay thế (chỉ có ở tab "Đã xoá", dòng bị gỡ vì đổi email).
  const emailChain = member.email_changed_to ?? [];
  // id member từng chặng — backend trả kèm CÙNG THỨ TỰ. Thiếu id (dữ liệu cũ, hoặc
  // danh sách không đổ đầy) → chặng đó chỉ là chữ, không bấm được.
  const emailChainIds = member.email_changed_to_ids ?? [];
  // Chặng đang tải sau khi bấm (index) → hiện chấm chờ tại chỗ, chặn bấm chồng.
  const [chainLoading, setChainLoading] = useState<number | null>(null);
  const openChainMember = async (index: number) => {
    const id = emailChainIds[index];
    if (!id || chainLoading !== null) return;
    setChainLoading(index);
    try {
      // Email nhận thường KHÔNG có trong danh sách đang mở (nó còn sống, có khi
      // khác workspace) → hỏi thẳng backend theo id.
      const next = await api<AddedMember>(`/api/v1/added-members/${id}`);
      onOpenChainMember(next);
    } catch {
      // Kể cả 404 (email ngoài tầm nhìn của sub-admin) cũng nói bằng tiếng người:
      // detail thô của backend không giúp gì cho người đang xem.
      toast.error(
        t("memberDetail.chainLoadError", { email: emailChain[index] }),
      );
    } finally {
      setChainLoading(null);
    }
  };
  // Email ĐÃ RỜI TEAM: `subscription_end_at` trên dòng này KHÔNG còn là hạn đang
  // chạy — với ca đổi email nó là bản sao của hạn đã theo email mới đi. Vòng tròn
  // vì thế không được khoe "còn hạn / 27 ngày còn lại" như member đang sống.
  const isRemoved = member.status === "removed";

  // ── Vòng tròn "ngày còn lại" (sidebar) — dẫn xuất từ subscription_end_at ────
  //   không có hạn → ∞ (vô hạn) · còn hạn → số ngày · hết hạn → số ngày quá hạn.
  // Tỉ lệ vòng = ngày còn lại / (số tháng × 30) — khớp Model B (mốc + tháng×30).
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const hasSub = !!member.subscription_end_at;
  const endMs = hasSub ? new Date(member.subscription_end_at as string).getTime() : null;
  const diffDays = endMs != null ? Math.round((endMs - now) / DAY) : null;
  const expired = diffDays != null && diffDays <= 0;
  const cycleMonths =
    member.subscription_months && member.subscription_months > 0
      ? member.subscription_months
      : 1;
  const cycleDays = cycleMonths * 30;
  // Sidebar "Chu kỳ" phủ theo CÁC KỲ THỰC (kỳ đầu → hạn) để khớp danh sách "Kỳ thanh
  // toán" — kỳ luôn phủ toàn bộ thời gian còn hạn (mốc bắt đầu đã kẹp về ≤ hôm nay ở
  // backend). Fallback mốc gia hạn khi member chưa có kỳ nào.
  const sortedCycles = sortCycles(cycles);
  // Danh sách kỳ nay có thể trải NHIỀU ĐỢT tham gia (backend giữ kỳ cũ khi mời lại,
  // xem lib/cycles.ts) → đánh dấu kỳ mở đầu mỗi đợt để vẽ vạch ngăn.
  const stintGapIds = new Set(
    sortedCycles
      .filter((c, i) =>
        i > 0 ? startsNewStint(sortedCycles[i - 1].end_at, c.start_at) : false,
      )
      .map((c) => c.id),
  );
  // Vòng "Chu kỳ" ở sidebar chỉ phủ ĐỢT HIỆN TẠI: lấy kỳ đầu của cả danh sách thì mốc
  // kéo ngược về đợt đã kết thúc từ lâu → "còn X / tổng Y ngày" sai bét.
  const cycleSpanStart =
    currentStintCycles(sortedCycles)[0]?.start_at ?? renewAnchor;
  const cycleSpanDays =
    cycleSpanStart && endMs != null
      ? Math.max(
          1,
          Math.round((endMs - new Date(cycleSpanStart).getTime()) / DAY),
        )
      : cycleDays;
  const ringFraction = !hasSub
    ? 1
    : expired
      ? 1
      : Math.max(0, Math.min(1, (diffDays as number) / cycleDays));
  const ringColor = isRemoved
    ? "var(--ink-3)"
    : !hasSub
      ? "var(--success-strong)"
      : expired || (diffDays as number) < 3
        ? "var(--danger)"
        : (diffDays as number) < 7
          ? "var(--warning-accent)"
          : "var(--success-strong)";
  const ringDeg = Math.round(ringFraction * 360);
  const ringBig = isRemoved
    ? "—"
    : !hasSub
      ? "∞"
      : expired
        ? -(diffDays as number)
        : (diffDays as number);
  const ringLabel = isRemoved
    ? t("memberDetail.removedRingLabel")
    : !hasSub
      ? t("memberDetail.unlimited")
      : expired
        ? t("memberDetail.daysOverdueLabel")
        : t("memberDetail.daysLeftLabel");

  // Chip trạng thái hạn dùng dưới vòng tròn: xanh (còn hạn) / hổ phách (≤7 ngày) /
  // đỏ (hết hạn) / xanh (vô hạn).
  let pillBg = "var(--success-bg)";
  let pillColor = "var(--success)";
  let pillDot = "var(--success-strong)";
  let pillText = t("memberDetail.badgeUnlimited");
  if (isRemoved) {
    // Đã rời team: nói thẳng "đã xoá" + hạn/tiền giờ nằm ở đâu (nếu là ca đổi email),
    // thay vì chip xanh "còn hạn đến 20/9" của một email không còn tồn tại.
    pillBg = "var(--surface-2)";
    pillColor = "var(--ink-2)";
    pillDot = "var(--ink-3)";
    pillText =
      emailChain.length > 0
        ? t("memberDetail.badgeRemovedMovedTo", {
            email: emailChain[emailChain.length - 1],
          })
        : t("member.statusRemoved");
  } else if (hasSub) {
    if (expired) {
      pillBg = "var(--danger-bg)";
      pillColor = "var(--danger)";
      pillDot = "var(--danger)";
      pillText = t("member.subExpired", { n: -(diffDays as number) });
    } else {
      const until = t("memberDetail.untilDate", {
        date: formatDate(member.subscription_end_at as string),
      });
      pillText = `${t("memberDetail.badgeActive")} · ${until}`;
      if ((diffDays as number) < 7) {
        pillBg = "var(--warning-bg)";
        pillColor = "var(--warning)";
        pillDot = "var(--warning-accent)";
      }
    }
  }

  // Thẻ thông tin (sidebar) — nhãn mono in hoa bên trái, giá trị bên phải. Thứ tự
  // & nội dung khớp mockup; hàng "Ngày gia hạn" đặt riêng để mở form sửa full-width.
  const badge = (cls: string | undefined, text: string) => (
    <span className={cls ?? "badge badge-neutral"}>{text}</span>
  );
  const statusText = t(
    `member.status${member.status.charAt(0).toUpperCase()}${member.status.slice(1)}`,
  );
  // Nhánh Canva không có vai trò ChatGPT lẫn giới hạn tín dụng — hai hàng đó ẩn hẳn,
  // thay bằng liên kết mời riêng của email (thứ chỉ Canva mới có).
  const isCanva = usePlatform() === "canva";
  const roleText = member.chatgpt_role
    ? t(`member.role${roleKeySuffix(member.chatgpt_role)}`)
    : "—";
  const infoRows: { label: string; value: ReactNode; full?: boolean }[] = [
    {
      label: t("memberDetail.payment"),
      value: (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            justifyContent: "flex-end",
          }}
        >
          {/* Mô hình mới (user 2026-07-13): phí thu TRƯỚC → luôn "đã thanh toán";
              badge chỉ để hiển thị, KHÔNG còn nút huỷ/đánh dấu thủ công. */}
          {badge(
            PAYMENT_BADGE[member.payment_status],
            t(`memberDetail.payment.${member.payment_status}`),
          )}
        </span>
      ),
    },
    {
      label: t("member.colStatus"),
      value: badge(STATUS_BADGE[member.status], statusText),
    },
    ...(isCanva
      ? [
          {
            label: t("canva.colInviteLink"),
            value: member.invite_link ? (
              <a
                href={member.invite_link}
                target="_blank"
                rel="noreferrer"
                style={{ wordBreak: "break-all" }}
              >
                {member.invite_link}
              </a>
            ) : (
              t("canva.noInviteLink")
            ),
          },
        ]
      : [{ label: t("member.colRole"), value: roleText }]),
    ...(LICENSE_FEATURE_ENABLED
      ? [{ label: t("member.colLicenseType"), value: member.license_type ?? "—" }]
      : []),
    // Ngày gia hạn (mốc neo) — có nút sửa 1 lần cho super-admin. "Ngày hết hạn" =
    // mốc này + tháng×30. full=true khi đang sửa → hàng bung xuống full width.
    // Nhãn NGẮN + giá trị tới GIÂY (khớp mockup) để giá trị + nút sửa nằm 1 dòng.
    { label: t("memberDetail.shortRenew"), value: renewValue, full: editingAddDate },
    // Phí mời riêng của member (feature 003) — CHỈ super-admin thấy & sửa.
    ...(isSuperAdmin
      ? [{ label: t("memberDetail.inviteFee"), value: feeValue, full: editingFee }]
      : []),
    // Hạn dùng (thời hạn sử dụng) — hiện chi tiết tới giây theo yêu cầu.
    {
      label: t("memberDetail.subscriptionEnd"),
      value: member.subscription_end_at
        ? fmtSec(member.subscription_end_at)
        : t("memberDetail.unlimited"),
    },
    // Người nhận nhắc gia hạn chỉ định cho email này (feature 004). full=true khi
    // đang sửa → hàng bung full width để chứa ô nhập + ghi chú.
    {
      label: t("telegram.targetLabel"),
      value: notifyValue,
      full: editingNotify,
    },
    {
      label: t("memberDetail.shortJoined"),
      value: member.joined_at ? fmtSec(member.joined_at) : "—",
    },
    ...(isCanva
      ? []
      : [
          {
            label: t("memberDetail.shortUsage"),
            value:
              member.usage_limit_credits == null
                ? t("memberDetail.unlimited")
                : t("memberDetail.usageLimitValue", {
                    n: member.usage_limit_credits,
                  }),
          },
        ]),
    {
      label: t("memberDetail.shortSynced"),
      value: member.last_synced_at ? fmtSec(member.last_synced_at) : "—",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      style={{ padding: isMobile ? 10 : 24 }}
      onClick={onClose}
    >
      <div
        style={{
          // Nới từ 780 → 1180 (user 2026-08-04): thêm CỘT PHẢI "dòng tiền" chạy dọc
          // theo cả kỳ thanh toán lẫn lịch sử hoạt động. Dưới 1180px cột đó xếp
          // xuống luồng dọc (xem narrowModal) nên modal vẫn dùng được ở màn hẹp.
          width: "min(1180px, 100%)",
          maxHeight: isMobile
            ? "calc(94vh / var(--ui-scale))"
            : "calc(90vh / var(--ui-scale))",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: isMobile ? 16 : 20,
          boxShadow:
            "0 40px 90px -30px rgba(0,0,0,.45), 0 12px 30px -14px rgba(0,0,0,.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: nhãn + email + nút đóng. */}
        <div
          style={{
            padding: isMobile ? "13px 14px" : "18px 22px",
            display: "flex",
            alignItems: "center",
            gap: isMobile ? 10 : 14,
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {/* Đang xem một email mở TỪ mũi tên → nút quay lại email trước đó, để
              không phải đóng modal rồi tìm lại dòng cũ trong bảng. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              title={
                backEmail
                  ? t("memberDetail.chainBack", { email: backEmail })
                  : t("common.back")
              }
              aria-label={
                backEmail
                  ? t("memberDetail.chainBack", { email: backEmail })
                  : t("common.back")
              }
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ink-3)",
                fontSize: 14,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              ←
            </button>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                letterSpacing: "0.05em",
                marginBottom: 3,
                textTransform: "uppercase",
              }}
            >
              {t("memberDetail.title")}
            </div>
            <div
              style={{
                fontSize: isMobile ? 14.5 : 16,
                fontWeight: 600,
                color: "var(--ink)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={member.email}
            >
              {member.email}
            </div>
            {/* Email này đã ĐỔI SANG email khác → chỉ thẳng chuỗi thay thế ngay dưới
                tên, tới email nhận CUỐI CÙNG (A → B → C). Chỉ mũi tên, KHÔNG kèm chữ
                "đã đổi sang": mũi tên tự nói rồi (user chốt 2026-08-24). */}
            {emailChain.length > 0 && (
              <div
                style={{
                  marginTop: 5,
                  fontSize: isMobile ? 12 : 12.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-3)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {emailChain.map((email, i) => {
                  const isLast = i === emailChain.length - 1;
                  // Email CUỐI chuỗi là nơi đang giữ hạn + tiền → in đậm; các
                  // chặng giữa chỉ là đường đi, để nhạt.
                  const emailStyle = {
                    color: isLast ? "var(--ink)" : "var(--ink-3)",
                    fontWeight: isLast ? 600 : 400,
                  } as const;
                  const clickable = Boolean(emailChainIds[i]);
                  return (
                    <span
                      key={email}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span aria-hidden="true">→</span>
                      {/* Bấm vào email nhận = mở CHI TIẾT của nó ngay trong modal
                          này (hạn + tiền của email cũ đã theo nó đi, muốn xem tiếp
                          thì phải sang đó). Không có id thì để nguyên chữ. */}
                      {clickable ? (
                        <button
                          type="button"
                          onClick={() => void openChainMember(i)}
                          disabled={chainLoading !== null}
                          title={t("memberDetail.chainOpenHint", { email })}
                          style={{
                            ...emailStyle,
                            font: "inherit",
                            fontWeight: emailStyle.fontWeight,
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: chainLoading !== null ? "wait" : "pointer",
                            textDecoration: "underline",
                            textDecorationStyle: "dotted",
                            textUnderlineOffset: 3,
                          }}
                        >
                          {email}
                          {chainLoading === i && " …"}
                        </button>
                      ) : (
                        <span style={emailStyle}>{email}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--ink-3)",
              fontSize: 14,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* Thân: 2 cột — sidebar (vòng tròn + thẻ thông tin) + timeline lịch sử.
            KHÔNG dùng flex-wrap ở đây: với wrap, 2 cột giãn theo nội dung (align
            theo cross-size của flex-line = chiều cao nội dung) thay vì bó theo
            chiều cao body → overflow-y ở cột KHÔNG kích hoạt, timeline bị cắt
            không scroll được. nowrap + minHeight:0 mỗi cột thì cột mới bó đúng
            chiều cao body và scroll được (fix bug user báo). */}
        {/* Mobile: đổi trục sang DỌC và cho CHÍNH body cuộn — cột 284px + cột giữa
            trên màn 390px làm cột giữa còn ~60px (chữ gãy từng ký tự), còn hai vùng
            cuộn lồng nhau thì rất khó dùng bằng ngón tay. */}
        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            flex: 1,
            minHeight: 0,
            overflowX: "hidden",
            overflowY: isMobile ? "auto" : "hidden",
          }}
        >
          {/* ── Cột trái: sidebar ─────────────────────────────────────────── */}
          <div
            style={{
              width: isMobile ? "100%" : 284,
              flexShrink: 0,
              minHeight: 0,
              padding: isMobile ? "18px 14px" : "24px 20px",
              background: "var(--bg)",
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              gap: 20,
              overflowY: isMobile ? "visible" : "auto",
            }}
          >
            {/* Vòng tròn tiến trình "ngày còn lại". */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 13,
              }}
            >
              <div
                style={{
                  width: 138,
                  height: 138,
                  borderRadius: "50%",
                  background: `conic-gradient(${ringColor} ${ringDeg}deg, var(--border-strong) 0)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 108,
                    height: 108,
                    borderRadius: "50%",
                    background: "var(--surface)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 40,
                      fontWeight: 700,
                      lineHeight: 1,
                      color: "var(--ink)",
                    }}
                  >
                    {ringBig}
                  </span>
                  <span
                    style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 3 }}
                  >
                    {ringLabel}
                  </span>
                </div>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: pillBg,
                  color: pillColor,
                  fontWeight: 600,
                  fontSize: 12,
                  padding: "5px 13px",
                  borderRadius: 999,
                  textAlign: "center",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: pillDot,
                    flexShrink: 0,
                  }}
                />
                {pillText}
              </span>
              {hasSub && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3)",
                    textAlign: "center",
                  }}
                >
                  {t("memberDetail.cycleRange", {
                    start: formatDate(cycleSpanStart as string),
                    end: formatDate(member.subscription_end_at as string),
                    days: cycleSpanDays,
                  })}
                </div>
              )}
            </div>

            {/* Thẻ thông tin: nhãn ↔ giá trị. */}
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                overflow: "hidden",
              }}
            >
              {infoRows.map((r, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: r.full ? "stretch" : "center",
                    flexDirection: r.full ? "column" : "row",
                    justifyContent: "space-between",
                    gap: r.full ? 6 : 10,
                    padding: "11px 14px",
                    borderBottom:
                      i < infoRows.length - 1
                        ? "1px solid var(--border)"
                        : "none",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      letterSpacing: "0.05em",
                      color: "var(--ink-3)",
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {r.label}
                  </span>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--ink)",
                      textAlign: r.full ? "left" : "right",
                      whiteSpace: r.full ? "normal" : "nowrap",
                      minWidth: 0,
                    }}
                  >
                    {r.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Cột giữa: kỳ thanh toán + timeline lịch sử hoạt động ───────── */}
          <div
            style={{
              // Mobile: body đã cuộn sẵn → cột này KHÔNG được flex:1 (co lại còn
              // đúng phần trống rồi tự cuộn bên trong), để nó cao theo nội dung.
              flex: isMobile ? "0 0 auto" : 1,
              minWidth: 0,
              minHeight: 0,
              padding: isMobile ? "18px 14px" : "24px 24px",
              overflowY: isMobile ? "visible" : "auto",
            }}
          >
            {/* ── KỲ THANH TOÁN ─────────────────────────────────────────────
                Danh sách TỪNG chu kỳ gia hạn + hành động riêng lẻ (chuyển từ bảng
                "Email đã add" sang để bảng gọn khi nhiều kỳ — user 2026-07-11).
                sub-admin: gửi yêu cầu kỳ chưa gửi. super-admin: xác nhận kỳ chờ /
                huỷ kỳ đã trả. Chỉ hiện khi member đã có chu kỳ (từ AddedMember). */}
            {cycles.length > 0 && (
              <div style={{ marginBottom: 26 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 14,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      letterSpacing: "0.02em",
                      textTransform: "uppercase",
                      color: "var(--ink)",
                    }}
                  >
                    {t("memberDetail.cyclesTitle")}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--ink-2)",
                      background: "var(--surface-2)",
                      padding: "2px 9px",
                      borderRadius: 999,
                    }}
                  >
                    {cycles.length}
                  </span>
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {sortedCycles.map((c, i) => {
                    const range =
                      c.start_at && c.end_at
                        ? `${formatDate(c.start_at)} → ${formatDate(c.end_at)}`
                        : null;
                    // Ranh giới hai đợt: không có vạch này thì hai kỳ cách nhau 2
                    // tháng nhìn y hệt hai kỳ liền mạch, đọc ra lịch sử sai.
                    const prevEnd = i > 0 ? sortedCycles[i - 1].end_at : null;
                    const gapDays =
                      stintGapIds.has(c.id) && prevEnd && c.start_at
                        ? Math.max(
                            0,
                            Math.round(
                              (new Date(c.start_at).getTime() -
                                new Date(prevEnd).getTime()) /
                                DAY,
                            ),
                          )
                        : null;
                    return (
                      <Fragment key={c.id}>
                      {gapDays !== null && (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "2px 4px",
                          }}
                        >
                          <span
                            style={{
                              flex: 1,
                              height: 1,
                              background: "var(--border)",
                            }}
                          />
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--ink-3)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {t("memberDetail.cycleGap", { days: gapDays })}
                          </span>
                          <span
                            style={{
                              flex: 1,
                              height: 1,
                              background: "var(--border)",
                            }}
                          />
                        </div>
                      )}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "10px 13px",
                          background: "var(--bg)",
                          border: "1px solid var(--border)",
                          borderRadius: 11,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "var(--ink)",
                            }}
                          >
                            {t("addedEmails.cycleLabel", { n: c.cycle_number })}
                            {c.months ? (
                              <span
                                style={{
                                  fontWeight: 400,
                                  color: "var(--ink-3)",
                                  fontSize: 12,
                                }}
                              >
                                {" · "}
                                {t("memberDetail.cycleValue", { n: c.months })}
                              </span>
                            ) : null}
                          </div>
                          {range && (
                            <div
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 11,
                                color: "var(--ink-3)",
                                marginTop: 2,
                              }}
                            >
                              {range}
                            </div>
                          )}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexShrink: 0,
                          }}
                        >
                          {/* Mô hình mới (user 2026-07-13): phí thu TRƯỚC nên mọi
                              chu kỳ luôn ĐÃ THANH TOÁN — mục này chỉ còn là lịch sử,
                              KHÔNG còn nút xác nhận/gửi yêu cầu thủ công. */}
                          <CyclePaymentBadge status={c.payment_status} t={t} />
                        </div>
                      </div>
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Màn hẹp: không đủ chỗ làm cột riêng → xếp vào luồng dọc, ngay trên
                timeline. */}
            {narrowModal && payments && (
              <div style={{ marginBottom: 26 }}>
                <MemberCashflow
                  data={payments}
                  t={t}
                  txnKind={txnKindLabel}
                  orderStatus={orderStatusLabel}
                  formatDateTime={(d) => formatDateTime(d, undefined, WITH_SECONDS)}
                />
              </div>
            )}

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 18,
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  textTransform: "uppercase",
                  color: "var(--ink)",
                }}
              >
                {t("memberDetail.activityTitle")}
              </span>
              {!isLoading && logs.length > 0 && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--ink-2)",
                    background: "var(--surface-2)",
                    padding: "2px 9px",
                    borderRadius: 999,
                  }}
                >
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

            {!isLoading &&
              groups.map((g) => (
                <div key={g.date}>
                  {/* Tiêu đề nhóm theo ngày. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      paddingLeft: 24,
                      margin: "0 0 12px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        letterSpacing: "0.08em",
                        color: "var(--ink-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {g.date}
                    </span>
                    <span
                      style={{ flex: 1, height: 1, background: "var(--border)" }}
                    />
                  </div>
                  {g.items.map((log) => {
                    const segs = describeLog(
                      log,
                      member.email,
                      member.id,
                      ownerFromById.get(log.id),
                      t,
                      formatDateTime,
                      wsNameOf,
                    );
                    // Lệnh mời: dùng trạng thái CUỐI (verified/failed) nếu đã có,
                    // nếu chưa thì giữ result gốc (PENDING).
                    const terminal = terminalFor(log);
                    // FALLBACK dữ liệu cũ/seed: dòng Lời mời KHÔNG có event terminal
                    // (chưa từng ghi MEMBER_INVITE_VERIFIED) nhưng member giờ đã
                    // active ("Đã tham gia") → coi lời mời là thành công để timeline
                    // khớp huy hiệu, thay vì kẹt "Đang chờ" mãi. Chỉ suy từ trạng
                    // thái THẬT của member (active), không tự chấm khi còn pending.
                    // CHỈ áp cho lời mời ĐANG hiệu lực (mới nhất) — lời mời cũ đã bị
                    // thay KHÔNG mượn status sống (tránh chấm xanh cho lời mời hỏng).
                    const joinedFallback =
                      isInviteQueued(log) &&
                      !terminal &&
                      log.id === liveInviteId &&
                      member.status === "active";
                    // Cảnh báo nợ đã được trả → chấm xanh "đã xong", không còn là
                    // ERROR đỏ. Backend ghi ERROR ở thời điểm phát hiện và audit là
                    // sổ BẤT BIẾN, nên chỗ lật trạng thái phải nằm ở đây.
                    const effResult =
                      log.action === "MEMBER_REFUND_WHILE_IN_TEAM" &&
                      refundDebtSettled
                        ? "OK"
                        : terminal?.result
                          ? terminal.result
                          : joinedFallback
                            ? "COMPLETED"
                            : log.result;
                    const dot = RESULT_DOT[effResult] ?? "var(--ink-3)";
                    const ring = RESULT_RING[effResult] ?? "var(--surface-2)";
                    return (
                      <div key={log.id} style={{ display: "flex", gap: 13 }}>
                        {/* Chấm trạng thái + đường nối dọc. */}
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            paddingTop: 3,
                          }}
                        >
                          <div
                            style={{
                              width: 11,
                              height: 11,
                              borderRadius: "50%",
                              background: dot,
                              boxShadow: `0 0 0 3px ${ring}`,
                              flexShrink: 0,
                            }}
                          />
                          <div
                            style={{
                              flex: 1,
                              width: 2,
                              background: "var(--border)",
                              marginTop: 5,
                              minHeight: 8,
                            }}
                          />
                        </div>
                        <div style={{ flex: 1, minWidth: 0, paddingBottom: 14 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              gap: 10,
                              justifyContent: "space-between",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                flexWrap: "wrap",
                                minWidth: 0,
                              }}
                            >
                              <span
                                style={{
                                  fontWeight: 600,
                                  fontSize: 13.5,
                                  color: "var(--ink)",
                                }}
                              >
                                {actionLabel(log)}
                              </span>
                              {/* Lời mời dùng stepper 4 giai đoạn (dưới) thay cho
                                  badge trạng thái đơn; action khác giữ badge. */}
                              {!isInviteQueued(log) && (
                                <span
                                  style={{
                                    background: ring,
                                    color: dot,
                                    fontSize: 10,
                                    fontWeight: 600,
                                    padding: "2px 8px",
                                    borderRadius: 999,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {RESULT_META[effResult]
                                    ? `${RESULT_META[effResult].icon} ${t(RESULT_META[effResult].key)}`
                                    : effResult.toLowerCase()}
                                </span>
                              )}
                            </div>
                            <span
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 11,
                                color: "var(--ink-3)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {shortTime(log.timestamp)}
                            </span>
                          </div>
                          <div
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              color: "var(--ink-2)",
                              marginTop: 3,
                            }}
                          >
                            {actorLine(log, t)}
                          </div>
                          {/* Vòng đời lời mời: Đã thanh toán → Đã mời → Chờ tham
                              gia → Đã tham gia (chỉ dòng lời mời). */}
                          {isInviteQueued(log) && (
                            <InviteStepper
                              memberStatus={member.status}
                              terminalResult={terminal?.result}
                              isLive={log.id === liveInviteId}
                              t={t}
                            />
                          )}
                          {/* Mốc CUỐI của lệnh mời/gỡ (thành công/thất bại) — chỉ
                              hiện khi đã có trạng thái cuối, kèm giờ tới giây.
                              Gỡ (kind='remove') → "Đã xoá lúc"; mời → xác minh. */}
                          {terminal && (
                            <div
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 11,
                                color: dot,
                                marginTop: 3,
                              }}
                            >
                              {terminal.result === "FAILED" ? "✗ " : "✓ "}
                              {t(
                                terminal.kind === "remove"
                                  ? "memberLog.removedAt"
                                  : terminal.result === "FAILED"
                                    ? "memberLog.inviteFailedAt"
                                    : "memberLog.inviteVerifiedAt",
                                { time: shortTime(terminal.timestamp) },
                              )}
                            </div>
                          )}
                          {/* Chuyển trạng thái "Chờ tham gia → Đã tham gia" khi Đồng
                              bộ phát hiện thành viên đã chủ động chấp nhận lời mời
                              (tab Người dùng). Không thể biết mốc họ bấm chấp nhận
                              trong email — chỉ hiện được khi sync xác nhận. Cũng hiện
                              trên dòng Lời mời khi member đã active mà thiếu event
                              terminal (fallback dữ liệu cũ). */}
                          {/* Nợ do hoàn phí oan: nói thẳng bằng tiền là còn nợ hay
                              đã thu xong. Không có dòng này thì người đọc phải tự
                              ghép nhật ký với panel "Dòng tiền" mới hiểu — đúng chỗ
                              gây khó hiểu mà user chỉ ra 26/8/2026. Bản ghi cũ dùng
                              `refunded_vnd`, bản mới dùng `amount`. */}
                          {log.action === "MEMBER_REFUND_WHILE_IN_TEAM" && (
                            <div
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 11,
                                color: refundDebtSettled
                                  ? "var(--success)"
                                  : "var(--danger)",
                                marginTop: 3,
                              }}
                            >
                              {refundDebtSettled ? "✓ " : "! "}
                              {t(
                                refundDebtSettled
                                  ? "memberLog.refundDebtSettled"
                                  : "memberLog.refundDebtOpen",
                                {
                                  amount: formatVnd(
                                    Number(
                                      (log.data as Record<string, unknown> | null)
                                        ?.amount ??
                                        (log.data as Record<string, unknown> | null)
                                          ?.refunded_vnd ??
                                        0,
                                    ),
                                  ),
                                },
                              )}
                            </div>
                          )}
                          {log.action === "MEMBER_SYNC_PROMOTED_ACTIVE" && (
                            <div
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 11,
                                color: "var(--success)",
                                marginTop: 3,
                              }}
                            >
                              ✓ {t("memberLog.joinTransition")}
                            </div>
                          )}
                          {/* Chi tiết thay đổi: hạn cũ → mới, số tháng, vai trò, email… */}
                          {segs.length > 0 && (
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 6,
                                marginTop: 7,
                              }}
                            >
                              {segs.map((s, i) => (
                                <span
                                  key={i}
                                  style={{
                                    display: "inline-flex",
                                    gap: 6,
                                    alignItems: "baseline",
                                    background: "var(--bg)",
                                    border: "1px solid var(--border)",
                                    borderRadius: 8,
                                    padding: "3px 9px",
                                    fontSize: 11,
                                  }}
                                >
                                  <span style={{ color: "var(--ink-3)" }}>
                                    {s.label}
                                  </span>
                                  {s.kind === "pair" ? (
                                    <span style={{ color: "var(--ink)" }}>
                                      <span
                                        style={{
                                          textDecoration: "line-through",
                                          color: "var(--ink-3)",
                                        }}
                                      >
                                        {s.from}
                                      </span>
                                      <span style={{ color: "var(--ink-3)" }}>
                                        {" → "}
                                      </span>
                                      <span style={{ fontWeight: 600 }}>{s.to}</span>
                                    </span>
                                  ) : (
                                    <span
                                      style={{ color: "var(--ink)", fontWeight: 600 }}
                                    >
                                      {s.value}
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>

          {/* ── Cột phải: DÒNG TIỀN ────────────────────────────────────────
              Chạy dọc theo CẢ kỳ thanh toán lẫn lịch sử hoạt động (user
              2026-08-04). Nhờ vậy "email được dùng tới bao giờ" và "đã thu thật bao
              nhiêu" luôn nằm trong cùng tầm mắt — lệch nhau là thấy ngay. Cột có
              thanh cuộn riêng để lịch sử dài không đẩy phần tiền khỏi màn hình. */}
          {!narrowModal && payments && (
            <div
              style={{
                width: 320,
                flexShrink: 0,
                minHeight: 0,
                padding: "24px 20px",
                borderLeft: "1px solid var(--border)",
                background: "var(--bg)",
                overflowY: "auto",
              }}
            >
              <MemberCashflow
                data={payments}
                t={t}
                txnKind={txnKindLabel}
                orderStatus={orderStatusLabel}
                formatDateTime={(d) => formatDateTime(d, undefined, WITH_SECONDS)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Modal "Chi tiết thành viên" — bọc ngoài `MemberDetailView` để giữ NGĂN XẾP email
 * đang xem.
 *
 * Vì sao cần ngăn xếp: email bị gỡ do ĐỔI EMAIL hiện chuỗi "→ email mới" ở đầu
 * modal, và bấm vào đó phải mở chi tiết email nhận (hạn + tiền đã theo nó đi). Email
 * nhận có thể lại đổi tiếp (A → B → C) nên đường đi có nhiều tầng; nút ← lùi từng
 * tầng, đóng modal thì reset về email gốc.
 *
 * `key` ép remount khi đổi email đang xem: mọi state cục bộ của view (đang sửa phí,
 * đang sửa người nhắc, …) thuộc về ĐÚNG email đó, mang sang email khác là sai.
 */
export function MemberDetailModal({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: Member;
  onClose: () => void;
}) {
  const [chain, setChain] = useState<AddedMember[]>([]);
  const current = chain.length > 0 ? chain[chain.length - 1] : null;
  // Email sẽ quay về khi bấm ←: tầng trước đó, hoặc email gốc nếu đang ở tầng 1.
  const previousEmail =
    chain.length > 1 ? chain[chain.length - 2].email : member.email;

  return (
    <MemberDetailView
      key={current?.id ?? member.id}
      // Email nhận có thể nằm ở workspace KHÁC → mọi endpoint theo workspace phải
      // dùng workspace của chính email đang xem.
      workspaceId={current?.workspace_id ?? workspaceId}
      member={current ?? member}
      onClose={onClose}
      onOpenChainMember={(next) => setChain((prev) => [...prev, next])}
      onBack={
        chain.length > 0
          ? () => setChain((prev) => prev.slice(0, -1))
          : undefined
      }
      backEmail={chain.length > 0 ? previousEmail : undefined}
    />
  );
}
