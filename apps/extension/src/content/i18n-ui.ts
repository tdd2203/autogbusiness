/**
 * Chuỗi UI ChatGPT Business — chỉ vi / en / zh-CN.
 * Single source of truth cho TEXT_FALLBACKS, role labels, revoke, billing hints.
 */

import type { ChatGPTRole, LicenseType } from "../shared/messages";
import {
  dbLabelsFor,
  reportLabelMismatch,
  type UiLabelPage,
} from "../shared/ui-labels";
import { queryByAnyText, queryByText } from "./human";

/** Nút, tab, menu — match theo text hiển thị khi selector CSS fail. */
export const TEXT_FALLBACKS = {
  inviteButtonOpen: [
    "Mời thành viên",
    "Mời",
    "Invite members",
    "Invite member",
    "Invite",
    "Add members",
    "邀请成员",
    "邀请",
    "添加成员",
  ],
  inviteSubmitButton: [
    // Explicit plural variants — UI 2026 ChatGPT dùng "Send invites" / "Gửi lời mời"
    "Send invites",
    "Gửi lời mời",
    "Send invitations",
    "Gửi các lời mời",
    "发送邀请",
    "Send invite",
    "Send invitation",
    "Gửi",
    "Invite",
    "Mời thành viên",
    "Mời",
    "邀请",
    "提交",
  ],
  inviteAddMoreButton: [
    "Add more",
    "Add another",
    "Add another member",
    "Add a member",
    "Add row",
    "Thêm nhiều hơn",
    "Thêm nhiều",
    "Thêm email",
    "Thêm thành viên",
    "Thêm dòng",
    "Thêm",
    "Add many",
    "添加更多",
    "添加多个",
    "添加成员",
    "添加邮箱",
    "添加一行",
    "更多",
  ],
  removeMenuItem: [
    "Remove from workspace",
    "Remove member",
    "Remove",
    "Delete",
    "Xoá khỏi workspace",
    "Xóa khỏi workspace",
    "Gỡ khỏi workspace",
    "Xoá",
    "Xóa",
    "从工作区移除",
    "移除成员",
    "移除",
    "删除",
  ],
  changeRoleMenuItem: [
    "Change role",
    "Edit role",
    "Manage role",
    // UI 2026: row menu chỉ còn "Change seat type" (mở submenu chọn ChatGPT/Codex/…).
    // Đổi role thực hiện qua dropdown "Member ▼" ngay trên row, không qua menu.
    // Ta vẫn liệt kê text này phòng trường hợp ChatGPT đổi lại UI hoặc workspace
    // có entry "Change role" riêng.
    "Change seat type",
    "Edit seat type",
    "Đổi vai trò",
    "Thay đổi vai trò",
    "Đổi loại ghế",
    "Thay đổi loại ghế",
    "更改角色",
    "修改角色",
    "变更角色",
    "更改席位类型",
    "修改席位类型",
  ],
  // Item menu "..." trên row member mở submenu chọn loại giấy phép (ChatGPT/Codex).
  // UI 2026 vi: "Thay đổi loại giấy phép". Có thể là submenu trigger hoặc header.
  changeLicenseTypeMenuItem: [
    "Thay đổi loại giấy phép",
    "Đổi loại giấy phép",
    "Thay đổi giấy phép",
    "Loại giấy phép",
    "Change license type",
    "Change license",
    "Edit license type",
    "License type",
    "Change seat type",
    "Edit seat type",
    "更改许可证类型",
    "修改许可证类型",
    "更改许可证",
    "许可证类型",
    "更改席位类型",
  ],
  confirmRemoveButton: [
    "Remove",
    "Confirm",
    "Delete",
    "Xoá",
    "Xóa",
    "Xác nhận",
    "Gỡ",
    "移除",
    "确认",
    "删除",
  ],
  tabActiveMembers: [
    "Người dùng",
    "Thành viên",
    "Members",
    "Users",
    "People",
    "Active members",
    "用户",
    "成员",
    "活跃用户",
    "活跃成员",
  ],
  tabPendingInvites: [
    "Lời mời đang chờ xử lý",
    "Lời mời đang chờ",
    "Lời mời",
    "Pending invitations",
    "Pending invites",
    "Invitations",
    "Pending",
    "待处理邀请",
    "待处理的邀请",
    "待邀请",
    "邀请待处理",
  ],
  tabPendingRequests: [
    "Yêu cầu đang chờ xử lý",
    "Yêu cầu đang chờ",
    "Yêu cầu",
    "Pending requests",
    "Join requests",
    "Requests",
    "待处理申请",
    "待处理的请求",
    "待批准",
    "加入请求",
  ],
  tabBillingPlan: [
    "Kế hoạch",
    "Gói",
    "Plan",
    "Billing",
    "Subscription",
    "套餐",
    "方案",
    "计划",
    "订阅",
  ],
  tabBillingInvoices: [
    "Hoá đơn",
    "Hóa đơn",
    "Invoices",
    "Invoice history",
    "账单",
    "发票",
    "账单历史",
  ],
  // Link/button mở modal review để mua thêm seat trên /admin/billing?tab=plan.
  billingManageLicenses: [
    "Quản lý giấy phép",
    "Quản lý suất",
    "Quản lý chỗ ngồi",
    "Manage licenses",
    "Manage seats",
    "Manage license",
    "管理许可证",
    "管理席位",
    "管理许可",
  ],
  // Nút submit modal review (chuyển sang trang xác nhận thanh toán).
  billingContinueButton: [
    "Tiếp tục",
    "Continue",
    "Next",
    "Proceed",
    "继续",
    "下一步",
  ],
  // Nút tăng số người dùng trong modal review.
  billingIncrementButton: [
    "Tăng",
    "Thêm",
    "Increase",
    "Increment",
    "Add",
    "Plus",
    "增加",
    "加",
  ],
  // Nút FINAL CHARGE của modal review THỨ 2 ("Quản lý chỗ ngồi") — sau khi
  // bấm "Tiếp tục" ở modal đầu. Click nút này = THẬT SỰ CHARGE TIỀN qua
  // Stripe payment method đã lưu. Extension PHẢI verify trước khi click.
  billingAddUserButton: [
    "Thêm người dùng",
    "Thêm thành viên",
    "Xác nhận thanh toán",
    "Add user",
    "Add users",
    "Add member",
    "Confirm payment",
    "Confirm and pay",
    "添加用户",
    "添加成员",
    "确认付款",
    "确认并付款",
  ],
} as const;

/** Label hiển thị khi chọn role trong combobox / submenu. */
export const ROLE_LABELS: Record<ChatGPTRole, string[]> = {
  owner: [
    "Chủ sở hữu",
    "Owner",
    "Workspace owner",
    "所有者",
    "拥有者",
    "负责人",
  ],
  admin: [
    "Quản trị viên",
    "Admin",
    "Administrator",
    "Workspace admin",
    "管理员",
    "管理",
  ],
  member: [
    "Thành viên",
    "Member",
    "Standard member",
    "成员",
    "普通成员",
  ],
  analytics_viewer: [
    "Trình xem dữ liệu phân tích",
    "Analytics viewer",
    "Analytics Viewer",
    "Data analytics viewer",
    "分析查看器",
    "数据分析查看器",
  ],
};

/** Keyword nhận diện role khi scrape row (substring match, đã normalize). */
const ROLE_KEYWORDS: Array<{ role: ChatGPTRole; patterns: string[] }> = [
  {
    role: "owner",
    patterns: ["owner", "chu so huu", "所有者", "拥有者", "负责人"],
  },
  {
    role: "admin",
    patterns: ["admin", "administrator", "quan tri", "管理员", "管理"],
  },
  {
    role: "member",
    patterns: ["member", "thanh vien", "成员", "普通成员"],
  },
  {
    role: "analytics_viewer",
    patterns: [
      "analytics viewer",
      "data analytics",
      "trinh xem du lieu",
      "分析查看器",
      "数据分析",
    ],
  },
];

export function parseChatGPTRole(
  raw: string | null | undefined,
): ChatGPTRole | null {
  if (!raw) return null;
  const t = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  for (const { role, patterns } of ROLE_KEYWORDS) {
    if (patterns.some((p) => t.includes(p))) return role;
  }
  return null;
}

export function findRoleOption(
  role: ChatGPTRole,
  root: ParentNode = document,
): HTMLElement | null {
  const controlKey = `invite_role_${role}`;
  const dbLabels = dbLabelsFor(controlKey, "/admin/members");
  const labels = dbLabels.length > 0 ? [...dbLabels, ...ROLE_LABELS[role]] : ROLE_LABELS[role];
  for (const label of labels) {
    const el =
      queryByText('[role="menuitem"]', label, root) ??
      queryByText('[role="option"]', label, root) ??
      queryByText('[role="menuitemradio"]', label, root) ??
      queryByText("button", label, root) ??
      queryByText("li", label, root);
    if (el) return el;
  }
  if (dbLabels.length > 0) {
    reportLabelMismatch(controlKey, dbLabels[0], "/admin/members");
  }
  return null;
}

/**
 * Label hiển thị cho loại giấy phép. ChatGPT/Codex là brand name — giống nhau
 * mọi locale, nhưng vẫn để mảng phòng biến thể chữ hoa/khoảng trắng.
 */
export const LICENSE_TYPE_LABELS: Record<LicenseType, string[]> = {
  ChatGPT: ["ChatGPT", "Chat GPT"],
  Codex: ["Codex"],
};

/** Keyword nhận diện license khi scrape row (substring, đã normalize lowercase). */
const LICENSE_KEYWORDS: Array<{ type: LicenseType; patterns: string[] }> = [
  // Codex trước ChatGPT: "Codex" không bao giờ chứa "chatgpt" nên match Codex
  // chính xác; còn "ChatGPT" là default phổ biến nhất.
  { type: "Codex", patterns: ["codex"] },
  { type: "ChatGPT", patterns: ["chatgpt", "chat gpt"] },
];

/**
 * Parse loại giấy phép từ text 1 CELL (đã scope về đúng ô "Loại suất cấp phép").
 * KHÔNG truyền nguyên row text vào đây — "chatgpt" xuất hiện ở nhiều chỗ
 * (tên workspace, link...) dễ false-positive. Dùng findLicenseTypeInRow để
 * scope trước.
 */
export function parseLicenseType(
  raw: string | null | undefined,
): LicenseType | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  for (const { type, patterns } of LICENSE_KEYWORDS) {
    if (patterns.some((p) => t.includes(p))) return type;
  }
  return null;
}

/** Tìm option ChatGPT/Codex trong menu/submenu đang mở (mirror findRoleOption). */
export function findLicenseTypeOption(
  type: LicenseType,
  root: ParentNode = document,
): HTMLElement | null {
  for (const label of LICENSE_TYPE_LABELS[type]) {
    const el =
      queryByText('[role="menuitemradio"]', label, root) ??
      queryByText('[role="menuitem"]', label, root) ??
      queryByText('[role="option"]', label, root) ??
      queryByText("button", label, root) ??
      queryByText("li", label, root);
    if (el) return el;
  }
  return null;
}

/** Tìm button/tab/link theo danh sách text (vi/en/zh). */
export function findUiControlByTexts(
  texts: readonly string[],
  root: ParentNode = document,
): HTMLElement | null {
  return (
    queryByAnyText("button", texts, root) ??
    queryByAnyText('[role="tab"]', texts, root) ??
    queryByAnyText("a", texts, root)
  );
}

/**
 * Tìm control theo control_key (đã harvest vào DB) + fallback text patterns.
 * Hierarchy:
 *   1. Thử label_text/aria_label đã lưu (cho locale hiện tại) — match nhanh, chính xác.
 *   2. Nếu không thấy → fallback sang text patterns hardcode (đa ngôn ngữ).
 *   3. Nếu DB có label và cả 2 đều không match → fire-and-forget mismatch report
 *      để dashboard hiện banner "stale, cần re-harvest".
 */
export function findControlByKey(
  controlKey: string,
  fallback: readonly string[],
  options?: { page?: UiLabelPage; root?: ParentNode },
): HTMLElement | null {
  const dbLabels = dbLabelsFor(controlKey, options?.page);
  const merged = dbLabels.length > 0 ? [...dbLabels, ...fallback] : fallback;
  const el = findUiControlByTexts(merged, options?.root ?? document);
  if (!el && dbLabels.length > 0) {
    reportLabelMismatch(controlKey, dbLabels[0], options?.page);
  }
  return el;
}

/**
 * Phát hiện ngôn ngữ hiện tại của ChatGPT từ `document.documentElement.lang`.
 * Trả về normalized 'vi' | 'en' | 'zh' hoặc null nếu không xác định được.
 */
export type ChatGPTLocale = "vi" | "en" | "zh";

export function detectChatGPTLocale(): ChatGPTLocale | null {
  const raw = (document.documentElement.lang ?? "").toLowerCase().trim();
  if (!raw) return null;
  if (raw.startsWith("vi")) return "vi";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("en") || raw === "c" || raw === "us") return "en";
  return null;
}

/**
 * So sánh ChatGPT locale với expected locale (truyền vào từ payload task).
 * Trả về { match, current, expected, hint } — `hint` là gợi ý hiển thị cho user
 * khi mismatch, có instructions để đổi ChatGPT về đúng locale.
 */
export function checkLocaleMatch(expected: ChatGPTLocale | null): {
  match: boolean;
  current: ChatGPTLocale | null;
  expected: ChatGPTLocale | null;
  hint: string;
} {
  const current = detectChatGPTLocale();
  if (!expected) return { match: true, current, expected, hint: "" };
  if (!current) {
    return {
      match: false,
      current,
      expected,
      hint:
        `Không phát hiện được ngôn ngữ ChatGPT (document.documentElement.lang rỗng). ` +
        `Dashboard cấu hình '${expected}'. Vui lòng đổi ngôn ngữ ChatGPT về '${expected}' tại profile menu → Settings → Locale.`,
    };
  }
  if (current === expected) return { match: true, current, expected, hint: "" };
  const nameMap: Record<ChatGPTLocale, string> = {
    vi: "Tiếng Việt",
    en: "English",
    zh: "中文 (Simplified Chinese)",
  };
  return {
    match: false,
    current,
    expected,
    hint:
      `ChatGPT đang dùng ${nameMap[current]} (${current}) nhưng dashboard cấu hình ${nameMap[expected]} (${expected}). ` +
      `Vui lòng đổi ngôn ngữ ChatGPT về ${nameMap[expected]} qua: avatar (góc phải trên) → Settings → Locale → chọn ${nameMap[expected]} → reload trang. ` +
      `Sau đó retry task này từ dashboard.`,
  };
}

/** Variant cho menuitem / option (dialog dropdown menu). */
export function findMenuItemByKey(
  controlKey: string,
  fallback: readonly string[],
  options?: { page?: UiLabelPage; root?: ParentNode },
): HTMLElement | null {
  const dbLabels = dbLabelsFor(controlKey, options?.page);
  const merged = dbLabels.length > 0 ? [...dbLabels, ...fallback] : fallback;
  const root = options?.root ?? document;
  const el =
    queryByAnyText('[role="menuitem"]', merged, root) ??
    queryByAnyText('[role="option"]', merged, root) ??
    queryByAnyText('[role="menuitemradio"]', merged, root) ??
    queryByAnyText("button", merged, root) ??
    queryByAnyText("li", merged, root);
  if (!el && dbLabels.length > 0) {
    reportLabelMismatch(controlKey, dbLabels[0], options?.page);
  }
  return el;
}

export const REVOKE_MENU_ITEM_TEXTS = [
  "Thu hồi lời mời",
  "Thu hồi",
  "Hủy lời mời",
  "Revoke invite",
  "Revoke invitation",
  "Revoke",
  "Cancel invite",
  "Cancel invitation",
  "撤销邀请",
  "取消邀请",
  "撤回邀请",
];

export const REVOKE_CONFIRM_TEXTS = [
  "Thu hồi",
  "Xác nhận",
  "Hủy",
  "Revoke",
  "Confirm",
  "Cancel",
  "撤销",
  "确认",
  "取消",
];

export const INVITE_ERROR_HINTS = [
  "đã tồn tại",
  "already exists",
  "already a member",
  "already invited",
  "đã được mời",
  "invalid",
  "không hợp lệ",
  "not valid",
  // Seat limit / cần mua thêm ghế
  "not enough seats",
  "insufficient seats",
  "seat limit",
  "buy more seats",
  "add more seats",
  "out of seats",
  "no seats available",
  "exceeds your seat",
  "reached your seat",
  "không đủ chỗ",
  "không đủ ghế",
  "hết ghế",
  "vượt quá số ghế",
  "mua thêm ghế",
  "thêm ghế",
  "席位不足",
  "席位已用完",
  "已达席位上限",
  "需要更多席位",
  "购买更多席位",
  // External domain blocked
  "external domain",
  "outside your organization",
  "miền bên ngoài",
  "外部域",
  "已存在",
  "已是成员",
  "已邀请",
  "无效",
  "不合法",
];

/**
 * Label toggle "Allow External Domain Invites" / "Cho phép lời mời từ miền
 * bên ngoài" — lowercase, dùng includes(). Patterns sort theo độ đặc trưng:
 * pattern dài (match nhiều token) ưu tiên hơn pattern ngắn để chống false-match
 * với các toggle khác trên cùng /admin/identity (vd "Automatic Account Creation").
 */
export const EXTERNAL_INVITE_LABEL_PATTERNS = [
  "allow external domain invites",
  "allow external domain invite",
  "external domain invites",
  "external domain invite",
  "allow invites from external",
  "invites from external domain",
  "invites from outside",
  "cho phép lời mời từ miền bên ngoài",
  "lời mời từ miền bên ngoài",
  "cho phép lời mời từ miền",
  "lời mời từ miền",
  "miền bên ngoài",
  "允许来自外部域的邀请",
  "允许来自外部的邀请",
  "允许外部域邀请",
  "允许外部邀请",
  "外部域邀请",
  "外部邀请",
];

/**
 * Patterns dùng để LOẠI TRỪ — nếu row text của một switch chứa pattern này,
 * switch đó KHÔNG phải "External Domain Invites" dù có match pattern trên.
 *
 * /admin/identity của ChatGPT có nhiều toggle gần nhau (Automatic Account
 * Creation, SSO required, ...). Trước đây walk-up ancestor đụng phải container
 * chứa cả 2 toggle → grab nhầm. Exclude list này là lớp bảo vệ thứ 2 sau khi
 * đã scope về row đơn-switch.
 */
export const EXTERNAL_INVITE_EXCLUDE_PATTERNS = [
  "automatic account creation",
  "auto account creation",
  "automatically create accounts",
  "tự động tạo tài khoản",
  "tự động tạo account",
  "tạo tài khoản tự động",
  "自动创建账户",
  "自动创建账号",
  "自动账户创建",
  "自动帐号创建",
];
