import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { vnDateKey } from "../lib/wallet-history";
import { useT } from "../i18n";
import { Chip } from "./Queue";
import { SearchInput } from "./Members";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePlatform } from "../hooks/usePlatform";

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
/** Số dòng nhật ký mỗi lượt tải; nút "xem thêm" tải tiếp một lô cũ hơn. */
const AUDIT_PAGE_SIZE = 200;
/** Gõ đủ ngần này ký tự mới hỏi server — 1 ký tự thì lọc tại chỗ cho nhẹ. */
const AUDIT_SEARCH_MIN = 2;
/** Nhịp hỏi "có gì mới chưa" khi đang mở trang (chỉ 1 dòng id + giờ, rất nhẹ). */
const AUDIT_HEAD_POLL_MS = 15_000;
/** Đã lật quá ngần này lô thì ngừng tự làm mới (xem lịch sử cũ, refetch quá nặng). */
const LIVE_MAX_PAGES = 2;

/** Giá trị chậm nhịp — gõ tới đâu bắn request tới đó thì mỗi phím là một lượt gọi. */
function useDebounced(value: string, ms: number): string {
  const [slow, setSlow] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSlow(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return slow;
}

type Cat = "security" | "member" | "billing" | "queue";

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
type ImpGroup = "remove" | "invite" | "renew" | "owner" | "sync";

const IMP_OP_GROUP: Record<string, ImpGroup> = {
  // xoá email (gỡ thành viên)
  MEMBER_REMOVE_QUEUED: "remove",
  MEMBER_BULK_REMOVE_QUEUED: "remove",
  MEMBER_REMOVED_SYNCED: "remove",
  MEMBER_EXPIRED_REMOVE_QUEUED: "remove",
  REVOKE_INVITES_QUEUED: "remove",
  MEMBER_INVITE_REVOKED: "remove",
  MEMBER_INVITE_REVOKE_FAILED: "remove",
  MEMBER_EMAIL_CHANGE_REMOVE_FAILED: "remove",
  MEMBER_EMAIL_CHANGE_REMOVE_RETRY: "remove",
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
  // Đã hoàn phí nhưng email vẫn ở trong team → NỢ cần truy thu. Thuộc nhóm mời để
  // nằm tab "Chính" (admin phải thấy, xem members/payments.md).
  MEMBER_REFUND_WHILE_IN_TEAM: "invite",
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
  // Đồng bộ xong VẪN lệch số lượng (ChatGPT header ≠ AutoGPT) → admin PHẢI thấy
  // để truy nguyên nhân. Đưa lên tab "Chính" (nhóm sync).
  MEMBER_SYNC_MISMATCH: "sync",
  // Trả lại "chờ tham gia" cho người bị nâng oan thành "đã tham gia" (lệnh kiểm
  // tra chạy nhầm tab "Lời mời"). Cặp đôi với MEMBER_SYNC_PROMOTED_ACTIVE nên để
  // cùng nhóm mời — admin phải thấy ở tab "Chính".
  MEMBER_ACTIVE_DOWNGRADED_PENDING: "invite",
  // Mời hỏng vì hết suất → giữ tiền, mời lại email đó miễn phí. Thuộc vòng đời mời
  // và có tiền đi kèm ⇒ phải nằm tab "Chính".
  MEMBER_INVITE_SEAT_CREDIT: "invite",
};

/** Nhóm nghiệp vụ quan trọng của 1 action (null = không quan trọng). */
export function importantGroup(action: string): ImpGroup | null {
  const [op, sub] = action.split(":");
  if (op in IMP_OP_GROUP) return IMP_OP_GROUP[op];
  // Gỡ/mời đi qua hàng đợi (QUEUE_PICKED:REMOVE_MEMBER…) thuộc cùng nhóm.
  if (op.startsWith("QUEUE_")) {
    if (sub === "REMOVE_MEMBER") return "remove";
    if (sub === "INVITE_MEMBER") return "invite";
  }
  return null;
}

/* ------------------------------------------------------------------
 * PHÂN TAB (chốt user 2026-08-26, sửa 2026-08-31). Tab "Chính" CHỈ có 3 nhóm:
 *   • Bảo mật    — lịch sử đăng nhập / mật khẩu của các TÀI KHOẢN quản trị.
 *   • Thành viên — vòng đời LỜI MỜI (mời · đồng bộ lời mời) và lệnh GIA HẠN.
 *   • Thanh toán — TIỀN của chính các lệnh đó: trừ phí mời/gia hạn, hoàn phí,
 *     hoá đơn QR (mã ORDER) trả cho lệnh mời/gia hạn.
 * Mọi thứ còn lại rơi xuống tab "Khác" và TỰ chia nhóm phụ ở đó; riêng nhánh
 * "Thành viên" của tab Khác ôm TẤT CẢ chuyện còn lại của một email — xoá, hết hạn,
 * thu hồi lời mời, đổi chủ, đổi email, các dòng đồng bộ trên email.
 *
 * Một nhóm được phép thuộc NHIỀU chip cùng lúc: lệnh mời vừa là "Thành viên"
 * (bản thân lệnh) vừa là "Thanh toán" (phí mời nằm CÙNG nhóm nhờ chung
 * queue_item_id) — nên chip là TẬP HỢP, không phải một `cat` duy nhất như trước.
 * ------------------------------------------------------------------ */
export type MainBucket = "security" | "member" | "billing";
export const MAIN_BUCKETS: MainBucket[] = ["security", "member", "billing"];
export type OtherBucket = "member" | "wallet" | "queue" | "config" | "misc";
export const OTHER_BUCKETS: OtherBucket[] = [
  "member",
  "wallet",
  "queue",
  "config",
  "misc",
];

/** Trường tối thiểu của 1 sự kiện mà việc phân tab cần — để test khỏi dựng `Decorated`. */
type EventLike = {
  action: string;
  target_type: string | null;
  target_id: string | null;
  data: Record<string, unknown> | null;
};

/** Đăng nhập / mật khẩu / vòng đời tài khoản quản trị → chip "Bảo mật". Đổi cấu
 *  hình, API key… KHÔNG thuộc đây (chúng là cấu hình, nằm tab "Khác"). */
const AUTH_OPS = new Set([
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGIN_BLOCKED_DISABLED",
  "LOGIN_BLOCKED_SPAM",
  "PASSWORD_CHANGED",
  "USER_PASSWORD_RESET",
  "USER_CREATED",
  "USER_REGISTERED",
  "SUPER_ADMIN_SEEDED",
]);

/* Chip "Thành viên" của tab "Chính" chỉ ôm VÒNG ĐỜI LỜI MỜI (mời, đồng bộ lời
   mời) và LỆNH GIA HẠN (chốt user 2026-08-30, thêm đồng bộ lời mời 2026-08-31).
   Mọi chuyện khác của một email — xoá, hết hạn, thu hồi lời mời, đổi chủ, đổi
   email, các dòng đồng bộ lẻ — nằm ở tab "Khác" nhánh "Thành viên". Trước đây
   nhánh ấy gần như rỗng: lệnh xoá bị giữ lại ở tab Chính, còn các dòng đồng bộ
   trên email thì bị nhánh "Hàng đợi" nuốt. */
const MAIN_MEMBER_OPS = new Set([
  "MEMBER_INVITE_QUEUED",
  "MEMBER_BULK_INVITE_QUEUED",
  "MEMBER_INVITE_VERIFIED",
  "MEMBER_INVITE_FAILED",
  "MEMBER_INVITE_VERIFY_RECONCILE",
  "MEMBER_SUBSCRIPTION_RENEWED",
  /* Đồng bộ lời mời (nút "Đồng bộ lời mời" — task SYNC_MEMBERS_BATCH) là bước
     CHỐT của lệnh mời: nó xác nhận email đã vào nhóm. Trước đây cả mẻ bị xếp
     theo action KHỞI TẠO nên rơi xuống tab "Khác" nhánh "Hàng đợi" — chạy xong
     42 email mà tab mặc định không thấy gì (user 2026-08-31). Ghi cả LỆNH lẫn
     KẾT QUẢ: lệnh để luôn thấy dù chưa email nào đổi trạng thái, kết quả để dòng
     "đã tham gia" còn ở lại tab Chính khi dòng khởi tạo bị đẩy khỏi cửa sổ. */
  "SYNC_MEMBERS_BATCH_QUEUED",
  "MEMBER_SYNC_PROMOTED_ACTIVE",
]);

/** Đổi hạn có KÉO DÀI = một lần gia hạn. Nút "Gia hạn" ghi `MEMBER_SUBSCRIPTION_
 *  RENEWED`, còn modal đổi hạn (và replay sau khi trả QR) ghi `..._UPDATED` — cùng
 *  là gia hạn thì phải cùng chỗ. Rút ngắn / gỡ hạn / giữ nguyên KHÔNG phải gia hạn
 *  → xuống tab "Khác" nhánh "Thành viên". */
function isSubscriptionExtend(data: Record<string, unknown> | null): boolean {
  const from = Date.parse(String(data?.old_end_at ?? ""));
  const to = Date.parse(String(data?.new_end_at ?? ""));
  return !Number.isNaN(from) && !Number.isNaN(to) && to > from;
}

/** Sự kiện thuộc chip "Thành viên" của tab "Chính" (lệnh mời hoặc lệnh gia hạn). */
function isMainMemberEvent(e: EventLike): boolean {
  const [op, sub] = e.action.split(":");
  if (MAIN_MEMBER_OPS.has(op)) return true;
  if (op.startsWith("QUEUE_") && sub === "INVITE_MEMBER") return true;
  if (op === "MEMBER_SUBSCRIPTION_UPDATED") return isSubscriptionExtend(e.data);
  return false;
}

/** Tiền CỦA lệnh mời / lệnh gia hạn. Nạp ví, rút, điều chỉnh… là tiền NGOÀI lệnh
 *  → tab "Khác" (nhóm Ví). `WALLET_ORDER_CREDITED` là tiền QR vào ví để trả ngay
 *  cho một lệnh mời/gia hạn nên vẫn tính là thanh toán của lệnh. */
const PAY_OPS = new Set([
  "WALLET_INVITE_CHARGED",
  "WALLET_INVITE_REFUNDED",
  "WALLET_RENEW_CHARGED",
  "WALLET_ORDER_CREDITED",
]);
const PAY_ORDER_KINDS = new Set(["invite", "renew"]);

function isPayEvent(e: EventLike): boolean {
  const op = opOf(e.action);
  if (PAY_OPS.has(op)) return true;
  // Hoá đơn QR: chỉ tính khi hoá đơn đó là của lệnh mời/gia hạn.
  if (op === "PAYMENT_ORDER_CREATED")
    return PAY_ORDER_KINDS.has(String(e.data?.kind ?? ""));
  return false;
}

/** Các chip của tab "Chính" mà nhóm sự kiện này thuộc về (rỗng = xuống "Khác"). */
export function mainBucketsOf(evs: EventLike[]): MainBucket[] {
  const out: MainBucket[] = [];
  if (evs.some((e) => AUTH_OPS.has(opOf(e.action)))) out.push("security");
  if (evs.some(isMainMemberEvent)) out.push("member");
  if (evs.some(isPayEvent)) out.push("billing");
  return out;
}

/* Nhóm phụ của tab "Khác" — xét theo action KHỞI TẠO của nhóm. THỨ TỰ có ý nghĩa,
   từ hẹp tới rộng: WORKSPACE_INVOICE_FEE_SET là chuyện tiền, WORKSPACE_SYNC_QUEUED
   là chuyện đồng bộ, mọi WORKSPACE_* còn lại mới là cấu hình. Nhờ vậy các action
   ít gặp (WORKSPACE_RENEWAL_DATE_RESTORED, USER_DISABLED…) vẫn có chỗ đứng thay vì
   rơi hết vào "Linh tinh". */
const OTHER_WALLET_RE =
  /^(WALLET_|PAYMENT_ORDER_|MEMBER_PAYMENT_|MEMBER_FEE_SET|USER_FEE_SET|WORKSPACE_(INVOICE_FEE|CREDIT_BUDGET|BILLING|FINANCE))/;
const OTHER_QUEUE_RE =
  /^(QUEUE_|SYNC_|UI_LABEL|AUTO_PURCHASE_SEAT|PURCHASE_SEAT|WORKSPACE_SYNC)/;
const OTHER_CONFIG_RE =
  /^(WORKSPACE_|PAYMENT_SETTINGS|TELEGRAM_|INVITE_ALL_WORKSPACES|MEMBER_NOTIFY_|USER_)/;
/* Chuyện của MỘT EMAIL: mọi MEMBER_* (trừ cấu hình thông báo) và thu hồi lời mời.
   Kể cả các dòng đồng bộ trên email (MEMBER_SYNC_*, MEMBER_BULK_UPSERT, MEMBER_*_
   SYNCED) — user 2026-08-30: ngoài mời và gia hạn thì cái gì dính tới email đều
   vào nhánh này. Lệnh đồng bộ của cả workspace vẫn ở nhánh "Hàng đợi" vì nhóm phụ
   đọc theo action KHỞI TẠO (WORKSPACE_SYNC_QUEUED). */
const OTHER_MEMBER_RE = /^(MEMBER_(?!NOTIFY_)|REVOKE_INVITES)/;

/** Nhóm phụ trong tab "Khác" cho một action (đã chắc chắn không thuộc tab Chính). */
export function otherBucketOf(action: string): OtherBucket {
  const op = opOf(action);
  if (OTHER_WALLET_RE.test(op)) return "wallet";
  // Lệnh xoá/mời đi qua hàng đợi (QUEUE_PICKED:REMOVE_MEMBER…) vẫn là chuyện của
  // email → nhánh "Thành viên", không rơi vào nhánh "Hàng đợi".
  if (OTHER_MEMBER_RE.test(op) || importantGroup(action) !== null) return "member";
  if (OTHER_QUEUE_RE.test(op)) return "queue";
  if (OTHER_CONFIG_RE.test(op)) return "config";
  return "misc";
}

/* Mã hoá đơn của một lệnh = khoá mà GIAO DỊCH VÍ neo vào (`wallet_transactions.ref_id`):
     • mời/gỡ (đi qua hàng đợi) → queue_item_id  (kind `invite_fee`)
     • gia hạn                  → member_id      (kind `renew_fee`)
   Nhờ vậy bấm mã trên lệnh mời/gia hạn là lọc ra ĐÚNG các dòng tiền của nó — kể cả
   khi khoản trừ phí gia hạn nằm ở một nhóm riêng (không có queue_item_id để gộp). */
export function payRefsOf(evs: EventLike[]): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  };
  for (const e of evs) {
    const op = opOf(e.action);
    if (e.target_type === "QUEUE_ITEM") add(e.target_id);
    add(e.data?.queue_item_id);
    if (op === "MEMBER_SUBSCRIPTION_RENEWED") add(e.target_id);
    if (op === "WALLET_RENEW_CHARGED") add(e.data?.member_id ?? e.data?.ref_id);
    if (op === "PAYMENT_ORDER_CREATED" && e.data?.kind === "renew")
      add(e.data?.member_id);
  }
  return out;
}

/** Có nên hiện "Số dư sau" dưới hộp phí của một nhóm hay không.

    Tài khoản TRẢ THẲNG từng lệnh (ví thiếu → quét QR đúng số tiền → `order_topup`
    vào ví rồi trừ phí ngay) luôn về 0 sau mỗi lệnh: con số đó không nói lên điều gì,
    chỉ làm người đọc tưởng ví đã hết tiền (user 2026-08-26). Chỉ hiện lại khi lệnh có
    HOÀN PHÍ vì lời mời lỗi — lúc đó "số dư sau" chính là tiền đang nằm chờ dùng lại.
    Ví có NẠP TRƯỚC (không có dòng tiền QR của chính lệnh này) giữ nguyên như cũ. */
export function showsBalanceAfter(evs: EventLike[]): boolean {
  const paidPerOrder = evs.some(
    (e) => opOf(e.action) === "WALLET_ORDER_CREDITED",
  );
  if (!paidPerOrder) return true;
  return evs.some((e) => opOf(e.action) === "WALLET_INVITE_REFUNDED");
}

/** Dạng ngắn để hiện trên hàng: 8 ký tự đầu của UUID. */
export function shortRef(ref: string): string {
  return ref.replace(/-/g, "").slice(0, 8);
}

/* MÃ HOÁ ĐƠN THẬT (`payment_orders.ref_code`) — mã nằm trên QR, trên sao kê ngân
   hàng và trong khối "Hoá đơn QR" ở panel thành viên. Trước đây hàng nhật ký hiện
   mã hàng đợi (id nội bộ, không tra được ở đâu khác) nên người đối soát không nối
   được lệnh với khoản tiền vào (user 2026-08-29). API bơm sẵn `order_ref_code` cho
   mọi sự kiện của lệnh; lệnh trả bằng ví (không sinh hoá đơn) thì không có mã. */
export function orderRefsOf(evs: EventLike[]): string[] {
  const out: string[] = [];
  for (const e of evs) {
    const v = e.data?.order_ref_code;
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
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
  sync: { accent: "#c0392b", tint: "#fbeeeb", chipBg: "#f4ddd8", chipText: "#a2493b", labelKey: "audit.grp.syncMismatch" },
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
  MEMBER_EMAIL_CHANGE_REMOVE_FAILED: "Đổi email — gỡ email cũ thất bại",
  MEMBER_EMAIL_CHANGE_REMOVE_RETRY: "Xoá do đổi email/chuyển hạn sử dụng",
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
  MEMBER_INVITE_PENDING_VERIFY: "Chờ xác minh lời mời",
  MEMBER_INVITE_CLEANUP_DEFERRED: "Hoãn phán xử, chờ đồng bộ",
  MEMBER_INVITE_BATCH_HOLD: "Giữ lại vì cùng mẻ với email đã xác minh",
  MEMBER_INVITE_NOT_TYPED: "Không nhập được email vào ô mời",
  MEMBER_INVITE_UNVERIFIABLE: "Treo quá lâu chưa ai đi xem",
  MEMBER_REFUND_WHILE_IN_TEAM: "Đã hoàn phí nhưng email vẫn trong team",
  MEMBER_INVITE_VERIFY_RECONCILE: "Đối soát mời thành viên",
  MEMBER_RECONCILE_SKIPPED: "Bỏ qua đối soát",
  MEMBER_SYNC_MISMATCH: "Lệch số lượng sau đồng bộ",
  MEMBER_ACTIVE_DOWNGRADED_PENDING: "Trả về chờ tham gia (đồng bộ)",
  MEMBER_INVITE_SEAT_CREDIT: "Hết suất — giữ tiền, mời lại miễn phí",
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
  WALLET_RENEW_CHARGED: "Trừ phí gia hạn",
  WALLET_DUPLICATE_INVOICE_CREDITED: "Cộng lại tiền trả trùng hoá đơn",
  WALLET_WITHDRAW_HOLD: "Giữ tiền rút",
  WALLET_WITHDRAW_SETTLED: "Chốt rút tiền",
  WALLET_WITHDRAW_REFUNDED: "Hoàn tiền rút",
  WALLET_BETA_TOGGLED: "Bật/tắt ví beta",
  WALLET_TEST_ACCOUNT_SEEDED: "Khởi tạo ví thử",
  SYNC_MEMBER_QUEUED: "Xếp lịch đồng bộ thành viên",
  SYNC_MEMBERS_BATCH_QUEUED: "Xếp lịch đồng bộ lời mời hàng loạt",
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
  "MEMBER_EMAIL_CHANGE_REMOVE_FAILED",
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

/** Hỏng CẤP TASK (hết giờ, task báo FAILED) — không phải kết luận cho email nào. */
function isTaskLevelFail(e: Decorated): boolean {
  return !LIFECYCLE_FAIL_OPS.has(opOf(e.action));
}

/**
 * Nhóm có cờ hỏng nhưng SAU ĐÓ mọi email đều có kết luận THÀNH CÔNG → coi là xong.
 *
 * Ca thật 26/8/2026 (task 3bc11c7b, mẻ 3 email): backend chốt `QUEUE_TIMEOUT` ở
 * mốc 8′ vì extension im lặng, rồi 26 giây sau mẻ đồng bộ thấy đủ 3 email trong
 * tab "Lời mời đang chờ" ⇒ 3 × `MEMBER_INVITE_VERIFIED`. Lời mời ĐI ĐƯỢC, phí thu
 * đúng, nhưng cờ hỏng dính vĩnh viễn nên timeline hiện "Thất bại" — quản trị viên
 * tổng thấy "Thất bại" còn sub-admin (không được xem log cấp hàng đợi) thấy "Thành
 * công" cho CÙNG một lệnh.
 *
 * Chỉ lật khi hỏng là CẤP TASK: `MEMBER_INVITE_FAILED` của một email trong mẻ là
 * kết luận riêng của email đó — mẻ vẫn phải hiện hỏng một phần, không được xoá.
 * Và phải cứu ĐỦ mọi email của nhóm; cứu một nửa vẫn là hỏng.
 */
function rescuedAfterFail(evs: Decorated[], emails: string[]): boolean {
  if (emails.length === 0) return false;
  const fails = evs.filter(eventMarksFailed);
  if (fails.length === 0 || !fails.every(isTaskLevelFail)) return false;
  const failAt = Math.max(...fails.map((e) => new Date(e.timestamp).getTime()));
  const rescued = new Set<string>();
  for (const e of evs) {
    if (!eventMarksDone(e)) continue;
    if (new Date(e.timestamp).getTime() <= failAt) continue;
    for (const em of e.targetEmails) rescued.add(em);
  }
  return emails.every((em) => rescued.has(em));
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
  /**
   * TỔNG THỜI GIAN CHẠY của lệnh: từ sự kiện cũ nhất (xếp hàng) tới sự kiện mới
   * nhất của chính nhóm này. `null` khi nhóm chỉ có một mốc (chưa đo được gì).
   *
   * Đọc theo NHẬT KÝ chứ không theo `queue_items`: nhật ký là thứ trang này đang
   * có sẵn, và nó tính cả quãng lệnh nằm chết trước khi bị dọn — đúng con số cần
   * nhìn để đi sửa quy trình. Chi tiết từng giai đoạn nằm ở ô "Thời gian" bên
   * trang Hàng đợi (`TaskTimingCell`), lấy từ `progress.history` mà API chốt sổ
   * lại thành `progress.timing` lúc lệnh kết thúc.
   */
  runMs: number | null;
  cat: Cat;
  impGroup: ImpGroup | null;
  /** Chip của tab "Chính" mà nhóm thuộc về; RỖNG = nhóm nằm ở tab "Khác". */
  buckets: MainBucket[];
  /** Nhóm phụ trong tab "Khác" (null khi nhóm ở tab "Chính"). */
  otherBucket: OtherBucket | null;
  /** Khoá mà giao dịch ví neo vào — bấm để lọc nhật ký về dòng tiền của lệnh. */
  payRefs: string[];
  /** Mã hoá đơn QR thật (`ref_code`) của lệnh — thứ hiện cho người đọc. */
  orderRefs: string[];
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
  /** Hỏng cấp task nhưng đã được cứu bằng kết luận thành công sau đó. */
  rescued: boolean;
  singleStatus: StatusKey;
  // Loại chủ thể khởi tạo (ADMIN người / SYSTEM tự động / EXTENSION tiện ích).
  actorType: string;
};

const opOf = (action: string) => action.split(":")[0];

/** Tiêu đề nhóm vòng đời (gom queue) theo sự kiện KHỞI TẠO — tránh mọi gỡ đều
 * hiện chung "Gỡ thành viên" dù là xoá tay hay xoá tự động do hết hạn. */
const LIFECYCLE_TITLE_BY_INIT: Record<string, string> = {
  MEMBER_EXPIRED_REMOVE_QUEUED: "Xoá do hết hạn",
  MEMBER_EMAIL_CHANGE_REMOVE_RETRY: "Xoá do đổi email/chuyển hạn sử dụng",
  MEMBER_REMOVE_QUEUED: "Gỡ thành viên",
  MEMBER_BULK_REMOVE_QUEUED: "Gỡ thành viên hàng loạt",
  MEMBER_INVITE_QUEUED: "Mời thành viên",
  MEMBER_BULK_INVITE_QUEUED: "Mời thành viên hàng loạt",
  MEMBER_CHANGE_ROLE_QUEUED: "Đổi vai trò",
  MEMBER_CHANGE_LICENSE_TYPE_QUEUED: "Đổi giấy phép",
  MEMBER_BULK_CHANGE_LICENSE_TYPE_QUEUED: "Đổi giấy phép hàng loạt",
  REVOKE_INVITES_QUEUED: "Thu hồi lời mời",
  SYNC_MEMBER_QUEUED: "Đồng bộ thành viên",
  SYNC_MEMBERS_BATCH_QUEUED: "Đồng bộ lời mời hàng loạt",
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

/* Gộp "mồ côi" — sự kiện MEMBER KHÔNG kèm `queue_item_id` nhưng là KẾT QUẢ của một
   task extension — vào đúng lệnh hàng đợi của member.

   BUG user 2026-08-04 (lingtruong1301@gmail.com): trước đây MỌI sự kiện MEMBER
   thiếu queue_item_id đều bị dán vào một lệnh hàng đợi BẤT KỲ của member đó (bản đồ
   member → qid ghi đè, không xét thời gian lẫn loại lệnh). Email hết hạn 3/8 → gỡ
   xong 3/8 11:03 → admin mời lại + gia hạn 2 tháng 3/8 15:39 → 4/8 15:43 đồng bộ ghi
   `MEMBER_SYNC_PROMOTED_ACTIVE` (đã tham gia). Sự kiện 4/8 đó bị dán vào lệnh "Xoá do
   hết hạn" HÔM TRƯỚC, kéo theo cả `MEMBER_FEE_SET` → nhóm 6 sự kiện, và vì nhóm lấy
   `latestTs` = sự kiện mới nhất nên ca xoá hết hạn hiện giờ của lần đồng bộ hôm sau:
   trông như hệ thống vừa xoá-do-hết-hạn một email vừa được mời lại + gia hạn.

   Ba chốt chặn: (1) whitelist action — thao tác admin (đổi phí/hạn/thanh toán…)
   KHÔNG bao giờ bị nuốt vào một lệnh hàng đợi; (2) cửa sổ thời gian — chỉ gộp khi
   sát giờ, chọn lệnh GẦN NHẤT; (3) đúng LOẠI lệnh — "đã tham gia" chỉ thuộc về lệnh
   MỜI, không thể thuộc về lệnh gỡ. */
const QUEUE_ORPHAN_GLUE_OPS = new Set([
  "MEMBER_ROLE_SYNCED",
  "MEMBER_LICENSE_TYPE_SYNCED",
  "MEMBER_USAGE_LIMIT_SYNCED",
  "MEMBER_SYNC_PROMOTED_ACTIVE",
]);
/** Lệch giờ tối đa giữa sự kiện mồ côi và lệnh hàng đợi của nó (10 phút). */
const QUEUE_ORPHAN_GLUE_MS = 10 * 60 * 1000;

type QueueRef = { qid: string; ts: number; impGroup: ImpGroup | null };

function buildMemberQueueMap(events: Decorated[]): Map<string, QueueRef[]> {
  const m = new Map<string, QueueRef[]>();
  for (const e of events) {
    const qid = e.data?.queue_item_id;
    if (typeof qid !== "string" || e.target_type !== "MEMBER" || !e.target_id)
      continue;
    /* "Đã tham gia (qua đồng bộ)" là KẾT QUẢ, không phải một lệnh — nó không được
       tự làm mốc để chính nó ghép vào. Từ 28/8/2026 sự kiện này mang
       `queue_item_id` của lệnh ĐỒNG BỘ; để nó vào bản đồ thì lúc đi tìm "lệnh mời
       gần nhất" nó luôn nhặt trúng chính mình (lệch 0 giây) và không lời mời nào
       còn nhận được bằng chứng đã tham gia của mình nữa. */
    if (opOf(e.action) === "MEMBER_SYNC_PROMOTED_ACTIVE") continue;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    const ref: QueueRef = { qid, ts, impGroup: e.impGroup };
    const list = m.get(e.target_id);
    if (list) list.push(ref);
    else m.set(e.target_id, [ref]);
  }
  return m;
}

/** Lệnh hàng đợi GẦN NHẤT về thời gian của member, trong cửa sổ + đúng loại lệnh. */
function nearestQueueRef(
  refs: QueueRef[],
  ts: number,
  onlyImpGroup: ImpGroup | null,
): string | null {
  let best: QueueRef | null = null;
  for (const r of refs) {
    if (onlyImpGroup && r.impGroup !== onlyImpGroup) continue;
    if (Math.abs(r.ts - ts) > QUEUE_ORPHAN_GLUE_MS) continue;
    if (!best || Math.abs(r.ts - ts) < Math.abs(best.ts - ts)) best = r;
  }
  return best?.qid ?? null;
}

/** id hoá đơn QR mà dòng log nói tới. "Tạo lệnh thanh toán" neo bằng target, còn
 *  "Thanh toán thành công" (bút toán ví) neo bằng `data.ref_type/ref_id`. */
function orderIdOf(e: Decorated): string | null {
  if (e.target_type === "PAYMENT_ORDER" && e.target_id) return e.target_id;
  if (e.data?.ref_type === "order") {
    const ref = e.data?.ref_id;
    if (typeof ref === "string" && ref) return ref;
  }
  /* Khoản TRỪ PHÍ trả bằng hoá đơn QR neo theo `member_id` nên không có đường về
     hoá đơn — API suy ra từ `payment_orders.member_id` rồi gắn `order_id` vào đây
     (user 2026-08-30: "trừ phí gia hạn" và "thanh toán thành công" là MỘT việc,
     không việc gì phải nằm hai dòng). */
  const oid = e.data?.order_id;
  if (typeof oid === "string" && oid) return oid;
  return null;
}

function groupKeyFor(e: Decorated, memberMap: Map<string, QueueRef[]>): string {
  if (e.target_type === "QUEUE_ITEM" && e.target_id) return "q:" + e.target_id;
  const qid = e.data?.queue_item_id;
  /* "Đã tham gia (qua đồng bộ)" nay MANG `queue_item_id` của lệnh đồng bộ (API
     28/8/2026). Nhưng nếu email đó vừa được MỜI xong thì chỗ đứng đúng của nó
     vẫn là lệnh mời — dán vào lệnh đồng bộ là tách lời mời khỏi kết quả của
     chính nó. Nên với riêng op này: thử ghép lệnh mời TRƯỚC, không có mới rơi
     về lệnh đồng bộ (nhờ vậy 12 email của một mẻ nằm chung MỘT dòng thay vì 12
     dòng — ảnh user 28/8/2026 mốc 15:38). */
  if (opOf(e.action) === "MEMBER_SYNC_PROMOTED_ACTIVE") {
    const glued = glueToNearbyCommand(e, memberMap);
    if (glued) return glued;
  }
  if (typeof qid === "string") return "q:" + qid;
  /* Hoá đơn QR CHƯA gắn được task (lệnh gia hạn/đổi hạn không đi qua hàng đợi, hoặc
     hoá đơn chưa trả xong) — "tạo lệnh" + "thanh toán thành công" vẫn là MỘT việc.
     Khi API đã suy ra được `queue_item_id` từ hoá đơn thì hai nhánh trên bắt trước,
     cả cụm về thẳng nhóm của lệnh mời. */
  const oid = orderIdOf(e);
  if (oid) return "o:" + oid;
  const glued = glueToNearbyCommand(e, memberMap);
  if (glued) return glued;
  return "s:" + e.id;
}

/** Sự kiện mồ côi (không mang task) ghép vào lệnh gần nhất của chính member đó. */
function glueToNearbyCommand(
  e: Decorated,
  memberMap: Map<string, QueueRef[]>,
): string | null {
  const op = opOf(e.action);
  if (!(e.target_type === "MEMBER" && e.target_id && QUEUE_ORPHAN_GLUE_OPS.has(op))) {
    return null;
  }
  const refs = memberMap.get(e.target_id);
  const ts = new Date(e.timestamp).getTime();
  // "Đã tham gia (qua đồng bộ)" chỉ nối vào lệnh MỜI của chính member đó.
  const onlyImpGroup = op === "MEMBER_SYNC_PROMOTED_ACTIVE" ? "invite" : null;
  const near =
    refs && !Number.isNaN(ts) ? nearestQueueRef(refs, ts, onlyImpGroup) : null;
  return near ? "q:" + near : null;
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
  const emails: string[] = [];
  for (const e of evs)
    for (const em of e.targetEmails) if (!emails.includes(em)) emails.push(em);

  // Hỏng cấp task rồi được đồng bộ cứu sau đó → KHÔNG phải nhóm hỏng.
  const rescued = stages.failed && rescuedAfterFail(evs, emails);
  const gstatus: GStatus = stages.failed && !rescued
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

  const impGroup = evs.map((e) => e.impGroup).find((g) => g !== null) ?? null;
  // Phân tab: 3 chip của "Chính"; không thuộc chip nào → "Khác" + nhóm phụ theo
  // action KHỞI TẠO (nhóm phụ đọc theo việc đã làm, không theo sự kiện mới nhất).
  const buckets = mainBucketsOf(evs);
  const otherBucket = buckets.length ? null : otherBucketOf(initiator.action);
  const payRefs = payRefsOf(evs);
  const orderRefs = orderRefsOf(evs);
  // Quan trọng (lên tab "Chính") = có nhóm nghiệp vụ thành viên (mời/gỡ/gia hạn/
  // đổi chủ). Đồng bộ/đăng nhập/cấu hình… không thuộc nhóm nào → tab "Khác".
  const important = evs.some((e) => e.important);

  const stamps = evs
    .map((e) => new Date(e.timestamp).getTime())
    .filter((n) => Number.isFinite(n));
  const runMs =
    stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : null;

  return {
    key,
    lifecycle,
    events: evs,
    count: evs.length,
    latestTs: evs[0].timestamp,
    runMs,
    cat: evs[0].cat,
    impGroup,
    buckets,
    otherBucket,
    payRefs,
    orderRefs,
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
    rescued,
    singleStatus: evs[0].status,
    actorType: initiator.actor_type,
  };
}

// Export cho unit test gom nhóm (AuditLogs.grouping.test.ts) — UI vẫn dùng nội bộ.
export function buildGroups(events: Decorated[]): Group[] {
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

/* ── Gom theo NGÀY (giống trang Ví) ─────────────────────────────────────────
 *
 * Nhật ký trước đây mỗi dòng tự ghi lại ngày tháng của nó, mà cả trang chỉ tải
 * 200 dòng mới nhất nên nhìn như bị chặn cứng vài ngày gần đây. Nay danh sách
 * ngăn theo ngày y như lịch sử ví: dải ngày ở trên ("HÔM NAY · 26/8/2026"), dòng
 * bên dưới CHỈ CÒN GIỜ, và tải tiếp phần cũ hơn khi bấm "xem thêm".
 * ------------------------------------------------------------------------- */

export type DaySection = { date: string; groups: Group[] };

/** Xếp nhóm sự kiện vào từng ngày (giờ VN), mới→cũ. Nhóm bắc cầu qua nửa đêm
 *  thuộc về ngày của sự kiện MỚI NHẤT trong nhóm — đúng mốc mà dòng đang hiện. */
export function splitByDay(groups: Group[]): DaySection[] {
  const out: DaySection[] = [];
  const index = new Map<string, number>();
  for (const g of groups) {
    const date = vnDateKey(g.latestTs);
    let at = index.get(date);
    if (at == null) {
      at = out.length;
      index.set(date, at);
      out.push({ date, groups: [] });
    }
    out[at].groups.push(g);
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

/** Hôm nay theo lịch VIỆT NAM (YYYY-MM-DD) — cùng mốc ngày mà dải ngày dùng. */
function vnToday(): string {
  return vnDateKey(new Date().toISOString());
}

/** Ngày liền trước/sau (delta = -1/+1), vẫn ở dạng YYYY-MM-DD. */
function shiftDay(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "2026-08-26" → "26/8/2026" (nhãn ngày kiểu Việt, bỏ số 0 thừa). */
function vnDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d}/${m}/${y}`;
}

/** Giờ Việt Nam của một mốc — ngày đã nằm ở dải ngăn ngày nên chỉ cần giờ. */
function vnTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

/** Ô giờ của một dòng nhật ký (ngày nằm ở dải ngăn ngày phía trên). */
function TimeOfDay({ iso }: { iso: string }) {
  return <span className="timestamp">{vnTimeLabel(iso)}</span>;
}

/** Dải ngăn ngày — bản sao của dải ngày trên trang Ví. `card` = bản đứng riêng
 *  cho mobile (bo góc, viền quanh) thay vì dải nằm trong bảng. */
function DayHeader({
  date,
  count,
  padX,
  card = false,
}: {
  date: string;
  count: number;
  padX: number;
  card?: boolean;
}) {
  const t = useT();
  const label = vnDateLabel(date);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        padding: `10px ${padX}px`,
        background: "var(--surface-2)",
        border: card ? "1px solid var(--border)" : undefined,
        borderRadius: card ? 12 : undefined,
        borderBottom: card ? undefined : "1px solid var(--border)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: ".08em",
          color: "var(--ink-2)",
        }}
      >
        {date === vnToday() ? `${t("audit.today")} · ${label}` : label}
      </span>
      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
        {t("audit.opCount", { n: count })}
      </span>
    </div>
  );
}

/**
 * Thanh chọn NGÀY XEM — lùi/tiến một ngày, hoặc bấm chọn thẳng trên lịch.
 * Mặc định đứng ở hôm nay (chốt user 2026-08-26); "Tất cả" bỏ lọc ngày để cuộn
 * lại toàn bộ nhật ký như trước.
 */
function DayPicker({
  day,
  onPick,
}: {
  day: string | null;
  onPick: (next: string | null) => void;
}) {
  const t = useT();
  const today = vnToday();
  const cur = day ?? today;
  const atToday = cur >= today;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 16,
      }}
    >
      <button
        type="button"
        onClick={() => onPick(shiftDay(cur, -1))}
        aria-label={t("audit.dayPrev")}
        title={t("audit.dayPrev")}
        style={dayIconBtn}
      >
        ←
      </button>
      <button
        type="button"
        onClick={() => onPick(shiftDay(cur, 1))}
        aria-label={t("audit.dayNext")}
        title={t("audit.dayNext")}
        disabled={atToday}
        style={{ ...dayIconBtn, opacity: atToday ? 0.4 : 1 }}
      >
        →
      </button>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid var(--border-strong)",
          background: "var(--surface, var(--bg))",
          borderRadius: 8,
          padding: "0 10px",
          height: 32,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: "nowrap",
            color: "var(--ink)",
          }}
        >
          {day
            ? `${day === today ? `${t("audit.today")} · ` : ""}${vnDateLabel(day)}`
            : t("audit.pickDay")}
        </span>
        {/* Ô lịch thu hẹp còn cái icon — nhãn ngày bên trái mới là phần đọc được. */}
        <input
          type="date"
          value={cur}
          max={today}
          onChange={(e) => onPick(e.target.value || null)}
          style={{
            width: 20,
            border: "none",
            background: "transparent",
            fontSize: 13,
            color: "var(--ink-3)",
            cursor: "pointer",
            padding: 0,
          }}
        />
      </label>
      <Chip active={day === null} onClick={() => onPick(null)} label={t("audit.allDays")} />
    </div>
  );
}

const dayIconBtn: CSSProperties = {
  width: 32,
  height: 32,
  flexShrink: 0,
  border: "1px solid var(--border-strong)",
  background: "var(--surface, var(--bg))",
  borderRadius: 8,
  fontSize: 14,
  color: "var(--ink-2)",
  cursor: "pointer",
  display: "grid",
  placeItems: "center",
};

/** Nút tải tiếp phần nhật ký cũ hơn (cần đến đâu tải đến đó). */
function MoreBar({
  hasMore,
  loading,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  const t = useT();
  if (loading)
    return (
      <div
        style={{
          padding: "14px 20px",
          textAlign: "center",
          fontSize: 13,
          color: "var(--ink-3)",
        }}
      >
        {t("audit.loadingMore")}
      </div>
    );
  if (!hasMore) return null;
  return (
    <div style={{ padding: "14px 20px", display: "flex", justifyContent: "center" }}>
      <button
        type="button"
        onClick={onMore}
        disabled={loading}
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink)",
          background: "var(--surface, var(--bg))",
          border: "1px solid var(--border-strong)",
          borderRadius: 999,
          padding: "8px 18px",
          cursor: loading ? "progress" : "pointer",
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? t("audit.loadingMore") : t("audit.loadMore")}
      </button>
    </div>
  );
}

/** ms → "1h 2m 3s" (ẩn cấp 0 ở đầu). Cùng cách đọc với ô Thời gian bên Hàng đợi. */
function fmtRunDur(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Thanh tiến trình 3 bước: Xếp hàng → Đang chạy → Hoàn tất/Thất bại, kèm TỔNG
 * THỜI GIAN CHẠY ở mép phải (user 30/8/2026 — để nhìn ra lệnh nào chậm mà đi sửa
 * quy trình, thay vì phải mở từng lệnh ra trừ tay hai cái mốc).
 */
function Steps({
  stages,
  rescued,
  runMs,
}: {
  stages: Stages;
  rescued: boolean;
  runMs: number | null;
}) {
  const t = useT();
  const steps = [
    { label: t("audit.step.queued"), reached: stages.queued, kind: "n" as const },
    { label: t("audit.step.running"), reached: stages.running, kind: "n" as const },
    // Hết giờ rồi được đồng bộ cứu: nói thẳng "hoàn tất (sau khi hết giờ)" thay vì
    // giấu mốc hết giờ — nó vẫn là thứ cần sửa, chỉ không phải một lệnh hỏng.
    stages.failed && !rescued
      ? { label: t("audit.step.failed"), reached: true, kind: "fail" as const }
      : {
          label: rescued ? t("audit.step.rescued") : t("audit.step.done"),
          reached: rescued || stages.done,
          kind: "done" as const,
        },
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
      {runMs !== null && (
        <span
          title={
            stages.done || stages.failed
              ? t("audit.runtime.total")
              : t("audit.runtime.live")
          }
          style={{
            marginLeft: "auto",
            paddingLeft: 12,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            color: "var(--ink-3)",
            whiteSpace: "nowrap",
          }}
        >
          {fmtRunDur(runMs)}
        </span>
      )}
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
  expected_total: "ChatGPT header (active)",
  scraped_active: "Scrape được (active)",
  db_active: "AutoGPT (active)",
  extra_in_autogpt: "Thừa ở AutoGPT (ChatGPT không có)",
  missing_in_autogpt: "Thiếu ở AutoGPT (ChatGPT có)",
  unresolved_count: "Chưa xác định danh tính",
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
  // Mã hoá đơn QR: `ref_code` là trường gốc của dòng tạo lệnh, `order_ref_code` do
  // API suy cho MỌI dòng của lệnh. Cùng nhãn + cùng giá trị → extractDetails khử
  // trùng còn một dòng.
  ref_code: "Mã hoá đơn",
  order_ref_code: "Mã hoá đơn",
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
/** Số nguyên đầu tiên đọc được ở khoá `key` trong các sự kiện của nhóm. */
function firstNum(evs: Decorated[], key: string): number | null {
  for (const e of evs) {
    const v = e.data?.[key];
    if (typeof v === "number") return v;
  }
  return null;
}

/** Danh sách email đầu tiên đọc được ở khoá `key`. */
function firstEmailList(evs: Decorated[], key: string): string[] {
  for (const e of evs) {
    const v = e.data?.[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

/** Op chỉ xuất hiện trong lệnh đồng bộ — dùng để nhận ra nhóm đồng bộ. */
const SYNC_MARKER_OPS = new Set([
  "WORKSPACE_SYNC_QUEUED",
  "MEMBER_BULK_UPSERT",
  "MEMBER_SYNC_PROMOTED_ACTIVE",
]);

/**
 * Câu tóm tắt cho LỆNH ĐỒNG BỘ — trả lời đúng ba câu hỏi user hỏi 28/8/2026:
 * email nào đã vào nhóm, thiếu bao nhiêu, lệch bao nhiêu.
 *
 * Trước đây mỗi email được đồng bộ là một dòng nhật ký riêng: một mẻ 12 email đẻ
 * ra 12 dòng "Đã tham gia (qua đồng bộ)" giống hệt nhau, đọc không ra việc gì.
 * Nay cả mẻ về MỘT dòng (xem `groupKeyFor`) và dòng đó phải tự nói hết.
 *
 * Trả `null` khi nhóm không phải lệnh đồng bộ.
 */
function syncSummary(g: Group): string | null {
  const isSync = g.events.some((e) => {
    const op = opOf(e.action);
    if (SYNC_MARKER_OPS.has(op)) return true;
    // QUEUE_PICKED:SYNC_DATA / QUEUE_UPDATED:SYNC_MEMBERS_BATCH ...
    const sub = e.action.split(":")[1];
    return op.startsWith("QUEUE_") && !!sub && sub.startsWith("SYNC_");
  });
  if (!isSync) return null;

  const parts: string[] = [];
  const joined = firstEmailList(g.events, "promoted_emails");
  const promoted = firstNum(g.events, "promoted_active") ?? joined.length;
  if (promoted > 0) {
    parts.push(`${promoted} email đã vào nhóm${joined.length ? `: ${listEmails(joined)}` : ""}`);
  }

  const created = firstNum(g.events, "created");
  if (created && created > 0) parts.push(`${created} email mới ghi nhận`);

  // Thiếu = hệ thống có, ChatGPT không còn. Ở đây là dấu hiệu SAI LỆCH, không
  // phải việc đã làm — nên tách hẳn ra sau dấu gạch để mắt bắt được ngay.
  const missing =
    (firstNum(g.events, "removed_missing") ?? 0) + (firstNum(g.events, "fake_removed") ?? 0);
  const expected = firstNum(g.events, "expected_total");
  const total = firstNum(g.events, "total");
  const warns: string[] = [];
  if (missing > 0) warns.push(`${missing} email ChatGPT không còn`);
  if (expected != null && total != null && expected !== total && total > 0) {
    warns.push(`lệch tổng: ChatGPT ${expected}, hệ thống ${total}`);
  }

  if (!parts.length && !warns.length) return null;
  const head = parts.length ? parts.join(" · ") : "không có thay đổi";
  return warns.length ? `${head} — ${warns.join(" · ")}` : head;
}

/** Gộp email thành chuỗi ngắn, quá `max` thì cắt và ghi "+n". */
function listEmails(emails: string[], max = 4): string {
  const head = emails.slice(0, max).join(", ");
  return emails.length > max ? `${head} +${emails.length - max}` : head;
}

// Export cho unit test tóm tắt nhóm (AuditLogs.sync-grouping.test.ts).
export function summarize(g: Group): string | null {
  const who = g.emails[0];
  const more = g.emails.length > 1 ? ` (+${g.emails.length - 1})` : "";
  const ws = g.workspaceName ?? "";
  const showEmailInline = g.emails.length === 0;
  const reason = isFailed(g)
    ? null
    : (firstStr(g.events, "error_message") ?? firstStr(g.events, "reason"));
  // Lệnh đồng bộ không thuộc nhóm nghiệp vụ nào (impGroup = null) nên rơi thẳng
  // xuống `default` và trả null ⇒ dòng chỉ còn cái tiêu đề trơ "Đồng bộ workspace".
  // Chặn trước ở đây để nó tự nói được đã thêm ai, thiếu ai.
  const sync = syncSummary(g);
  if (sync) {
    const wsPart = ws ? ` · ${ws}` : "";
    return `${g.title || "Đồng bộ workspace"}${wsPart} — ${sync}`;
  }
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
    // Id nội bộ, không tra được ở đâu ngoài hệ thống — "Mã hoá đơn" ngay bên cạnh
    // mới là thứ đối soát được (user 2026-08-29). Vẫn còn ở "Chi tiết kỹ thuật".
    "Mã hàng đợi",
  ]);
  // Loại MỌI dòng tiền (₫) khỏi lưới THÔNG TIN — tiền đã hiển thị ở hộp phí (tổng
  // đúng). Trước đây chỉ loại `moneyRow` (dòng ₫ đầu) nên dòng "Số tiền" thứ hai (cũng
  // bị khử trùng còn 1 email) vẫn lọt vào lưới, lặp lại con số đơn lẻ gây hiểu nhầm.
  const infoRows = rows.filter(
    (r) => !/₫/.test(r.value) && !INFO_SKIP.has(r.label),
  );
  // Số dư sau giao dịch (nếu payload có) — hiển thị dưới hộp phí.
  const balanceAfter = (() => {
    if (!showsBalanceAfter(g.events)) return null;
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
        padding: "18px 24px 22px 27px",
        borderTop: "1px solid var(--border)",
        background: "var(--surface-2, var(--bg))",
      }}
    >
      {/* Lấp đầy bề rộng thay vì bó hẹp: lưới 2 vùng — THÔNG TIN co giãn (mỗi
          trường là thẻ "nhãn trên · giá trị dưới" xếp kín theo chiều ngang, hết
          cảnh dàn mỏng 1 hàng + trống bên phải) và cột XÁC MINH cố định 300px
          neo mép phải. Dưới 768px (mobile / dạng thẻ) .audit-panel-grid xếp dọc
          1 cột — xem index.css. */}
      <div
        className="audit-panel-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 300px",
          gap: 32,
          alignItems: "start",
        }}
      >
      {/* ── THÔNG TIN ── */}
      <div style={{ minWidth: 0 }}>
        <div style={heading}>{t("audit.panel.info")}</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "2px 24px",
          }}
        >
          {pairs.map((p) => (
            <div
              key={p.label + p.value}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                padding: "8px 0",
                borderBottom: "1px solid var(--border)",
                minWidth: 0,
                // Giá trị dài (danh sách email, ID) chiếm 2 cột cho dễ đọc.
                gridColumn: p.value.length > 40 ? "span 2" : undefined,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                }}
              >
                {p.label}
              </span>
              <span
                title={p.value}
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--ink)",
                  // Hiện ĐẦY ĐỦ (vd email đã gỡ) — xuống dòng thay vì cắt "…".
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
              // Không kéo dài hết cột THÔNG TIN rộng — giữ hộp phí gọn, dễ đọc.
              maxWidth: 520,
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
      <div
        className="audit-panel-verify"
        style={{ minWidth: 0, borderLeft: "1px solid var(--border)", paddingLeft: 32 }}
      >
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
    : g.otherBucket
      ? t(`audit.other.${g.otherBucket}`)
      : t(`audit.cat.${g.cat}`);
  /* Nhóm ở tab "Chính" luôn hiện TIÊU ĐỀ việc đã làm ("Đăng nhập thành công",
     "Trừ phí gia hạn") thay vì nhãn nhóm chung chung — tab này ít dòng, mỗi dòng
     đáng đọc. Tab "Khác" giữ nhãn nhóm để mắt lướt nhanh. */
  const showTitle = g.important || g.buckets.length > 0;
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
      ? t(g.rescued ? "audit.gstatus.rescued" : gs.key)
      : t(RESULT_LABEL[g.singleStatus]);
  const summary = summarize(g) ?? g.title;
  const targetEmailTitle =
    g.emails.length > 1
      ? t("audit.targetEmailCount", { n: g.emails.length })
      : t("audit.targetEmail");
  // Mã hoá đơn chỉ hiện trên LỆNH (mời/xoá/gia hạn) và các dòng TIỀN của lệnh —
  // không rắc mã lên mọi việc hàng đợi/đồng bộ. Mẻ đồng bộ lời mời nay đứng ở tab
  // "Chính" chip "Thành viên" nhưng KHÔNG có đồng tiền nào của riêng nó (phí đã
  // trừ ở lệnh mời) nên vẫn không mang mã.
  const payRef =
    (g.buckets.includes("member") || g.buckets.includes("billing")) &&
    !g.code.startsWith("SYNC_MEMBERS_BATCH") &&
    g.code !== "MEMBER_SYNC_PROMOTED_ACTIVE"
      ? (g.payRefs[0] ?? null)
      : null;
  // Chip hiện MÃ HOÁ ĐƠN (tra được ở sao kê + panel thành viên); lệnh trả bằng ví
  // không sinh hoá đơn nên rơi về mã lệnh như cũ để còn bấm lọc dòng tiền.
  const invoiceRef = payRef ? (g.orderRefs[0] ?? null) : null;
  return {
    col,
    chipLabel,
    showTitle,
    statusColor,
    statusText,
    summary,
    targetEmailTitle,
    payRef,
    invoiceRef,
  };
}

/** Mã hoá đơn của lệnh — bấm để xem chi tiết thanh toán của chính lệnh đó.

    `refId` là khoá LỌC (mã lệnh mà sổ cái ví neo vào), `invoice` là mã hoá đơn QR
    để NGƯỜI ĐỌC nhìn. Hai thứ khác nhau: mã lọc là id nội bộ, mã hoá đơn mới là thứ
    tra được ở sao kê ngân hàng và panel thành viên. */
function PayRefChip({
  refId,
  invoice,
  onOpen,
}: {
  refId: string;
  invoice?: string | null;
  onOpen: (ref: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      title={invoice ? t("audit.invoiceRefHint") : t("audit.payRefHint")}
      // Hàng là nút bung chi tiết — chặn nổi bọt để bấm mã không bung/thu hàng.
      onClick={(e) => {
        e.stopPropagation();
        onOpen(refId);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        color: "var(--ink-2)",
        background: "var(--surface, var(--bg))",
        border: "1px dashed var(--border-strong)",
        borderRadius: 6,
        padding: "2px 8px",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        style={{ width: 12, height: 12, flexShrink: 0 }}
      >
        <path d="M6 3v18l2-1.5L10 21l2-1.5L14 21l2-1.5L18 21V3H6z" />
        <path d="M9 8.5h6M9 12.5h6" />
      </svg>
      {/* Mã hoá đơn hiện ĐỦ 20 ký tự: cắt ngắn thì không đối chiếu được với sao kê
          ngân hàng — đúng việc mà chip này sinh ra để làm (user 2026-08-29). Mã lệnh
          (không có hoá đơn) vẫn rút gọn như cũ vì chỉ dùng để bấm lọc. */}
      #{invoice ?? shortRef(refId)}
    </button>
  );
}

type AuditListProps = {
  filtered: Group[];
  expanded: string | null;
  setExpanded: React.Dispatch<React.SetStateAction<string | null>>;
  isLoading: boolean;
  /** Bấm mã hoá đơn trên hàng → lọc nhật ký về đúng dòng tiền của lệnh đó. */
  onOpenPayments: (ref: string) => void;
  /** Ngày đang xem (null = mọi ngày) — chỉ dùng cho lời nhắn khi rỗng. */
  day: string | null;
  /** Từ khoá đang tìm trên server (null = không tìm) — cũng chỉ để nói khi rỗng. */
  searchQ: string | null;
  /** Còn nhật ký cũ hơn chưa tải (trang trước trả về đủ một lô). */
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
};

/** DESKTOP — bảng 5 cột + panel chi tiết mở rộng. */
function AuditTable({
  filtered,
  expanded,
  setExpanded,
  isLoading,
  onOpenPayments,
  day,
  searchQ,
  hasMore,
  loadingMore,
  onMore,
}: AuditListProps) {
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

          {splitByDay(filtered).map((sec) => (
            <div key={sec.date}>
              <DayHeader date={sec.date} count={sec.groups.length} padX={24} />
              {sec.groups.map((g) => {
                const {
                  col,
                  chipLabel,
                  showTitle,
                  statusColor,
                  statusText,
                  summary,
                  targetEmailTitle,
                  payRef,
                  invoiceRef,
                } = groupView(g, t);
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
                        <TimeOfDay iso={g.latestTs} />
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
                            {showTitle ? g.title : chipLabel}
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
                          {payRef && (
                            <PayRefChip
                              refId={payRef}
                              invoice={invoiceRef}
                              onOpen={onOpenPayments}
                            />
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
                        {g.lifecycle && (
                          <Steps
                            stages={g.stages}
                            rescued={g.rescued}
                            runMs={g.runMs}
                          />
                        )}
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
            </div>
          ))}

          <MoreBar hasMore={hasMore} loading={loadingMore} onMore={onMore} />

          {!isLoading && !loadingMore && filtered.length === 0 && (
            <div
              style={{
                padding: 56,
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 14,
              }}
            >
              {searchQ
                ? t("audit.emptySearch", { q: searchQ })
                : day
                  ? t("audit.emptyDay", { date: vnDateLabel(day) })
                  : t("audit.emptyFiltered")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** MOBILE — mỗi nhóm là 1 thẻ (viền trái màu theo nhóm nghiệp vụ). */
function AuditCards({
  filtered,
  expanded,
  setExpanded,
  isLoading,
  onOpenPayments,
  day,
  searchQ,
  hasMore,
  loadingMore,
  onMore,
}: AuditListProps) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {splitByDay(filtered).map((sec) => (
        <div key={sec.date} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <DayHeader date={sec.date} count={sec.groups.length} padX={14} card />
          {sec.groups.map((g) => {
            const {
              col,
              chipLabel,
              showTitle,
              statusColor,
              statusText,
              summary,
              targetEmailTitle,
              payRef,
              invoiceRef,
            } = groupView(g, t);
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
                      <TimeOfDay iso={g.latestTs} />
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
                      {showTitle ? g.title : chipLabel}
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
                    {payRef && (
                      <PayRefChip
                        refId={payRef}
                        invoice={invoiceRef}
                        onOpen={onOpenPayments}
                      />
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
                  {g.lifecycle && (
                    <Steps stages={g.stages} rescued={g.rescued} runMs={g.runMs} />
                  )}

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
        </div>
      ))}

      <MoreBar hasMore={hasMore} loading={loadingMore} onMore={onMore} />

      {!isLoading && !loadingMore && filtered.length === 0 && (
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
          {searchQ
            ? t("audit.emptySearch", { q: searchQ })
            : day
              ? t("audit.emptyDay", { date: vnDateLabel(day) })
              : t("audit.emptyFiltered")}
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
  // Nhật ký tải theo TRANG, mới→cũ: mở trang ra thấy phần gần đây, bấm "xem thêm"
  // thì tải tiếp lô cũ hơn (user 2026-08-26: "show từng ngày, cần đến đâu tải đến
  // đó"). Con trỏ là (timestamp, id) của dòng cuối lô trước — phải kèm id vì nhiều
  // log ghi trong CÙNG một request mang y hệt timestamp.
  // NHÁNH đang mở đi kèm mọi lời gọi: /audit-logs là ChatGPT, /canva/audit-logs là
  // Canva. Dòng nào truy được về workspace/email của nhánh thì chỉ hiện ở nhánh đó.
  const platform = usePlatform();
  const logs = useInfiniteQuery({
    queryKey: ["audit-logs", platform],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<AuditLog[]>(
        `/api/v1/audit-logs?limit=${AUDIT_PAGE_SIZE}&platform=${platform}${pageParam}`,
      ),
    // Lô trả về NGẮN hơn một trang ⇒ đã chạm đáy nhật ký.
    getNextPageParam: (last) => {
      if (last.length < AUDIT_PAGE_SIZE) return undefined;
      const tail = last[last.length - 1];
      return `&before=${encodeURIComponent(tail.timestamp)}&before_id=${tail.id}`;
    },
  });
  // Hai tab: "main" = 3 nhóm user quan tâm (bảo mật · thành viên · thanh toán —
  // chốt 2026-08-26), "other" = phần còn lại (hàng đợi/đồng bộ, ví ngoài lệnh,
  // cấu hình, thao tác thành viên khác) tự chia nhóm phụ. Bỏ tab "Tất cả": hợp
  // của 2 tab đã là toàn bộ.
  const [view, setView] = useState<"main" | "other">("main");
  // Mở trang là đứng sẵn ở Chính · Thành viên (chốt 2026-08-26): việc mời/gỡ/gia
  // hạn là thứ user vào nhật ký để xem, bảo mật và thanh toán chỉ tra khi cần.
  // Bấm lại chip (hoặc bấm tab Chính) để bỏ lọc, xem cả 3 nhóm.
  const [bucket, setBucket] = useState<MainBucket | null>("member"); // chip trong tab Chính
  const [otherCat, setOtherCat] = useState<OtherBucket | null>(null); // chip trong tab Khác
  // Lọc theo MÃ HOÁ ĐƠN: bấm mã trên lệnh mời/gia hạn → chỉ còn dòng tiền của lệnh đó.
  const [payRef, setPayRef] = useState<string | null>(null);
  // TÌM KIẾM CHỦ ĐỘNG (user 2026-08-27: "tìm kiếm chủ động thì phải hiển thị ra chứ
  // không phải chỉ tìm trong danh sách hiện tại"). Ô tìm KHÔNG lọc mấy dòng đang giữ
  // trong trang nữa mà hỏi thẳng server trên toàn bộ nhật ký, nên hàng khớp nằm ở
  // ngày nào / lô cũ nào cũng hiện ra. Đổi lại, khi đang tìm thì bộ lọc ngày và bộ
  // lọc tab/chip bị bỏ qua — tìm ra rồi mà tab đang bật giấu đi thì lại y như cũ.
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const searching = q.length >= AUDIT_SEARCH_MIN;
  const searchLogs = useInfiniteQuery({
    queryKey: ["audit-logs", "search", q, platform],
    enabled: searching,
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<AuditLog[]>(
        `/api/v1/audit-logs?limit=${AUDIT_PAGE_SIZE}&platform=${platform}&q=${encodeURIComponent(q)}${pageParam}`,
      ),
    getNextPageParam: (last) => {
      if (last.length < AUDIT_PAGE_SIZE) return undefined;
      const tail = last[last.length - 1];
      return `&before=${encodeURIComponent(tail.timestamp)}&before_id=${tail.id}`;
    },
  });
  /* Nguồn dòng đang hiển thị: kết quả tìm khi đang tìm, còn lại là nhật ký thường. */
  const feed = searching ? searchLogs : logs;
  const rows = useMemo(() => (feed.data?.pages ?? []).flat(), [feed.data]);
  // Ngày đang xem; null = mọi ngày. Mở trang là đứng ở HÔM NAY (chốt 2026-08-26).
  const [day, setDay] = useState<string | null>(vnToday());

  /* TỰ LÀM MỚI khi đang ngồi xem: nhật ký sinh ra từ extension, lịch chạy nền và
     admin khác, nên trước đây mở trang rồi để đó là số liệu đứng im tới lúc F5
     (chỉ quay lại tab mới nạp). Không poll thẳng danh sách vì mỗi lô 200 dòng và
     react-query refetch TẤT CẢ lô đã tải; thay vào đó hỏi /head (1 dòng id + giờ)
     mỗi 15s, khác dòng đầu đang hiện mới tải lại thật. Đang tìm kiếm hoặc đang
     xem ngày cũ thì thôi — tải lại cũng không đổi cái đang nhìn. Đã lật quá
     LIVE_MAX_PAGES lô thì cũng dừng: lúc đó người dùng đang lần về quá khứ, refetch
     vừa nặng vừa làm danh sách nhảy. */
  const loadedPages = logs.data?.pages.length ?? 1;
  // Tên biến tránh trùng class css trong index.css: tailwind quét chuỗi thô trong
  // mã nguồn nên tên trùng (kèm dấu chấm than của phủ định) đẻ thêm quy tắc rác.
  const autoRefresh =
    !searching && (day === null || day === vnToday()) && loadedPages <= LIVE_MAX_PAGES;
  const head = useQuery({
    queryKey: ["audit-logs", "head", platform],
    queryFn: () =>
      api<{ id: string | null }>(`/api/v1/audit-logs/head?platform=${platform}`),
    enabled: autoRefresh,
    retry: false,
    // Hỏi hụt (API chưa có /head, rớt mạng) thì thôi hẳn — không nã lỗi mỗi 15s.
    refetchInterval: (query) => (query.state.error ? false : AUDIT_HEAD_POLL_MS),
  });
  const newestId = head.data?.id ?? null;
  const shownId = logs.data?.pages[0]?.[0]?.id ?? null;
  const refetchLogs = logs.refetch;
  /* Mốc đã xử lý — mỗi id mới chỉ kéo lại danh sách ĐÚNG MỘT LẦN. Thiếu chốt này
     thì với sub-admin, một sự kiện của người khác (họ không được nhìn) sẽ khiến
     "mới nhất" mãi mãi khác dòng đầu → refetch lặp vô tận. */
  const handledHead = useRef<string | null>(null);
  useEffect(() => {
    if (!autoRefresh || !newestId || !shownId) return;
    if (newestId === shownId || handledHead.current === newestId) return;
    handledHead.current = newestId;
    void refetchLogs();
  }, [autoRefresh, newestId, shownId, refetchLogs]);

  const decorated: Decorated[] = useMemo(() => {
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
  }, [rows, t]);

  const allGroups = useMemo(() => buildGroups(decorated), [decorated]);
  /* Nhật ký của NGÀY ĐANG XEM. Mọi con số trên trang (4 ô tóm tắt, số trên chip)
     đếm theo đây: đổi ngày thì số đổi, còn bấm qua lại giữa các chip thì không —
     đúng ý "số trên chip không nhảy" của bản trước. */
  const groups = useMemo(
    () =>
      day && !searching
        ? allGroups.filter((g) => vnDateKey(g.latestTs) === day)
        : allGroups,
    [allGroups, day, searching],
  );

  /* Chọn một ngày cũ hơn phần đã tải ⇒ tự lật tiếp các lô cho tới khi chạm ngày
     đó (hoặc hết nhật ký). "Cần đến đâu tải đến đó" — user không phải bấm "xem
     thêm" nhiều lần chỉ để tới được ngày mình chọn. Mỗi lô đẩy mốc cũ nhất lùi
     thêm nên vòng này luôn dừng. */
  const oldestLoaded = rows.length ? vnDateKey(rows[rows.length - 1].timestamp) : null;
  useEffect(() => {
    if (searching) return; // đang tìm thì bỏ lọc ngày, không phải lật tới ngày nào cả
    if (!day || oldestLoaded === null) return;
    if (day > oldestLoaded) return; // ngày đã nằm trong phần tải rồi
    if (!logs.hasNextPage || logs.isFetchingNextPage) return;
    void logs.fetchNextPage();
  }, [
    searching,
    day,
    oldestLoaded,
    logs.hasNextPage,
    logs.isFetchingNextPage,
    logs.fetchNextPage,
  ]);

  const mainCounts = useMemo(() => {
    const by: Record<MainBucket, number> = { security: 0, member: 0, billing: 0 };
    for (const g of groups) for (const b of g.buckets) by[b] += 1;
    return by;
  }, [groups]);
  /* Chip đang lọc THẬT SỰ. Chip của nhóm rỗng không được render (xem thanh lọc
     bên dưới) nên nếu cứ lọc theo nó thì danh sách trắng mà chẳng có nút nào để
     gỡ — hay gặp đúng lúc mới mở trang, chip mặc định "Thành viên" chưa có sự
     kiện nào. Nhóm rỗng ⇒ coi như không lọc. */
  const activeBucket = bucket && mainCounts[bucket] > 0 ? bucket : null;

  const filtered = useMemo(() => {
    // Đang tìm trên server: trả gì hiện nấy. Lọc lại theo tab/chip ở đây là đúng lỗi
    // cũ — tìm ra kết quả nhưng tab "Chính" hoặc chip đang bật nuốt mất.
    if (searching) return groups;
    // Mới gõ 1 ký tự (chưa đủ để hỏi server) thì vẫn lọc tại chỗ cho đỡ giật.
    const local = search.trim().toLowerCase();
    return groups.filter((g) => {
      // Tab Chính = nhóm thuộc ít nhất 1 trong 3 chip; tab Khác = phần còn lại,
      // lọc tiếp theo nhóm phụ. Mã hoá đơn (nếu có) lọc CHỒNG lên trên.
      if (view === "main") {
        if (!g.buckets.length) return false;
        if (activeBucket && !g.buckets.includes(activeBucket)) return false;
      } else {
        if (g.buckets.length) return false;
        if (otherCat && g.otherBucket !== otherCat) return false;
      }
      if (payRef && !g.payRefs.includes(payRef)) return false;
      if (local) {
        const hay = `${g.title} ${g.emails.join(" ")} ${g.events
          .map((e) => `${e.action} ${e.actor_label ?? ""} ${e.target_id ?? ""}`)
          .join(" ")}`.toLowerCase();
        if (!hay.includes(local)) return false;
      }
      return true;
    });
  }, [groups, view, activeBucket, otherCat, payRef, search, searching]);

  const total = groups.length;
  // Số trên chip đếm theo TOÀN BỘ nhật ký (không theo bộ lọc đang bật) → bấm qua
  // lại giữa các chip không thấy số nhảy (xem `mainCounts` ở trên).
  const otherCounts = useMemo(() => {
    const by: Record<OtherBucket, number> = {
      member: 0,
      wallet: 0,
      queue: 0,
      config: 0,
      misc: 0,
    };
    for (const g of groups) if (g.otherBucket) by[g.otherBucket] += 1;
    return by;
  }, [groups]);
  const importantCount = useMemo(
    () => groups.filter((g) => g.buckets.length > 0).length,
    [groups],
  );
  const otherCount = total - importantCount;
  const routineCount = otherCount;
  // Ô "Cảnh báo bảo mật" (chữ đỏ) chỉ đếm ĐĂNG NHẬP HỎNG/BỊ CHẶN — đăng nhập
  // thành công là chuyện thường ngày, đếm chung vào đây thì con số đỏ mất nghĩa
  // (chip "Bảo mật" bên dưới vẫn hiện đủ cả lịch sử đăng nhập).
  const securityAlertCount = useMemo(
    () =>
      groups.filter(
        (g) =>
          g.buckets.includes("security") &&
          g.events.some((e) => /^LOGIN_(FAILED|BLOCKED)/.test(opOf(e.action))),
      ).length,
    [groups],
  );

  const goTab = (next: "main" | "other") => {
    setView(next);
    setBucket(null);
    setOtherCat(null);
    setPayRef(null);
  };

  /* Bấm mã hoá đơn trên một lệnh → tab Chính · chip Thanh toán · lọc đúng mã đó,
     và mở sẵn nhóm có dòng tiền. Lệnh gia hạn ghi phí ở MỘT NHÓM RIÊNG (khoản
     `renew_fee` neo vào member_id, không có queue_item_id để gộp) nên bộ lọc mã
     là cách duy nhất gom lệnh + tiền của nó về cùng một màn. Nếu mã đó chưa có
     dòng tiền nào (mời trả bằng QR mà hoá đơn đã bị dọn) thì KHÔNG bật chip
     Thanh toán, tránh danh sách rỗng. */
  const openPayments = (ref: string) => {
    const hits = groups.filter((g) => g.payRefs.includes(ref));
    const billing = hits.filter((g) => g.buckets.includes("billing"));
    setSearch(""); // lọc theo mã là bộ lọc tại chỗ — đang tìm server thì nó bị bỏ qua
    setView("main");
    setBucket(billing.length ? "billing" : null);
    setOtherCat(null);
    setPayRef(ref);
    setExpanded((billing[0] ?? hits[0])?.key ?? null);
  };

  return (
    <div className="page-fade">
      {/* Đang tìm thì kết quả đến từ MỌI ngày — để thanh ngày đứng đó chỉ gây hiểu
          nhầm là đang xem một ngày. Xoá tìm kiếm là nó trở lại đúng ngày cũ. */}
      {!searching && <DayPicker day={day} onPick={setDay} />}

      {/* Dải tóm tắt — đếm theo NGÀY ĐANG XEM */}
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
            {securityAlertCount}
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
        {/* Đang tìm: thay dãy tab/chip bằng một dòng nói rõ đang tìm gì, tìm ở đâu
            (toàn bộ nhật ký, mọi ngày) và ra bao nhiêu — kèm nút xoá tìm kiếm. */}
        {searching ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              fontSize: 12.5,
              color: "var(--ink)",
              background: "var(--surface-2)",
              border: "1px solid var(--border-strong)",
              borderRadius: 999,
              padding: "6px 12px",
            }}
          >
            <span>
              {searchLogs.isLoading
                ? t("audit.searchRunning", { q })
                : t("audit.searchResult", { q, n: filtered.length })}
            </span>
            <button
              type="button"
              onClick={() => setSearch("")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 12,
                fontWeight: 600,
                color: "var(--ink-3)",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            >
              {t("audit.searchClear")} ✕
            </button>
          </div>
        ) : (
          <>
          {/* 2 tab: Chính (bảo mật · thành viên · thanh toán) · Khác (phần còn lại) */}
          <Chip
            active={view === "main"}
            onClick={() => goTab("main")}
            label={t("audit.tab.main")}
            count={importantCount}
          />
          <Chip
            active={view === "other"}
            onClick={() => goTab("other")}
            label={t("audit.tab.other")}
            count={otherCount}
          />
          {/* Nhóm phụ của tab đang xem (bấm lại để bỏ lọc). */}
          {(view === "main"
            ? MAIN_BUCKETS.some((b) => mainCounts[b] > 0)
            : OTHER_BUCKETS.some((b) => otherCounts[b] > 0)) && (
            <div
              style={{
                width: 1,
                height: 24,
                background: "var(--border-strong)",
                margin: "0 4px",
              }}
            />
          )}
          {view === "main"
            ? MAIN_BUCKETS.filter((b) => mainCounts[b] > 0).map((b) => (
                <Chip
                  key={b}
                  active={activeBucket === b}
                  onClick={() => {
                    setBucket((prev) => (prev === b ? null : b));
                    setPayRef(null);
                  }}
                  label={t(`audit.cat.${b}`)}
                  count={mainCounts[b]}
                />
              ))
            : OTHER_BUCKETS.filter((b) => otherCounts[b] > 0).map((b) => (
                <Chip
                  key={b}
                  active={otherCat === b}
                  onClick={() =>
                    setOtherCat((prev) => (prev === b ? null : b))
                  }
                  label={t(`audit.other.${b}`)}
                  count={otherCounts[b]}
                />
              ))}
          {/* Đang lọc theo mã hoá đơn — nói rõ đang xem tiền của lệnh nào + nút bỏ lọc. */}
          {payRef && (
            <button
              type="button"
              onClick={() => setPayRef(null)}
              title={t("audit.payRefClear")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: "var(--ink)",
                background: "var(--surface-2)",
                border: "1px solid var(--border-strong)",
                borderRadius: 999,
                padding: "5px 11px",
                cursor: "pointer",
              }}
            >
              {t("audit.payRefFilter", { code: shortRef(payRef) })}
              <span style={{ color: "var(--ink-3)", fontSize: 13 }}>✕</span>
            </button>
          )}
          </>
        )}
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
          isLoading={feed.isLoading}
          onOpenPayments={openPayments}
          day={searching ? null : day}
          searchQ={searching ? q : null}
          hasMore={
            searching ? searchLogs.hasNextPage : day ? false : logs.hasNextPage
          }
          loadingMore={feed.isFetchingNextPage}
          onMore={() => feed.fetchNextPage()}
        />
      ) : (
        <AuditTable
          filtered={filtered}
          expanded={expanded}
          setExpanded={setExpanded}
          isLoading={feed.isLoading}
          onOpenPayments={openPayments}
          day={searching ? null : day}
          searchQ={searching ? q : null}
          hasMore={
            searching ? searchLogs.hasNextPage : day ? false : logs.hasNextPage
          }
          loadingMore={feed.isFetchingNextPage}
          onMore={() => feed.fetchNextPage()}
        />
      )}
      <div
        className="mono"
        style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 14 }}
      >
        {t("audit.countLabel", { shown: filtered.length, total })}
        {(searching ? searchLogs.hasNextPage : !day && logs.hasNextPage) &&
          ` · ${t("audit.moreHint")}`}
      </div>
    </div>
  );
}
