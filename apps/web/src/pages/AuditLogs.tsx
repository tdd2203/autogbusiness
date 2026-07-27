import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { Chip, TimeCell } from "./Queue";
import { SearchInput } from "./Members";
import { useIsMobile } from "../hooks/useIsMobile";

type AuditLog = {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  result: string;
  target_type: string | null;
  target_id: string | null;
  data: Record<string, unknown> | null;
  // Tên workspace (backend suy từ data.workspace_id) — hiện ở cột Hành động.
  workspace_name?: string | null;
};

/* ------------------------------------------------------------------
 * Phân loại + trang trí sự kiện (áp mockup "Nhật ký kiểm tra").
 * Mỗi hành động được gom vào 1 nhóm ngữ nghĩa (bảo mật / thành viên /
 * thanh toán / hàng đợi) để nhấn mạnh trực quan cái gì đáng chú ý, và
 * hạ tông (routine) các sự kiện tự động của extension/hệ thống.
 * ------------------------------------------------------------------ */
type Cat = "security" | "member" | "billing" | "queue";
const CAT_ORDER: Cat[] = ["security", "member", "billing", "queue"];

/* Sub-type hàng đợi tác động lên thành viên → xếp vào nhóm "Thành viên" (dù đi
   qua QUEUE_*), để thao tác thành viên được làm nổi bật thay vì lẫn vào hàng đợi. */
const MEMBER_QUEUE_SUBS = new Set([
  "REMOVE_MEMBER",
  "INVITE_MEMBER",
  "CHANGE_ROLE",
  "CHANGE_LICENSE_TYPE",
]);

/** Nhóm ngữ nghĩa cho action code. `op`/`sub` = 2 phần quanh dấu ':'. */
function classify(action: string, actorType: string): Cat {
  const [op, sub] = action.split(":");
  if (
    op.startsWith("LOGIN") ||
    op === "PASSWORD_CHANGED" ||
    op === "USER_CREATED" ||
    op === "USER_PASSWORD_RESET" ||
    op === "SUPER_ADMIN_SEEDED" ||
    op.includes("API_KEY") ||
    op === "WORKSPACE_SETTINGS_UPDATED" ||
    op === "PAYMENT_SETTINGS_UPDATED"
  )
    return "security";
  // Thanh toán: CHỈ nạp ví + gia hạn (yêu cầu user 2026-07-20). Các sự kiện tiền
  // khác (phí mời, rút, điều chỉnh ví, đánh dấu đã trả, hoá đơn, mua ghế…) KHÔNG
  // vào nhóm này để chip "Thanh toán" gọn đúng 2 loại người dùng quan tâm.
  if (
    op === "WALLET_TOPUP_CREDITED" || // nạp qua QR/webhook
    op === "WALLET_ORDER_CREDITED" || // nạp qua lệnh nạp
    op === "MEMBER_SUBSCRIPTION_RENEWED" || // gia hạn (nghiệp vụ thành viên)
    op === "WALLET_RENEW_CHARGED" // gia hạn (trừ ví)
  )
    return "billing";
  if (op.startsWith("MEMBER_") || op.startsWith("WORKSPACE_")) return "member";
  if (op.startsWith("QUEUE_") && sub && MEMBER_QUEUE_SUBS.has(sub))
    return "member";
  if (
    op.startsWith("QUEUE_") ||
    op.startsWith("SYNC_") ||
    op.includes("RECONCILE") ||
    op.startsWith("UI_LABEL")
  )
    return "queue";
  return actorType === "ADMIN" ? "member" : "queue";
}

/* Sự kiện QUAN TRỌNG được gom theo NHÓM NGHIỆP VỤ, mỗi nhóm 1 màu riêng; sự kiện
   cùng nhóm dùng chung màu. Tab "Chính" (yêu cầu user 2026-07-20) CHỈ giữ 4 nhóm
   nghiệp vụ thành viên: mời · gỡ (xoá email) · gia hạn · đổi chủ. Các sự kiện khác
   (đăng nhập, đồng bộ, đổi hạn, đánh dấu thanh toán, giao dịch ví…) để tab "Khác"
   với màu xám trung tính → màu chỉ xuất hiện ở việc đáng chú ý, tránh loạn màu. */
type ImpGroup = "remove" | "invite" | "renew" | "owner";

const IMP_OP_GROUP: Record<string, ImpGroup> = {
  // xoá email (gỡ thành viên)
  MEMBER_REMOVE_QUEUED: "remove",
  MEMBER_BULK_REMOVE_QUEUED: "remove",
  MEMBER_REMOVED_SYNCED: "remove",
  MEMBER_EXPIRED_REMOVE_QUEUED: "remove",
  REVOKE_INVITES_QUEUED: "remove",
  MEMBER_INVITE_REVOKED: "remove",
  MEMBER_INVITE_REVOKE_FAILED: "remove",
  // Cảnh báo: đã tự động gỡ nhiều lần nhưng member vẫn còn trên ChatGPT → cần gỡ
  // tay. Thuộc nhóm remove để nổi lên tab "Chính" (admin phải thấy).
  MEMBER_REMOVE_STUCK: "remove",
  // mời thành viên — CẢ bước xếp lịch LẪN bước hoàn tất/xác minh/đối soát, để
  // lời mời luôn nằm ở tab "Chính" (giống remove có MEMBER_REMOVED_SYNCED). Nếu
  // chỉ đánh dấu bước *_QUEUED, khi dòng khởi tạo bị đẩy khỏi cửa sổ 200 dòng thì
  // lời mời biến mất khỏi tab mặc định dù backend vẫn ghi audit đầy đủ.
  MEMBER_INVITE_QUEUED: "invite",
  MEMBER_BULK_INVITE_QUEUED: "invite",
  MEMBER_INVITE_VERIFIED: "invite",
  MEMBER_INVITE_FAILED: "invite",
  MEMBER_INVITE_VERIFY_RECONCILE: "invite",
  // Đồng bộ phát hiện thành viên đã chấp nhận lời mời (pending → active): thuộc
  // vòng đời mời để nằm chung tab "Chính" với các bước mời/xác minh.
  MEMBER_SYNC_PROMOTED_ACTIVE: "invite",
  // gia hạn
  MEMBER_SUBSCRIPTION_RENEWED: "renew",
  // đổi chủ (chuyển/gán/thu hồi chủ sở hữu email)
  MEMBER_OWNER_CHANGED: "owner",
  MEMBER_OWNER_REVOKED: "owner",
  MEMBER_OWNER_TRANSFERRED: "owner",
  MEMBER_BULK_OWNER_ASSIGN: "owner",
};

/** Nhóm nghiệp vụ quan trọng của 1 action (null = không quan trọng). */
function importantGroup(action: string): ImpGroup | null {
  const [op, sub] = action.split(":");
  if (op in IMP_OP_GROUP) return IMP_OP_GROUP[op];
  // Gỡ/mời đi qua hàng đợi (QUEUE_PICKED:REMOVE_MEMBER…) thuộc cùng nhóm.
  if (op.startsWith("QUEUE_")) {
    if (sub === "REMOVE_MEMBER") return "remove";
    if (sub === "INVITE_MEMBER") return "invite";
  }
  return null;
}

type GroupColor = {
  accent: string;
  tint: string;
  chipBg: string;
  chipText: string;
  labelKey: string;
};

const IMP_COLOR: Record<ImpGroup, GroupColor> = {
  remove: { accent: "#c0392b", tint: "#fbeeeb", chipBg: "#f4ddd8", chipText: "#a2493b", labelKey: "audit.grp.remove" },
  invite: { accent: "#3a5bd0", tint: "#eef2fd", chipBg: "#dde5fa", chipText: "#2f47a8", labelKey: "audit.grp.invite" },
  renew: { accent: "#2f8a52", tint: "#e9f4ed", chipBg: "#d3ecdc", chipText: "#1f6b3f", labelKey: "audit.grp.renew" },
  owner: { accent: "#b5822a", tint: "#faf3e6", chipBg: "#f0e2c4", chipText: "#8a6416", labelKey: "audit.grp.owner" },
};

// Màu trung tính cho sự kiện không quan trọng.
const NEUTRAL_COLOR = {
  accent: "var(--ink-4)",
  tint: "transparent",
  chipBg: "var(--surface-2)",
  chipText: "var(--ink-3)",
};

/* Bản dịch tiêu đề hành động (kỹ thuật → tiếng Việt dễ đọc). zh-CN dùng
   chung bảng này (thuật ngữ mã hoá). Action lạ sẽ tự prettify. */
const ACT_TITLE: Record<string, string> = {
  QUEUE_CREATED: "Tạo việc trong hàng đợi",
  QUEUE_PICKED: "Nhận việc từ hàng đợi",
  QUEUE_UPDATED: "Cập nhật hàng đợi",
  QUEUE_APPROVED: "Duyệt việc hàng đợi",
  QUEUE_REJECTED: "Từ chối việc hàng đợi",
  QUEUE_CANCELED: "Huỷ việc hàng đợi",
  QUEUE_TIMEOUT: "Việc hàng đợi quá hạn",
  QUEUE_DRY_RUN: "Chạy thử hàng đợi",
  LOGIN_SUCCESS: "Đăng nhập thành công",
  LOGIN_FAILED: "Đăng nhập thất bại",
  LOGIN_BLOCKED_DISABLED: "Chặn đăng nhập · tài khoản khoá",
  LOGIN_BLOCKED_SPAM: "Chặn đăng nhập · nghi spam",
  PASSWORD_CHANGED: "Đổi mật khẩu",
  USER_CREATED: "Tạo tài khoản quản trị",
  USER_PASSWORD_RESET: "Đặt lại mật khẩu",
  SUPER_ADMIN_SEEDED: "Khởi tạo quản trị viên tổng",
  WORKSPACE_API_KEY_REGENERATED: "Tạo lại API key workspace",
  WORKSPACE_API_KEY_REVEALED: "Xem API key workspace",
  WORKSPACE_SETTINGS_UPDATED: "Thay đổi cấu hình workspace",
  PAYMENT_SETTINGS_UPDATED: "Thay đổi cấu hình thanh toán",
  WORKSPACE_CREATED: "Tạo workspace",
  WORKSPACE_UPDATED: "Cập nhật workspace",
  WORKSPACE_ASSIGNED: "Gán workspace",
  WORKSPACE_UNASSIGNED: "Gỡ gán workspace",
  WORKSPACE_SYNC_QUEUED: "Xếp lịch đồng bộ workspace",
  WORKSPACE_BILLING_SYNCED: "Đồng bộ thanh toán workspace",
  WORKSPACE_BILLING_SYNC_QUEUED: "Xếp lịch đồng bộ thanh toán",
  WORKSPACE_INVOICE_FEE_SET: "Đặt phí hoá đơn",
  WORKSPACE_CREDIT_BUDGET_SET: "Đặt ngân sách credit",
  MEMBER_INVITE_QUEUED: "Xếp lịch mời thành viên",
  MEMBER_BULK_INVITE_QUEUED: "Xếp lịch mời hàng loạt",
  MEMBER_BULK_UPSERT: "Cập nhật hàng loạt thành viên",
  MEMBER_BULK_OWNER_ASSIGN: "Gán chủ sở hữu hàng loạt",
  MEMBER_BULK_REMOVE_QUEUED: "Xếp lịch gỡ hàng loạt",
  MEMBER_REMOVE_QUEUED: "Xếp lịch gỡ thành viên",
  MEMBER_REMOVED_SYNCED: "Đã xoá (đồng bộ xong)",
  MEMBER_EXPIRED_REMOVE_QUEUED: "Xoá do hết hạn",
  MEMBER_REMOVE_STUCK: "Gỡ thất bại — cần gỡ tay",
  MEMBER_REMOVE_UNVERIFIED: "Gỡ chưa xác minh (giữ nguyên)",
  MEMBER_EMAIL_CHANGED: "Đổi email thành viên",
  MEMBER_ADD_DATE_CORRECTED: "Sửa ngày thêm",
  MEMBER_EXPIRY_BULK_SET: "Đặt hạn hàng loạt",
  MEMBER_ROLE_SYNCED: "Đồng bộ vai trò",
  MEMBER_CHANGE_ROLE_QUEUED: "Xếp lịch đổi vai trò",
  MEMBER_OWNER_CHANGED: "Đổi chủ sở hữu",
  MEMBER_OWNER_REVOKED: "Thu hồi chủ sở hữu",
  MEMBER_OWNER_TRANSFERRED: "Chuyển chủ sở hữu",
  MEMBER_LICENSE_TYPE_SYNCED: "Đồng bộ loại license",
  MEMBER_CHANGE_LICENSE_TYPE_QUEUED: "Xếp lịch đổi loại license",
  MEMBER_BULK_CHANGE_LICENSE_TYPE_QUEUED: "Xếp lịch đổi license hàng loạt",
  MEMBER_USAGE_LIMIT_SYNCED: "Đồng bộ giới hạn dùng",
  MEMBER_SYNC_PROMOTED_ACTIVE: "Thành viên đã tham gia",
  MEMBER_INVITE_VERIFIED: "Mời thành viên thành công",
  MEMBER_INVITE_FAILED: "Mời thành viên thất bại",
  MEMBER_INVITE_VERIFY_RECONCILE: "Đối soát mời thành viên",
  MEMBER_RECONCILE_SKIPPED: "Bỏ qua đối soát",
  MEMBER_PAYMENT_MARKED: "Đánh dấu đã thanh toán",
  MEMBER_PAYMENT_REQUESTED: "Yêu cầu thanh toán",
  MEMBER_SUBSCRIPTION_RENEWED: "Gia hạn gói thành viên",
  MEMBER_SUBSCRIPTION_UPDATED: "Cập nhật gói thành viên",
  MEMBER_SUBSCRIPTION_CHANGE_REQUESTED: "Yêu cầu đổi gói",
  MEMBER_SUBSCRIPTION_CHANGE_APPROVED: "Duyệt đổi gói",
  PAYMENT_ORDER_CREATED: "Tạo lệnh thanh toán",
  WALLET_ORDER_CREDITED: "Thanh toán thành công",
  WALLET_ADJUSTED: "Điều chỉnh ví",
  WALLET_TOPUP_CREDITED: "Nạp tiền vào ví",
  WALLET_INVITE_CHARGED: "Trừ phí mời",
  WALLET_INVITE_REFUNDED: "Hoàn phí mời",
  WALLET_WITHDRAW_HOLD: "Giữ tiền rút",
  WALLET_WITHDRAW_SETTLED: "Chốt rút tiền",
  WALLET_WITHDRAW_REFUNDED: "Hoàn tiền rút",
  WALLET_BETA_TOGGLED: "Bật/tắt ví beta",
  WALLET_TEST_ACCOUNT_SEEDED: "Khởi tạo ví thử",
  SYNC_MEMBER_QUEUED: "Xếp lịch đồng bộ thành viên",
  SYNC_MEMBERS_BATCH_QUEUED: "Xếp lịch đồng bộ hàng loạt",
  PURCHASE_SEAT_QUEUED: "Xếp lịch mua seat",
  REVOKE_INVITES_QUEUED: "Xếp lịch thu hồi lời mời",
};

const SUB_TITLE: Record<string, string> = {
  REMOVE_MEMBER: "Gỡ thành viên",
  INVITE_MEMBER: "Mời thành viên",
  CHANGE_ROLE: "Đổi vai trò",
  CHANGE_LICENSE_TYPE: "Đổi loại license",
  BILLING: "Thanh toán",
  // Tiêu đề vòng đời task đồng bộ (dùng cho QUEUE_*:SYNC_* khi gom nhóm).
  REVOKE_INVITES: "Thu hồi lời mời",
  SYNC_DATA: "Đồng bộ từ ChatGPT",
  SYNC_MEMBERS_BATCH: "Đồng bộ lời mời",
  SYNC_MEMBER: "Đồng bộ thành viên",
};

function prettify(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function actionTitle(action: string, data?: Record<string, unknown> | null): string {
  const [op, sub] = action.split(":");
  if (
    op === "MEMBER_REMOVED_SYNCED" &&
    data?.removal_reason === "expired"
  ) {
    return "Xoá do hết hạn";
  }
  let title = ACT_TITLE[op] ?? prettify(op);
  if (sub) title += " · " + (SUB_TITLE[sub] ?? prettify(sub));
  return title;
}

type StatusKey = "success" | "pending" | "failed";
function statusKey(result: string): StatusKey {
  if (result === "FAILED") return "failed";
  if (result === "PENDING") return "pending";
  return "success"; // SUCCESS | COMPLETED
}
const STATUS_STYLE: Record<StatusKey, { color: string; bg: string }> = {
  success: { color: "var(--success)", bg: "var(--success-bg)" },
  pending: { color: "var(--warning)", bg: "#f5eccb" },
  failed: { color: "var(--danger)", bg: "var(--danger-bg)" },
};

type Decorated = AuditLog & {
  cat: Cat;
  impGroup: ImpGroup | null;
  important: boolean;
  routine: boolean;
  status: StatusKey;
  actorInitial: string;
  actorSub: string;
  // Tên người thực hiện để HIỂN THỊ: user (bỏ @domain) / "hệ thống" / nhãn tiện
  // ích. Không bao giờ "Không rõ" cho hệ thống.
  actorName: string;
  avatarBg: string;
  targetEmails: string[];
};

/** Gom mọi email trong 1 payload `data`: khoá phẳng phổ biến + mảng `entries`. */
function collectEmails(d: Record<string, unknown> | null): string[] {
  if (!d) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.includes("@") && !out.includes(v))
      out.push(v);
  };
  for (const k of [
    "email",
    "member_email",
    "target_email",
    "to_email",
    "old_email",
    "new_email",
  ])
    push(d[k]);
  const entries = d.entries;
  if (Array.isArray(entries))
    for (const e of entries)
      if (e && typeof e === "object") push((e as Record<string, unknown>).email);
  const emails = d.emails;
  if (Array.isArray(emails)) for (const e of emails) push(e);
  // Kết quả đồng bộ: danh sách email được nâng pending→active (audit QUEUE_UPDATED
  // của task sync) → hiện ở cột "Đối tượng" của dòng đồng bộ.
  const promoted = d.promoted_emails;
  if (Array.isArray(promoted)) for (const e of promoted) push(e);
  const payload = d.payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.emails)) for (const e of p.emails) push(e);
    push(p.email);
  }
  return out;
}

function buildMemberIdEmailMap(logs: AuditLog[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of logs) {
    if (l.target_type !== "MEMBER" || !l.target_id) continue;
    for (const em of collectEmails(l.data)) {
      if (!m.has(l.target_id)) m.set(l.target_id, em);
    }
  }
  return m;
}

/**
 * Nhiều sự kiện hàng đợi (QUEUE_*) nhắm tới QUEUE_ITEM nên bản thân log không
 * có email. Ta suy ngược: build map queue_item_id → email từ các log MANG email
 * (bulk invite gắn thẳng vào QUEUE_ITEM, hoặc log MEMBER có data.queue_item_id),
 * rồi tra cho những dòng QUEUE_* trong cùng cửa sổ tải về.
 */
function buildQueueEmailMap(logs: AuditLog[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (id: string, emails: string[]) => {
    if (!emails.length) return;
    const cur = map.get(id) ?? [];
    for (const e of emails) if (!cur.includes(e)) cur.push(e);
    map.set(id, cur);
  };
  for (const l of logs) {
    const emails = collectEmails(l.data);
    if (l.target_type === "QUEUE_ITEM" && l.target_id) add(l.target_id, emails);
    const qid = l.data?.queue_item_id;
    if (typeof qid === "string") add(qid, emails);
  }
  return map;
}

/* Bảng desktop: 5 cột co giãn theo tỉ lệ (có min) + 1 cột chevron. Dưới GRID_MIN
   px thì chuyển sang danh sách thẻ (mobile) qua useIsMobile. */
const GRID =
  "minmax(104px,0.58fr) minmax(184px,1.05fr) minmax(288px,1.7fr) minmax(120px,0.66fr) minmax(300px,1.9fr) 30px";
const GRID_MIN = 1080;

const RESULT_LABEL: Record<StatusKey, string> = {
  success: "audit.status.success",
  pending: "audit.status.pending",
  failed: "audit.status.failed",
};

/* ------------------------------------------------------------------
 * Gộp vòng đời 1 thao tác hàng đợi thành 1 dòng.
 * Một lần gỡ/mời thành viên sinh ra nhiều log: XẾP HÀNG → NHẬN VIỆC →
 * HOÀN TẤT/ĐỒNG BỘ. Ta gom theo queue_item_id (QUEUE_* nhắm QUEUE_ITEM,
 * hoặc log MEMBER có data.queue_item_id, hoặc suy qua member id) rồi hiển
 * thị 1 dòng kèm thanh tiến trình. Sự kiện lẻ (đăng nhập, ví, cấu hình…)
 * mỗi cái vẫn là 1 dòng riêng.
 * ------------------------------------------------------------------ */
type Stages = {
  queued: boolean;
  running: boolean;
  done: boolean;
  failed: boolean;
};
type GStatus = "queued" | "processing" | "done" | "failed";

/** Kết quả terminal coi là thành công (backend dùng COMPLETED / SUCCESS / OK). */
function isTerminalOk(result: string): boolean {
  return result === "COMPLETED" || result === "SUCCESS" || result === "OK";
}

function isTerminalFail(result: string): boolean {
  return result === "FAILED" || result === "ERROR";
}

/** Sự kiện kết thúc vòng đời task (không chỉ QUEUE_UPDATED / *_SYNCED). */
const LIFECYCLE_SUCCESS_OPS = new Set([
  "MEMBER_INVITE_VERIFIED",
  "MEMBER_INVITE_REVOKED",
  "MEMBER_REMOVED_SYNCED",
  "MEMBER_ROLE_SYNCED",
  "MEMBER_LICENSE_TYPE_SYNCED",
  "MEMBER_USAGE_LIMIT_SYNCED",
  "MEMBER_SYNC_PROMOTED_ACTIVE",
]);

const LIFECYCLE_FAIL_OPS = new Set([
  "MEMBER_INVITE_FAILED",
  "MEMBER_INVITE_REVOKE_FAILED",
  "MEMBER_REMOVE_STUCK",
]);

function eventMarksDone(e: Decorated): boolean {
  const op = opOf(e.action);
  if (op === "QUEUE_UPDATED" && isTerminalOk(e.result)) return true;
  if (op.endsWith("_SYNCED") && isTerminalOk(e.result)) return true;
  return LIFECYCLE_SUCCESS_OPS.has(op) && isTerminalOk(e.result);
}

function eventMarksFailed(e: Decorated): boolean {
  const op = opOf(e.action);
  if (op.startsWith("QUEUE_TIMEOUT")) return true;
  if (LIFECYCLE_FAIL_OPS.has(op)) return true;
  return isTerminalFail(e.result);
}

const GSTATUS_STYLE: Record<GStatus, { color: string; bg: string; key: string }> = {
  queued: { color: "var(--ink-3)", bg: "var(--surface-2)", key: "audit.gstatus.queued" },
  processing: { color: "var(--warning)", bg: "#f5eccb", key: "audit.status.pending" },
  done: { color: "var(--success)", bg: "var(--success-bg)", key: "audit.status.success" },
  failed: { color: "var(--danger)", bg: "var(--danger-bg)", key: "audit.status.failed" },
};

type Group = {
  key: string;
  lifecycle: boolean;
  events: Decorated[];
  count: number;
  latestTs: string;
  cat: Cat;
  impGroup: ImpGroup | null;
  important: boolean;
  routine: boolean;
  title: string;
  code: string;
  emails: string[];
  workspaceName: string | null;
  actorLabel: string;
  actorSub: string;
  actorInitial: string;
  avatarBg: string;
  gstatus: GStatus;
  stages: Stages;
  singleStatus: StatusKey;
  // Loại chủ thể khởi tạo (ADMIN người / SYSTEM tự động / EXTENSION tiện ích).
  actorType: string;
};

const opOf = (action: string) => action.split(":")[0];

/** Tiêu đề nhóm vòng đời (gom queue) theo sự kiện KHỞI TẠO — tránh mọi gỡ đều
 * hiện chung "Gỡ thành viên" dù là xoá tay hay xoá tự động do hết hạn. */
const LIFECYCLE_TITLE_BY_INIT: Record<string, string> = {
  MEMBER_EXPIRED_REMOVE_QUEUED: "Xoá do hết hạn",
  MEMBER_REMOVE_QUEUED: "Gỡ thành viên",
  MEMBER_BULK_REMOVE_QUEUED: "Gỡ thành viên hàng loạt",
  MEMBER_INVITE_QUEUED: "Mời thành viên",
  MEMBER_BULK_INVITE_QUEUED: "Mời thành viên hàng loạt",
  MEMBER_CHANGE_ROLE_QUEUED: "Đổi vai trò",
  MEMBER_CHANGE_LICENSE_TYPE_QUEUED: "Đổi giấy phép",
  MEMBER_BULK_CHANGE_LICENSE_TYPE_QUEUED: "Đổi giấy phép hàng loạt",
  REVOKE_INVITES_QUEUED: "Thu hồi lời mời",
  SYNC_MEMBER_QUEUED: "Đồng bộ thành viên",
  SYNC_MEMBERS_BATCH_QUEUED: "Đồng bộ hàng loạt",
  WORKSPACE_SYNC_QUEUED: "Đồng bộ workspace",
  PURCHASE_SEAT_QUEUED: "Mua ghế",
};

function groupInitiator(evs: Decorated[]): Decorated {
  const oldestFirst = [...evs].reverse();
  return (
    oldestFirst.find(
      (e) => /_QUEUED$/.test(opOf(e.action)) || opOf(e.action) === "QUEUE_CREATED",
    ) ?? oldestFirst[0]
  );
}

function isRevokeInviteGroup(evs: Decorated[]): boolean {
  if (evs.some((e) => opOf(e.action) === "REVOKE_INVITES_QUEUED")) return true;
  if (evs.some((e) => opOf(e.action) === "MEMBER_INVITE_REVOKED")) return true;
  return evs.some(
    (e) =>
      e.data?.task_type === "REVOKE_INVITES" &&
      /_(REMOVE|EXPIRED_REMOVE)_QUEUED$/.test(opOf(e.action)),
  );
}

function lifecycleTitleForGroup(evs: Decorated[], initOp: string): string | null {
  if (isExpiredRemoveGroup(evs)) return "Xoá do hết hạn";
  if (
    (initOp === "MEMBER_REMOVE_QUEUED" || initOp === "MEMBER_BULK_REMOVE_QUEUED") &&
    evs.some((e) => e.data?.task_type === "REVOKE_INVITES")
  ) {
    return initOp === "MEMBER_BULK_REMOVE_QUEUED"
      ? "Thu hồi lời mời hàng loạt"
      : "Thu hồi lời mời";
  }
  return LIFECYCLE_TITLE_BY_INIT[initOp] ?? null;
}

function isExpiredRemoveGroup(evs: Decorated[]): boolean {
  return evs.some(
    (e) =>
      opOf(e.action) === "MEMBER_EXPIRED_REMOVE_QUEUED" ||
      (opOf(e.action) === "MEMBER_REMOVED_SYNCED" &&
        e.data?.removal_reason === "expired"),
  );
}

function buildMemberQueueMap(events: Decorated[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) {
    const qid = e.data?.queue_item_id;
    if (typeof qid === "string" && e.target_type === "MEMBER" && e.target_id)
      m.set(e.target_id, qid);
  }
  return m;
}

function groupKeyFor(e: Decorated, memberMap: Map<string, string>): string {
  if (e.target_type === "QUEUE_ITEM" && e.target_id) return "q:" + e.target_id;
  const qid = e.data?.queue_item_id;
  if (typeof qid === "string") return "q:" + qid;
  if (e.target_type === "MEMBER" && e.target_id && memberMap.has(e.target_id))
    return "q:" + memberMap.get(e.target_id);
  return "s:" + e.id;
}

function makeGroup(key: string, evs: Decorated[]): Group {
  const lifecycle = key.startsWith("q:");
  const has = (pred: (e: Decorated) => boolean) => evs.some(pred);
  const stages: Stages = {
    queued: has(
      (e) => /_QUEUED$/.test(opOf(e.action)) || opOf(e.action) === "QUEUE_CREATED",
    ),
    running: has((e) => opOf(e.action) === "QUEUE_PICKED"),
    done: has(eventMarksDone),
    failed: has(eventMarksFailed),
  };
  const gstatus: GStatus = stages.failed
    ? "failed"
    : stages.done
      ? "done"
      : stages.running
        ? "processing"
        : "queued";

  // Người khởi tạo = sự kiện XẾP HÀNG (cũ nhất), fallback sự kiện cũ nhất.
  const initiator = groupInitiator(evs);
  const initOp = opOf(initiator.action);

  let title: string;
  let code: string;
  const mappedTitle = lifecycle ? lifecycleTitleForGroup(evs, initOp) : null;
  if (lifecycle && mappedTitle) {
    title = mappedTitle;
    code = initOp;
  } else if (lifecycle) {
    const qEvent = evs.find(
      (e) => opOf(e.action).startsWith("QUEUE_") && e.action.includes(":"),
    );
    const sub = qEvent?.action.split(":")[1];
    if (sub) {
      title = SUB_TITLE[sub] ?? prettify(sub);
      code = sub;
    } else {
      title = actionTitle(evs[0].action, evs[0].data);
      code = opOf(evs[0].action);
    }
  } else {
    title = actionTitle(evs[0].action, evs[0].data);
    code = evs[0].action;
  }

  const emails: string[] = [];
  for (const e of evs)
    for (const em of e.targetEmails) if (!emails.includes(em)) emails.push(em);

  const impGroup = evs.map((e) => e.impGroup).find((g) => g !== null) ?? null;
  // Quan trọng (lên tab "Chính") = có nhóm nghiệp vụ thành viên (mời/gỡ/gia hạn/
  // đổi chủ). Đồng bộ/đăng nhập/cấu hình… không thuộc nhóm nào → tab "Khác".
  const important = evs.some((e) => e.important);

  return {
    key,
    lifecycle,
    events: evs,
    count: evs.length,
    latestTs: evs[0].timestamp,
    cat: evs[0].cat,
    impGroup,
    important,
    routine: !important,
    title,
    code,
    emails,
    // Tên workspace của nhóm (mọi event cùng nhóm chung 1 workspace) — lấy giá trị đầu tiên có.
    workspaceName: evs.map((e) => e.workspace_name).find((w) => !!w) ?? null,
    actorLabel: initiator.actorName,
    actorSub: initiator.actorSub,
    actorInitial: initiator.actorInitial,
    avatarBg: initiator.avatarBg,
    gstatus,
    stages,
    singleStatus: evs[0].status,
    actorType: initiator.actor_type,
  };
}

function buildGroups(events: Decorated[]): Group[] {
  const memberMap = buildMemberQueueMap(events);
  const map = new Map<string, Decorated[]>();
  const order: string[] = [];
  for (const e of events) {
    const key = groupKeyFor(e, memberMap);
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(e);
  }
  return order.map((k) => makeGroup(k, map.get(k)!));
}

/** Thanh tiến trình 3 bước: Xếp hàng → Đang chạy → Hoàn tất/Thất bại. */
function Steps({ stages }: { stages: Stages }) {
  const t = useT();
  const steps = [
    { label: t("audit.step.queued"), reached: stages.queued, kind: "n" as const },
    { label: t("audit.step.running"), reached: stages.running, kind: "n" as const },
    stages.failed
      ? { label: t("audit.step.failed"), reached: true, kind: "fail" as const }
      : { label: t("audit.step.done"), reached: stages.done, kind: "done" as const },
  ];
  const dotColor = (s: (typeof steps)[number]) => {
    if (!s.reached) return "var(--ink-4)";
    if (s.kind === "fail") return "var(--danger)";
    if (s.kind === "done") return "var(--success)";
    return "var(--ink-2)";
  };
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}
    >
      {steps.map((s, i) => (
        <div
          key={s.label}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              opacity: s.reached ? 1 : 0.65,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: s.reached ? dotColor(s) : "transparent",
                border: s.reached ? "none" : "1.5px solid var(--ink-4)",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 11,
                fontWeight: s.reached ? 600 : 500,
                color: s.reached ? dotColor(s) : "var(--ink-3)",
                whiteSpace: "nowrap",
              }}
            >
              {s.label}
            </span>
          </span>
          {i < steps.length - 1 && (
            <span
              style={{
                width: 18,
                height: 2,
                borderRadius: 2,
                background: steps[i + 1].reached
                  ? "var(--border-strong)"
                  : "var(--border)",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Cột "ĐỐI TƯỢNG & KẾT QUẢ": nhãn email thành viên + danh sách email (đậm) +
 *  ngữ cảnh hành động 1 dòng. Nhiều email → email đầu + nút "+N" xổ toàn bộ. */
function TargetResult({
  emails,
  summary,
  title,
}: {
  emails: string[];
  summary: string;
  title: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const emailStyle: CSSProperties = {
    fontSize: 13.5,
    color: "var(--ink)",
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  };
  const labelStyle: CSSProperties = {
    fontSize: 10.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ink-3)",
    fontWeight: 700,
    fontFamily: "var(--font-mono)",
    marginBottom: 4,
  };
  return (
    <div style={{ minWidth: 0 }}>
      {emails.length === 0 ? (
        <>
          <div style={labelStyle}>{title}</div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink-4)",
              fontFamily: "var(--font-mono)",
            }}
          >
            —
          </div>
        </>
      ) : (
        <>
          <div style={labelStyle}>
            {emails.length === 1
              ? title
              : t("audit.targetEmailCount", { n: emails.length })}
          </div>
          {!open ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span title={emails[0]} style={emailStyle}>
                {emails[0]}
              </span>
              {emails.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    stop(e);
                    setOpen(true);
                  }}
                  title={t("audit.showAllEmails", { n: emails.length })}
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    color: "var(--ink-2)",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "1px 8px",
                    cursor: "pointer",
                  }}
                >
                  +{emails.length - 1}
                </button>
              )}
            </div>
          ) : (
            <div>
              {emails.map((em) => (
                <div key={em} title={em} style={{ ...emailStyle, marginBottom: 2 }}>
                  {em}
                </div>
              ))}
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  setOpen(false);
                }}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--ink-3)",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                {t("audit.collapse")}
              </button>
            </div>
          )}
        </>
      )}
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 5, lineHeight: 1.45 }}>
        {summary}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
 * Cột "Chi tiết": trích các trường trong payload `data` (ngoài email/workspace
 * đã hiện ở cột khác) thành cặp nhãn–giá trị dễ đọc. Nhãn kỹ thuật → tiếng Việt;
 * tiền tệ format ₫; đổi giá trị (changes: {before, after}) hiện "cũ → mới"; ID
 * rút gọn. Trường lạ tự prettify để không bao giờ mất thông tin.
 * ------------------------------------------------------------------ */
type DetailRow = { label: string; value: string };

const DETAIL_LABEL: Record<string, string> = {
  count: "Số lượng",
  quantity: "Số lượng",
  kind: "Loại",
  months: "Số tháng",
  fee: "Phí",
  fee_vnd: "Phí",
  invite_fee_vnd: "Phí mời",
  amount: "Số tiền",
  new_role: "Vai trò mới",
  new_license_type: "Loại license mới",
  limit_credits: "Giới hạn credit",
  found_in: "Tìm thấy ở",
  batch: "Hàng loạt",
  dry_run: "Chạy thử",
  reason: "Lý do",
  expected_total: "Tổng kỳ vọng",
  name: "Tên",
  chatgpt_id: "Mã ChatGPT",
  plan: "Gói",
  locale: "Ngôn ngữ",
  page: "Trang",
  control_key: "Khoá điều khiển",
  to_version: "Tới phiên bản",
  total: "Tổng",
  enabled: "Bật",
  wallet_beta: "Ví beta",
  is_active: "Kích hoạt",
  permissions: "Quyền",
  username: "Tên đăng nhập",
  identifier: "Định danh",
  new_email: "Email mới",
  old_email: "Email cũ",
  new_expiry: "Hạn mới",
  queue_item_id: "Mã hàng đợi",
  member_id: "Mã thành viên",
  withdrawal_id: "Mã rút tiền",
  user_id: "Mã người dùng",
  age_sec: "Tuổi (giây)",
  invoices_count: "Số hoá đơn",
  invoices_detailed_count: "Hoá đơn chi tiết",
  invoices_failed_count: "Hoá đơn lỗi",
  command_ban_until: "Cấm lệnh tới",
  // Trạng thái/kết quả tác vụ hàng đợi (trước đây bị prettify thành English).
  status: "Trạng thái",
  result: "Kết quả",
  task_type: "Loại tác vụ",
  error_code: "Mã lỗi",
  error_message: "Thông báo lỗi",
  source: "Nguồn",
  reconciled: "Đã đối soát",
  paid: "Đã thanh toán",
  requested: "Đã yêu cầu",
  verified_at: "Đã xác minh lúc",
  // Các mốc thời gian (hiển thị giờ địa phương).
  new_end_at: "Hạn mới",
  subscription_end_at: "Hạn gói",
  subscription_purchased_at: "Ngày gia hạn",
  joined_at: "Ngày tham gia",
  last_invited_at: "Lần mời gần nhất",
  removed_at: "Thời điểm gỡ",
  // Thuộc tính thành viên.
  role: "Vai trò",
  license_type: "Loại license",
  credits: "Credit",
  seat_used: "Ghế đã dùng",
  seat_total: "Tổng ghế",
};

/* Trường đã hiển thị ở khối cấu trúc (Kết quả/Phạm vi) hoặc cột khác
   (email/workspace), hoặc chỉ là mảng id nội bộ → không lặp lại ở phần thô. */
const DETAIL_HIDDEN = new Set([
  "email",
  "member_email",
  "target_email",
  "to_email",
  "emails",
  "entries",
  "workspace_id",
  "member_ids",
  "counts",
  // Đã thể hiện ở huy hiệu Kết quả (✓/✕/⏳).
  "status",
  "result",
  // Sổ cái ví nội bộ — số dư/held ví TỨC THỜI giữa các bước trừ. Với giao dịch thu
  // phí (nhất là CK trực tiếp: nạp tạm vào ví rồi trừ ngay N khoản) đây là số ví
  // thoáng qua, trông như "nạp ví" gây rối. Số dư CUỐI đã hiển thị ở hộp phí ("Số dư
  // sau"). Ẩn khỏi lưới thông tin & chi tiết kỹ thuật.
  "balance_after",
  "held_after",
]);

const MONEY_KEYS = new Set(["fee", "fee_vnd", "invite_fee_vnd", "amount"]);

function fmtMoney(n: number): string {
  return n.toLocaleString("vi-VN") + "₫";
}

/* Chuỗi ISO-8601 (vd 2026-07-13T15:15:00+00:00) → giờ địa phương dễ đọc,
   khớp với cột Thời gian (dd/MM/yyyy, HH:mm). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function fmtDateTime(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* Giá trị mã hoá (enum) → tiếng Việt: trạng thái vòng đời + kết quả tác vụ. */
const VALUE_LABEL: Record<string, string> = {
  COMPLETED: "Hoàn tất",
  SUCCESS: "Thành công",
  RUNNING: "Đang chạy",
  QUEUED: "Xếp hàng",
  PENDING: "Chờ xử lý",
  PROCESSING: "Đang xử lý",
  FAILED: "Thất bại",
  CANCELED: "Đã huỷ",
  CANCELLED: "Đã huỷ",
  REJECTED: "Từ chối",
  APPROVED: "Đã duyệt",
  TIMEOUT: "Quá hạn",
  SKIPPED: "Bỏ qua",
};

/* Mã lỗi thường gặp → mô tả tiếng Việt (mã lạ giữ nguyên để còn tra cứu). */
const ERROR_LABEL: Record<string, string> = {
  MEMBER_NOT_IN_WORKSPACE: "Không có trong workspace",
  MEMBER_NOT_FOUND: "Không tìm thấy thành viên",
  INVITE_NOT_FOUND: "Không tìm thấy lời mời",
  ALREADY_REMOVED: "Đã bị gỡ trước đó",
  ALREADY_MEMBER: "Đã là thành viên",
  SEAT_LIMIT_REACHED: "Hết ghế trống",
  TIMEOUT: "Quá thời gian chờ",
};

const has = (m: Record<string, string>, k: string) =>
  Object.prototype.hasOwnProperty.call(m, k);

function fmtScalar(key: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Có" : "Không";
  if (typeof v === "number") return MONEY_KEYS.has(key) ? fmtMoney(v) : String(v);
  if (typeof v === "string") {
    if (ISO_RE.test(v)) return fmtDateTime(v);
    if (key === "error_code") return has(ERROR_LABEL, v) ? ERROR_LABEL[v] : v;
    if (key === "task_type")
      return SUB_TITLE[v] ?? (has(VALUE_LABEL, v) ? VALUE_LABEL[v] : prettify(v));
    if (key === "status" || key === "result")
      return has(VALUE_LABEL, v) ? VALUE_LABEL[v] : prettify(v);
    if (has(VALUE_LABEL, v)) return VALUE_LABEL[v];
    if (key.endsWith("_id") && v.length > 12) return v.slice(0, 8) + "…";
    return v;
  }
  // Mảng (vd removed_emails) → nối bằng dấu phẩy, hiển thị đầy đủ thay vì JSON thô.
  if (Array.isArray(v)) return v.map((x) => fmtScalar(key, x)).join(", ");
  return JSON.stringify(v);
}

/** Một ô của `changes`: {before, after} → "cũ → mới"; ngoài ra hiện giá trị thô. */
function extractDetails(events: Decorated[]): DetailRow[] {
  const rows: DetailRow[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: string) => {
    const k = label + " " + value;
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({ label, value });
  };
  for (const e of events) {
    const d = e.data;
    if (!d) continue;
    for (const [key, val] of Object.entries(d)) {
      if (DETAIL_HIDDEN.has(key)) continue;
      if (val === null || val === undefined || val === "") continue;
      if (key === "changes" && val && typeof val === "object") {
        for (const [f, ch] of Object.entries(val as Record<string, unknown>)) {
          const label = DETAIL_LABEL[f] ?? prettify(f);
          if (ch && typeof ch === "object" && "after" in (ch as object)) {
            const c = ch as { before?: unknown; after?: unknown };
            push(label, `${fmtScalar(f, c.before)} → ${fmtScalar(f, c.after)}`);
          } else {
            push(label, fmtScalar(f, ch));
          }
        }
        continue;
      }
      push(DETAIL_LABEL[key] ?? prettify(key), fmtScalar(key, val));
    }
  }
  return rows;
}

/** Lấy giá trị chuỗi đầu tiên có của `key` trong các event của nhóm. */
function firstStr(events: Decorated[], key: string): string | null {
  for (const e of events) {
    const v = e.data?.[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** Nhóm mời này được đồng bộ nâng pending→active (khác lời mời mới xác minh). */
function promotedViaSync(g: Group): boolean {
  return g.events.some((e) => opOf(e.action) === "MEMBER_SYNC_PROMOTED_ACTIVE");
}

/** Nhóm coi là THẤT BẠI (vòng đời: gstatus; sự kiện lẻ: trạng thái đơn). */
function isFailed(g: Group): boolean {
  return g.lifecycle ? g.gstatus === "failed" : g.singleStatus === "failed";
}

/* Câu tóm tắt 1 dòng cho thao tác nghiệp vụ quan trọng (gỡ/mời/gia hạn/đổi hạn/
   thanh toán): gộp hành động + đối tượng + workspace + ghi chú ngữ cảnh. Khi THẤT
   BẠI thì lý do do huy hiệu Kết quả thể hiện (tránh lặp). Sự kiện thường → null. */
function summarize(g: Group): string | null {
  const who = g.emails[0];
  const more = g.emails.length > 1 ? ` (+${g.emails.length - 1})` : "";
  const ws = g.workspaceName ?? "";
  const showEmailInline = g.emails.length === 0;
  const reason = isFailed(g)
    ? null
    : (firstStr(g.events, "error_message") ?? firstStr(g.events, "reason"));
  let head: string | null = null;
  switch (g.impGroup) {
    case "remove":
      if (isExpiredRemoveGroup(g.events)) {
        head = showEmailInline
          ? who
            ? `Xoá do hết hạn · ${who}${more}${ws ? ` (${ws})` : ""}`
            : "Xoá do hết hạn"
          : ws
            ? `Xoá do hết hạn · ${ws}`
            : "Xoá do hết hạn";
      } else if (isRevokeInviteGroup(g.events)) {
        head = showEmailInline
          ? who
            ? `Thu hồi lời mời · ${who}${more}${ws ? ` (${ws})` : ""}`
            : "Thu hồi lời mời"
          : ws
            ? `Thu hồi lời mời · ${ws}`
            : "Thu hồi lời mời";
      } else {
        head = showEmailInline
          ? who
            ? `Gỡ ${who}${more}${ws ? ` khỏi ${ws}` : ""}`
            : null
          : ws
            ? `Gỡ khỏi ${ws}`
            : "Gỡ thành viên";
      }
      break;
    case "invite":
      if (promotedViaSync(g)) {
        head = showEmailInline
          ? who
            ? `${who}${more} đã tham gia${ws ? ` ${ws}` : ""} (qua đồng bộ)`
            : null
          : ws
            ? `Đã tham gia ${ws} (qua đồng bộ)`
            : "Đã tham gia (qua đồng bộ)";
      } else {
        head = showEmailInline
          ? who
            ? `Mời ${who}${more}${ws ? ` vào ${ws}` : ""}`
            : null
          : ws
            ? `Mời vào ${ws}`
            : "Mời thành viên";
      }
      break;
    case "renew":
      head = showEmailInline
        ? who
          ? `Gia hạn gói cho ${who}${more}`
          : null
        : "Gia hạn gói";
      break;
    case "owner": {
      const to = firstStr(g.events, "target_username");
      head = showEmailInline
        ? who
          ? `Đổi chủ ${who}${more}${to ? ` → ${to}` : ""}`
          : to
            ? `Chuyển chủ → ${to}`
            : null
        : to
          ? `Chuyển chủ → ${to}`
          : "Chuyển chủ sở hữu";
      break;
    }
    default:
      head = null;
  }
  if (!head) return null;
  return reason ? `${head} — ${reason}` : head;
}

/* ---- Ba câu hỏi cột Chi tiết phải trả lời được -----------------------------
 * (1) Đây là cái gì        → dòng "what" (câu tóm tắt, hoặc tiêu đề hành động).
 * (2) Thành công hay không → huy hiệu Kết quả (✓/✕/⏳ + lý do khi lỗi).
 * (3) Phạm vi ảnh hưởng    → do người hay TỰ ĐỘNG (AI/tiện ích/hệ thống) thực
 *     hiện, và bao nhiêu đối tượng / thuộc workspace nào bị ảnh hưởng.
 * -------------------------------------------------------------------------- */
type ResultInfo = { icon: string; label: string; color: string; reason: string | null };

function resultOf(g: Group): ResultInfo {
  const failed = isFailed(g);
  const waiting = g.lifecycle
    ? g.gstatus === "queued" || g.gstatus === "processing"
    : g.singleStatus === "pending";
  if (failed) {
    const code = firstStr(g.events, "error_code");
    const reason =
      firstStr(g.events, "error_message") ??
      firstStr(g.events, "reason") ??
      (code ? (has(ERROR_LABEL, code) ? ERROR_LABEL[code] : code) : null);
    return { icon: "✕", label: "Thất bại", color: "var(--danger)", reason };
  }
  if (waiting) {
    const label =
      g.lifecycle && g.gstatus === "processing" ? "Đang xử lý" : "Đang chờ";
    return { icon: "◔", label, color: "var(--warning)", reason: null };
  }
  return { icon: "✓", label: "Thành công", color: "var(--success)", reason: null };
}

/** Danh từ đối tượng bị tác động theo nhóm nghiệp vụ. */
function objectNoun(g: Group): string | null {
  switch (g.impGroup) {
    case "remove":
    case "invite":
    case "renew":
    case "owner":
      return "thành viên";
    default:
      return g.emails.length ? "thành viên" : null;
  }
}

/** Số đối tượng bị tác động: ưu tiên số email, rồi count/quantity, mặc định 1. */
function affectedCount(g: Group): number {
  if (g.emails.length) return g.emails.length;
  for (const e of g.events) {
    const c = e.data?.count ?? e.data?.quantity;
    if (typeof c === "number" && c > 0) return c;
  }
  return 1;
}

type ScopeInfo = { actor: string; object: string | null };

/** (3) Ai thực hiện (người/tự động) + đối tượng & phạm vi bị ảnh hưởng. */
function scopeOf(g: Group): ScopeInfo {
  const execAuto = g.events.some((e) => e.actor_type === "EXTENSION");
  let actor: string;
  if (g.actorType === "SYSTEM")
    actor = `Tự động · hệ thống${g.actorLabel ? ` (${g.actorLabel})` : ""}`;
  else if (g.actorType === "EXTENSION") actor = "Tự động · tiện ích trình duyệt";
  else {
    actor = `Thủ công · ${g.actorLabel || "?"}`;
    if (execAuto) actor += " → tiện ích tự động thực thi";
  }
  const noun = objectNoun(g);
  let object: string | null = null;
  if (noun) {
    object = `${affectedCount(g)} ${noun}`;
    if (g.workspaceName) object += ` · ${g.workspaceName}`;
  } else if (g.workspaceName) {
    object = g.workspaceName;
  }
  return { actor, object };
}


/** Nhãn ngắn "Cách thực hiện": Thủ công / Tự động (theo loại chủ thể). */
function shortHow(g: Group, t: (k: string) => string): string {
  if (g.actorType === "SYSTEM" || g.actorType === "EXTENSION")
    return t("audit.actor.auto");
  return t("audit.actor.manual");
}

/* ------------------------------------------------------------------
 * Bảng chi tiết MỞ RỘNG khi bấm vào 1 dòng (giao diện mới "Audit Log").
 * Trái = THÔNG TIN: cách thực hiện + ảnh hưởng + thông số + hộp phí (nếu có
 * giao dịch tiền). Phải = XÁC MINH & ĐỐI SOÁT: kết quả (✓/✕/◔) + trạng thái
 * đối soát (với lời mời) + nút "Chi tiết kỹ thuật" xổ toàn bộ thông số thô.
 * Toàn bộ dùng lại helper sẵn có (resultOf/scopeOf/extractDetails/…).
 * ------------------------------------------------------------------ */
function ExpandedPanel({ g }: { g: Group }) {
  const t = useT();
  const [tech, setTech] = useState(false);
  const rows = extractDetails(g.events);
  const scope = scopeOf(g);
  const res = resultOf(g);
  const moneyRow = rows.find((r) => /₫/.test(r.value));
  // TỔNG phí thực thu của nhóm. Mỗi email/kỳ bị trừ phí = 1 sự kiện riêng
  // (WALLET_INVITE_CHARGED / WALLET_RENEW_CHARGED) mang `data.fee` của email đó.
  // extractDetails KHỬ TRÙNG các dòng phí BẰNG NHAU (mời 4 email cùng giá → 4 dòng
  // "330.000₫" giống hệt) còn 1 dòng, nên hộp phí trước đây hiện phí 1 email thay vì
  // tổng (mời 4 email 330K = phải là 1.320.000₫). Cộng lại từ event thô cho đúng.
  const CHARGE_OPS = new Set(["WALLET_INVITE_CHARGED", "WALLET_RENEW_CHARGED"]);
  const chargeEvents = g.events.filter((e) => CHARGE_OPS.has(opOf(e.action)));
  const feeTotal = chargeEvents.reduce((sum, e) => {
    const f = e.data?.fee;
    return sum + (typeof f === "number" ? f : 0);
  }, 0);
  const feeKind =
    chargeEvents.length &&
    chargeEvents.every((e) => opOf(e.action) === "WALLET_RENEW_CHARGED")
      ? "renew_fee"
      : "invite_fee";
  // "Chi tiết kỹ thuật": các trường TIỀN (Phí/Số tiền) bị extractDetails khử trùng
  // còn 1 dòng dù nhóm có N khoản trừ phí → thay bằng TỔNG cho khớp hộp phí, khỏi
  // mâu thuẫn với dòng −1.320.000₫ (và với các dòng Balance After của từng khoản).
  // Trường không phải tiền giữ nguyên. Chỉ áp khi có sự kiện trừ phí (feeTotal > 0).
  const techRows =
    feeTotal > 0
      ? rows.map((r) =>
          /₫/.test(r.value)
            ? {
                label: r.label,
                value: `${r.value.trim().startsWith("-") ? "-" : ""}${fmtMoney(feeTotal)}`,
              }
            : r,
        )
      : rows;
  // Lưới THÔNG TIN bỏ dòng đã thể hiện ở nơi khác (hộp phí + panel Xác minh &
  // đối soát) để không lặp; các dòng này vẫn còn trong "Chi tiết kỹ thuật".
  // Cũng ẩn các CON SỐ kỹ thuật thô (số đã gỡ, số đã xác minh…) — nhiễu, không cần
  // ở panel người đọc; vẫn giữ đầy đủ trong "Chi tiết kỹ thuật".
  const INFO_SKIP = new Set([
    "Đã đối soát",
    "Đã xác minh lúc",
    "Removed",
    "Verified Count",
    "Unverified Count",
  ]);
  // Loại MỌI dòng tiền (₫) khỏi lưới THÔNG TIN — tiền đã hiển thị ở hộp phí (tổng
  // đúng). Trước đây chỉ loại `moneyRow` (dòng ₫ đầu) nên dòng "Số tiền" thứ hai (cũng
  // bị khử trùng còn 1 email) vẫn lọt vào lưới, lặp lại con số đơn lẻ gây hiểu nhầm.
  const infoRows = rows.filter(
    (r) => !/₫/.test(r.value) && !INFO_SKIP.has(r.label),
  );
  // Số dư sau giao dịch (nếu payload có) — hiển thị dưới hộp phí.
  const balanceAfter = (() => {
    for (const e of g.events) {
      const v = e.data?.balance_after ?? e.data?.balance;
      if (typeof v === "number") return fmtMoney(v);
    }
    return null;
  })();
  // Xác minh/đối soát — chỉ có ý nghĩa với vòng đời lời mời.
  const isInvite = g.impGroup === "invite";
  const verified = g.events.find(
    (e) =>
      opOf(e.action) === "MEMBER_INVITE_VERIFIED" &&
      (e.result === "SUCCESS" || e.result === "COMPLETED"),
  );
  const reconciled = g.events.some(
    (e) => opOf(e.action) === "MEMBER_INVITE_VERIFY_RECONCILE",
  );

  const pairs: { label: string; value: string }[] = [
    { label: t("audit.panel.how"), value: shortHow(g, t) },
  ];
  if (g.emails.length) {
    pairs.push({
      label:
        g.emails.length > 1
          ? t("audit.targetEmailCount", { n: g.emails.length })
          : t("audit.targetEmail"),
      value: g.emails.join(", "),
    });
  } else if (scope.object) {
    pairs.push({ label: t("audit.panel.affect"), value: scope.object });
  }
  for (const r of infoRows.slice(0, 4)) pairs.push(r);

  const heading: CSSProperties = {
    fontSize: 10.5,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--ink-3)",
    fontWeight: 700,
    fontFamily: "var(--font-mono)",
    marginBottom: 12,
  };

  const VerifyItem = ({
    color,
    icon,
    title,
    sub,
  }: {
    color: string;
    icon: string;
    title: string;
    sub: string | null;
  }) => (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 12 }}>
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          flexShrink: 0,
          background: color,
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: 1,
        }}
      >
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
        {sub && (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>{sub}</div>
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        gap: 28,
        flexWrap: "wrap",
        padding: "18px 24px 22px 27px",
        borderTop: "1px solid var(--border)",
        background: "var(--surface-2, var(--bg))",
      }}
    >
      {/* ── THÔNG TIN ── */}
      <div style={{ flex: "1.6 1 340px", minWidth: 260 }}>
        <div style={heading}>{t("audit.panel.info")}</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: "10px 28px",
          }}
        >
          {pairs.map((p) => (
            <div
              key={p.label + p.value}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                fontSize: 12.5,
                borderBottom: "1px solid var(--border)",
                paddingBottom: 6,
              }}
            >
              <span style={{ color: "var(--ink-3)", flexShrink: 0 }}>{p.label}</span>
              <span
                title={p.value}
                style={{
                  color: "var(--ink)",
                  fontWeight: 500,
                  textAlign: "right",
                  // Hiện ĐẦY ĐỦ (vd email đã gỡ) — xuống dòng thay vì cắt "…" vì
                  // panel còn nhiều chỗ trống.
                  overflowWrap: "anywhere",
                  minWidth: 0,
                }}
              >
                {p.value}
              </span>
            </div>
          ))}
        </div>

        {moneyRow && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 10,
              background: "var(--danger-bg)",
              border: "1px solid var(--danger-border, var(--border))",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                {moneyRow.label}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}
              >
                {feeKind}
                {chargeEvents.length > 1 ? ` · ${chargeEvents.length} khoản` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--danger)", fontFamily: "var(--font-mono)" }}>
                {feeTotal > 0
                  ? `-${fmtMoney(feeTotal)}`
                  : moneyRow.value.startsWith("-")
                    ? moneyRow.value
                    : `-${moneyRow.value}`}
              </div>
              {balanceAfter && (
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>
                  {t("audit.panel.balanceAfter")}: {balanceAfter}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── XÁC MINH & ĐỐI SOÁT ── */}
      <div style={{ flex: "1 1 260px", minWidth: 220 }}>
        <div style={heading}>{t("audit.panel.verify")}</div>
        <VerifyItem
          color={res.color}
          icon={res.icon}
          title={isInvite && verified ? t("audit.panel.verified") : res.label}
          sub={res.reason ?? fmtDateTime(g.latestTs)}
        />
        {isInvite &&
          (reconciled ? (
            <VerifyItem
              color="var(--success)"
              icon="✓"
              title={t("audit.panel.reconciled")}
              sub={null}
            />
          ) : (
            <VerifyItem
              color="var(--warning)"
              icon="!"
              title={t("audit.panel.notReconciled")}
              sub={t("audit.panel.reconcileHint")}
            />
          ))}

        {rows.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              onClick={() => setTech((v) => !v)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--ink-2)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "6px 12px",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {t("audit.panel.tech")} ({techRows.length})
              <span style={{ color: "var(--ink-4)", transform: tech ? "rotate(180deg)" : "none" }}>▾</span>
            </button>
            {tech && (
              <div style={{ marginTop: 10, display: "grid", gap: 5 }}>
                {techRows.map((r) => (
                  <div
                    key={r.label + r.value}
                    style={{ display: "flex", gap: 8, fontSize: 12, minWidth: 0 }}
                  >
                    <span style={{ color: "var(--ink-3)", flexShrink: 0, whiteSpace: "nowrap" }}>
                      {r.label}
                    </span>
                    <span
                      style={{
                        color: "var(--ink)",
                        fontFamily: "var(--font-mono)",
                        fontWeight: 500,
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                        minWidth: 0,
                      }}
                    >
                      {r.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
 * Hai cách trình bày cùng một danh sách nhóm sự kiện:
 *  • AuditTable  — bảng 5 cột dày thông tin cho DESKTOP (màn rộng).
 *  • AuditCards  — danh sách thẻ 1 cột cho MOBILE (mockup "Vi Mobile").
 * Chọn theo bề ngang qua useIsMobile(GRID_MIN). Cả hai chia sẻ groupView()
 * để tính màu/nhãn/trạng thái đồng nhất, không lệch giữa 2 layout.
 * ------------------------------------------------------------------ */
type TFn = ReturnType<typeof useT>;

function groupView(g: Group, t: TFn) {
  const col = g.impGroup ? IMP_COLOR[g.impGroup] : NEUTRAL_COLOR;
  const chipLabel = g.impGroup
    ? t(IMP_COLOR[g.impGroup].labelKey)
    : t(`audit.cat.${g.cat}`);
  const gs = GSTATUS_STYLE[g.gstatus];
  const ss = STATUS_STYLE[g.singleStatus];
  const statusColor = g.lifecycle ? gs.color : ss.color;
  // Lệnh thanh toán còn 'chờ' → nhãn nghiệp vụ "Chờ thanh toán".
  const awaitingPay =
    !g.lifecycle &&
    g.singleStatus === "pending" &&
    g.code === "PAYMENT_ORDER_CREATED";
  const statusText = awaitingPay
    ? t("audit.status.awaiting_payment")
    : g.lifecycle
      ? t(gs.key)
      : t(RESULT_LABEL[g.singleStatus]);
  const summary = summarize(g) ?? g.title;
  const targetEmailTitle =
    g.emails.length > 1
      ? t("audit.targetEmailCount", { n: g.emails.length })
      : t("audit.targetEmail");
  return { col, chipLabel, statusColor, statusText, summary, targetEmailTitle };
}

type AuditListProps = {
  filtered: Group[];
  expanded: string | null;
  setExpanded: React.Dispatch<React.SetStateAction<string | null>>;
  isLoading: boolean;
};

/** DESKTOP — bảng 5 cột + panel chi tiết mở rộng. */
function AuditTable({ filtered, expanded, setExpanded, isLoading }: AuditListProps) {
  const t = useT();
  return (
    <div className="table-card">
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: GRID_MIN }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: GRID,
              alignItems: "center",
              gap: 16,
              padding: "13px 24px",
              borderBottom: "1px solid var(--border)",
              background: "var(--surface-2)",
            }}
          >
            {[
              t("queue.colTime"),
              t("audit.colActor"),
              t("audit.colAction"),
              t("queue.colStatus"),
              t("audit.colTargetResult"),
            ].map((h) => (
              <div
                key={h}
                style={{
                  fontSize: 10.5,
                  letterSpacing: "0.1em",
                  color: "var(--ink-3)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {h}
              </div>
            ))}
          </div>

          {filtered.map((g) => {
            const { col, chipLabel, statusColor, statusText, summary, targetEmailTitle } =
              groupView(g, t);
            const isOpen = expanded === g.key;
            const toggle = () =>
              setExpanded((k) => (k === g.key ? null : g.key));
            return (
              <div
                key={g.key}
                style={{
                  position: "relative",
                  borderBottom: "1px solid var(--border)",
                  background: isOpen
                    ? "var(--surface-2, var(--bg))"
                    : g.important
                      ? col.tint
                      : "transparent",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 3,
                    background: col.accent,
                    opacity: g.important ? 1 : 0.45,
                  }}
                />
                <div
                  role="button"
                  tabIndex={0}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: GRID,
                    alignItems: "center",
                    gap: 16,
                    padding: "15px 24px",
                    cursor: "pointer",
                  }}
                >
                  {/* THỜI GIAN */}
                  <div style={{ opacity: g.routine ? 0.7 : 1 }}>
                    <TimeCell iso={g.latestTs} />
                    {g.count > 1 && (
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "var(--ink-3)",
                          fontFamily: "var(--font-mono)",
                          marginTop: 2,
                        }}
                      >
                        {t("audit.opCount", { n: g.count })}
                      </div>
                    )}
                  </div>
                  {/* NGƯỜI THỰC HIỆN */}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {g.actorLabel || t("audit.actorUnknown")}
                    </div>
                  </div>
                  {/* HÀNH ĐỘNG — chip nhóm + tag workspace + tiến trình */}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          borderRadius: 6,
                          padding: "3px 10px",
                          background: col.chipBg,
                          color: col.chipText,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {g.important ? g.title : chipLabel}
                      </span>
                      {g.workspaceName && (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: 11,
                            fontWeight: 500,
                            color: "var(--ink-2)",
                            background: "var(--surface, var(--bg))",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "2px 8px",
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 12, height: 12, flexShrink: 0 }}>
                            <path d="M3 7h18M3 12h18M3 17h18" />
                          </svg>
                          {g.workspaceName}
                        </span>
                      )}
                    </div>
                    {g.emails.length > 0 && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 12.5,
                          fontFamily: "var(--font-mono)",
                          fontWeight: 600,
                          color: "var(--ink)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={g.emails.join(", ")}
                      >
                        {g.emails[0]}
                        {g.emails.length > 1 ? ` +${g.emails.length - 1}` : ""}
                      </div>
                    )}
                    {g.lifecycle && <Steps stages={g.stages} />}
                  </div>
                  {/* TRẠNG THÁI */}
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: statusColor,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: statusColor,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {statusText}
                    </span>
                  </div>
                  {/* ĐỐI TƯỢNG & KẾT QUẢ */}
                  <TargetResult
                    emails={g.emails}
                    summary={summary}
                    title={targetEmailTitle}
                  />
                  {/* Chevron */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      color: "var(--ink-4)",
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      style={{
                        width: 15,
                        height: 15,
                        transition: "transform .15s",
                        transform: isOpen ? "rotate(180deg)" : "none",
                      }}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </div>
                </div>
                {isOpen && <ExpandedPanel g={g} />}
              </div>
            );
          })}

          {!isLoading && filtered.length === 0 && (
            <div
              style={{
                padding: 56,
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 14,
              }}
            >
              {t("audit.emptyFiltered")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** MOBILE — mỗi nhóm là 1 thẻ (viền trái màu theo nhóm nghiệp vụ). */
function AuditCards({ filtered, expanded, setExpanded, isLoading }: AuditListProps) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {filtered.map((g) => {
        const { col, chipLabel, statusColor, statusText, summary, targetEmailTitle } =
          groupView(g, t);
        const isOpen = expanded === g.key;
        const toggle = () => setExpanded((k) => (k === g.key ? null : g.key));
        return (
          <div
            key={g.key}
            style={{
              overflow: "hidden",
              borderRadius: 16,
              border: "1px solid var(--border)",
              borderLeft: `4px solid ${col.accent}`,
              background: g.important ? col.tint : "var(--surface)",
              boxShadow: "var(--shadow-card)",
            }}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }}
              style={{ padding: 16, cursor: "pointer" }}
            >
              {/* Hàng trên: thời gian (+ số thao tác) · trạng thái · chevron */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ opacity: g.routine ? 0.75 : 1 }}>
                  <TimeCell iso={g.latestTs} />
                  {g.count > 1 && (
                    <div style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                      {t("audit.opCount", { n: g.count })}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: statusColor, whiteSpace: "nowrap" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                    {statusText}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    style={{
                      width: 15,
                      height: 15,
                      color: "var(--ink-4)",
                      transition: "transform .15s",
                      transform: isOpen ? "rotate(180deg)" : "none",
                    }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>
              </div>

              {/* Hàng chip: hành động + workspace + người thực hiện */}
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    borderRadius: 8,
                    padding: "4px 9px",
                    background: col.chipBg,
                    color: col.chipText,
                    whiteSpace: "nowrap",
                  }}
                >
                  {g.important ? g.title : chipLabel}
                </span>
                {g.workspaceName && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: "var(--ink-2)",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "3px 9px",
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 12, height: 12, flexShrink: 0 }}>
                      <path d="M3 7h18M3 12h18M3 17h18" />
                    </svg>
                    {g.workspaceName}
                  </span>
                )}
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                  {t("audit.byActor")}{" "}
                  <b style={{ fontWeight: 700, color: "var(--ink-2)" }}>
                    {g.actorLabel || t("audit.actorUnknown")}
                  </b>
                </span>
              </div>

              {g.emails.length > 0 && (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 13,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    color: "var(--ink)",
                    wordBreak: "break-all",
                  }}
                >
                  {g.emails[0]}
                  {g.emails.length > 1 ? ` +${g.emails.length - 1}` : ""}
                </div>
              )}

              {/* Thanh tiến trình vòng đời */}
              {g.lifecycle && <Steps stages={g.stages} />}

              {/* Đáy thẻ: email đối tượng (đậm) + câu tóm tắt */}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,.06)" }}>
                <TargetResult
                  emails={g.emails}
                  summary={summary}
                  title={targetEmailTitle}
                />
              </div>
            </div>
            {isOpen && <ExpandedPanel g={g} />}
          </div>
        );
      })}

      {!isLoading && filtered.length === 0 && (
        <div
          style={{
            padding: 56,
            textAlign: "center",
            color: "var(--ink-3)",
            fontSize: 14,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
          }}
        >
          {t("audit.emptyFiltered")}
        </div>
      )}
    </div>
  );
}

export default function AuditLogs() {
  const t = useT();
  const isMobile = useIsMobile(GRID_MIN);
  // Dòng đang mở bảng chi tiết (key nhóm) — bấm để xổ/thu.
  const [expanded, setExpanded] = useState<string | null>(null);
  const logs = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => api<AuditLog[]>("/api/v1/audit-logs?limit=200"),
  });
  // Hai tab chính: "main" = sự kiện QUAN TRỌNG (nghiệp vụ thành viên: gỡ/mời/gia
  // hạn/đổi hạn/thanh toán/ví) — mặc định; "other" = phần còn lại (đăng nhập, đổi
  // cấu hình, đồng bộ, hàng đợi…) — nhiễu, tách riêng khỏi tab chính (yêu cầu user
  // 2026-07-12). Bỏ tab "Tất cả": hợp của 2 tab đã là toàn bộ.
  const [view, setView] = useState<"main" | "other">("main");
  const [cat, setCat] = useState<Cat | null>(null); // null = mọi nhóm trong tab
  const [search, setSearch] = useState("");

  const decorated: Decorated[] = useMemo(() => {
    const rows = logs.data ?? [];
    const qmap = buildQueueEmailMap(rows);
    const memberIdMap = buildMemberIdEmailMap(rows);
    return rows.map((l) => {
      const c = classify(l.action, l.actor_type);
      const failed = l.result === "FAILED";
      // Quan trọng = có nhóm nghiệp vụ (xoá/mời/gia hạn/đổi hạn/thanh toán/ví).
      // Không quan trọng → hạ tông (routine), màu xám.
      const impGroup = importantGroup(l.action);
      const important = impGroup !== null;
      const routine = !important;
      const label = l.actor_label ?? "";
      let initial = (label || l.actor_type || "?").charAt(0).toUpperCase();
      let avatarBg = "var(--ink)";
      let actorSub = t("audit.actor.admin");
      // Tên hiển thị: hệ thống → "hệ thống" (không để "Không rõ"); tiện ích → nhãn
      // sẵn có; người/quản trị → tên đăng nhập (cắt phần @domain của email).
      let actorName: string;
      if (l.actor_type === "EXTENSION") {
        initial = "E";
        avatarBg = "var(--info)";
        actorSub = t("audit.actor.ext");
        actorName = label || t("audit.actor.extFull");
      } else if (l.actor_type === "SYSTEM") {
        initial = "S";
        avatarBg = "var(--ink-3)";
        actorSub = t("audit.actor.system");
        actorName = t("audit.actor.system");
      } else {
        if (failed && l.action.startsWith("LOGIN")) {
          initial = "?";
          avatarBg = "var(--danger)";
        }
        const at = label.indexOf("@");
        actorName = at > 0 ? label.slice(0, at) : label || t("audit.actorUnknown");
      }
      let targetEmails = collectEmails(l.data);
      if (
        !targetEmails.length &&
        l.target_type === "MEMBER" &&
        l.target_id &&
        memberIdMap.has(l.target_id)
      ) {
        targetEmails = [memberIdMap.get(l.target_id)!];
      }
      if (
        !targetEmails.length &&
        l.target_type === "QUEUE_ITEM" &&
        l.target_id
      )
        targetEmails = qmap.get(l.target_id) ?? [];
      return {
        ...l,
        cat: c,
        impGroup,
        important,
        routine,
        status: statusKey(l.result),
        actorInitial: initial,
        actorSub,
        actorName,
        avatarBg,
        targetEmails,
      };
    });
  }, [logs.data, t]);

  const groups = useMemo(() => buildGroups(decorated), [decorated]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter((g) => {
      // Chip nhóm phụ (vd "Thanh toán") lọc XUYÊN tab: khi chọn chip thì bỏ qua
      // ranh giới main/other — cần thiết vì "Thanh toán" = nạp (ở Khác) + gia hạn
      // (ở Chính), chỉ cách này mới gộp cả hai vào một chip. Không chọn chip →
      // theo tab: main = quan trọng, other = phần còn lại.
      if (cat) {
        if (g.cat !== cat) return false;
      } else if (view === "main" ? !g.important : g.important) {
        return false;
      }
      if (q) {
        const hay = `${g.title} ${g.emails.join(" ")} ${g.events
          .map((e) => `${e.action} ${e.actor_label ?? ""} ${e.target_id ?? ""}`)
          .join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [groups, view, cat, search]);

  const total = groups.length;
  const importantCount = useMemo(
    () => groups.filter((g) => g.important).length,
    [groups],
  );
  const otherCount = total - importantCount;
  const securityCount = useMemo(
    () => groups.filter((g) => g.cat === "security").length,
    [groups],
  );
  const routineCount = useMemo(
    () => groups.filter((g) => g.cat === "queue").length,
    [groups],
  );
  // Đếm theo nhóm PHỤ trên TOÀN BỘ nhật ký (chip lọc xuyên tab, không giới hạn
  // theo tab đang xem) → số trên chip ổn định dù đang ở tab nào.
  const catCounts = useMemo(() => {
    const by: Record<Cat, number> = { security: 0, member: 0, billing: 0, queue: 0 };
    for (const g of groups) by[g.cat] += 1;
    return by;
  }, [groups]);

  return (
    <div className="page-fade">
      {/* Dải tóm tắt */}
      <div className="metrics" style={{ marginBottom: 24 }}>
        <div className="metric">
          <div className="metric-label">{t("audit.sumTotal")}</div>
          <div className="metric-value">{total}</div>
        </div>
        <div className="metric">
          <div className="metric-head">
            <div className="metric-label" style={{ color: "var(--danger)" }}>
              {t("audit.sumSecurity")}
            </div>
            <span className="metric-dot danger" />
          </div>
          <div className="metric-value" style={{ color: "var(--danger)" }}>
            {securityCount}
          </div>
        </div>
        <div className="metric">
          <div className="metric-head">
            <div className="metric-label" style={{ color: "var(--info)" }}>
              {t("audit.sumImportant")}
            </div>
            <span
              className="metric-dot"
              style={{ background: "var(--info)" }}
            />
          </div>
          <div className="metric-value">{importantCount}</div>
        </div>
        <div className="metric">
          <div className="metric-head">
            <div className="metric-label">{t("audit.sumRoutine")}</div>
            <span className="metric-dot" />
          </div>
          <div className="metric-value" style={{ color: "var(--ink-3)" }}>
            {routineCount}
          </div>
        </div>
      </div>

      {/* Thanh lọc — 1 hàng: 2 tab chính · gạch ngăn · chip phụ · ô tìm kiếm (đẩy phải) */}
      <div
        className="flex flex-wrap items-center gap-2"
        style={{ marginBottom: 16 }}
      >
        {/* 2 tab chính: Chính (quan trọng, mặc định) · Khác (phần còn lại) */}
        <Chip
          active={view === "main"}
          onClick={() => {
            setView("main");
            setCat(null);
          }}
          label={t("audit.tab.main")}
          count={importantCount}
        />
        <Chip
          active={view === "other"}
          onClick={() => {
            setView("other");
            setCat(null);
          }}
          label={t("audit.tab.other")}
          count={otherCount}
        />
        {/* Lọc nhóm PHỤ trong tab đang xem (bấm lại để bỏ lọc). */}
        {CAT_ORDER.some((c) => catCounts[c] > 0) && (
          <div
            style={{
              width: 1,
              height: 24,
              background: "var(--border-strong)",
              margin: "0 4px",
            }}
          />
        )}
        {CAT_ORDER.filter((c) => catCounts[c] > 0).map((c) => (
          <Chip
            key={c}
            active={cat === c}
            onClick={() => setCat((prev) => (prev === c ? null : c))}
            label={t(`audit.cat.${c}`)}
            count={catCounts[c]}
          />
        ))}
        <div style={{ flex: 1 }} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("audit.searchPlaceholder")}
        />
      </div>

      {/* Desktop = bảng dày thông tin; mobile = danh sách thẻ (mockup) */}
      {isMobile ? (
        <AuditCards
          filtered={filtered}
          expanded={expanded}
          setExpanded={setExpanded}
          isLoading={logs.isLoading}
        />
      ) : (
        <AuditTable
          filtered={filtered}
          expanded={expanded}
          setExpanded={setExpanded}
          isLoading={logs.isLoading}
        />
      )}
      <div
        className="mono"
        style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 14 }}
      >
        {t("audit.countLabel", { shown: filtered.length, total })}
      </div>
    </div>
  );
}
