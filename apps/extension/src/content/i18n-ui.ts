/**
 * Chuỗi UI ChatGPT Business — chỉ vi / en / zh-CN.
 * Single source of truth cho TEXT_FALLBACKS, role labels, revoke, billing hints.
 */

import type { ChatGPTRole } from "../shared/messages";
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
    "Gửi lời mời",
    "Gửi",
    "Send invite",
    "Send invitation",
    "Invite",
    "Mời thành viên",
    "Mời",
    "发送邀请",
    "邀请",
    "提交",
  ],
  inviteAddMoreButton: [
    "Thêm nhiều hơn",
    "Thêm nhiều",
    "Thêm email",
    "Add more",
    "Add another",
    "Add many",
    "添加更多",
    "添加多个",
    "添加邮箱",
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
    "Đổi vai trò",
    "Thay đổi vai trò",
    "更改角色",
    "修改角色",
    "变更角色",
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
  "已存在",
  "已是成员",
  "已邀请",
  "无效",
  "不合法",
];

/** Label toggle "Cho phép lời mời từ miền bên ngoài" — lowercase, dùng includes(). */
export const EXTERNAL_INVITE_LABEL_PATTERNS = [
  "cho phép lời mời từ miền bên ngoài",
  "cho phép lời mời từ miền",
  "lời mời từ miền bên ngoài",
  "external domain",
  "external domains",
  "allow invites from external",
  "allow external",
  "invites from outside",
  "允许来自外部的邀请",
  "允许外部域",
  "外部域邀请",
  "外部邀请",
];
