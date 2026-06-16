export const PERMISSIONS = {
  USER_MANAGE: "USER_MANAGE",
  EXTENSION_CONFIG: "EXTENSION_CONFIG",
  BILLING_VIEW: "BILLING_VIEW",
  BILLING_PAY: "BILLING_PAY",
  MEMBER_CHANGE_ROLE: "MEMBER_CHANGE_ROLE",
  UI_LABEL_MANAGE: "UI_LABEL_MANAGE",
  MEMBER_VIEW: "MEMBER_VIEW",
  MEMBER_INVITE: "MEMBER_INVITE",
  MEMBER_REMOVE: "MEMBER_REMOVE",
  WORKSPACE_SYNC_TRIGGER: "WORKSPACE_SYNC_TRIGGER",
  QUEUE_VIEW: "QUEUE_VIEW",
  AUDIT_LOG_VIEW: "AUDIT_LOG_VIEW",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const SUPER_ADMIN_ONLY: PermissionKey[] = [
  "USER_MANAGE",
  "EXTENSION_CONFIG",
  "BILLING_PAY",
  "MEMBER_CHANGE_ROLE",
  "UI_LABEL_MANAGE",
];

export const GRANTABLE: PermissionKey[] = [
  "MEMBER_VIEW",
  "MEMBER_INVITE",
  "MEMBER_REMOVE",
  "WORKSPACE_SYNC_TRIGGER",
  "QUEUE_VIEW",
  "AUDIT_LOG_VIEW",
  // BILLING_VIEW: cấp được cho sub-admin (chỉ xem thanh toán).
  "BILLING_VIEW",
];

// Quyền mặc định khi tạo tài khoản phụ mới: add thành viên + xem thành viên đã
// add + xem queue task (chỉ task do chính họ tạo). Xoá thành viên
// (MEMBER_REMOVE) để admin chủ động tick thêm nếu cần.
export const DEFAULT_SUB_ADMIN_PERMS: PermissionKey[] = [
  "MEMBER_VIEW",
  "MEMBER_INVITE",
  "QUEUE_VIEW",
  "WORKSPACE_SYNC_TRIGGER",
];

export const PERMISSION_LABEL: Record<PermissionKey, string> = {
  USER_MANAGE: "Quản lý tài khoản phụ",
  EXTENSION_CONFIG: "Cấu hình Extension",
  BILLING_VIEW: "Xem Billing",
  BILLING_PAY: "Thực hiện thanh toán",
  MEMBER_CHANGE_ROLE: "Đổi vai trò thành viên ChatGPT",
  UI_LABEL_MANAGE: "Quản lý label UI ChatGPT",
  MEMBER_VIEW: "Xem danh sách thành viên",
  MEMBER_INVITE: "Mời thành viên mới",
  MEMBER_REMOVE: "Xoá thành viên",
  WORKSPACE_SYNC_TRIGGER: "Kích hoạt sync workspace",
  QUEUE_VIEW: "Xem queue task",
  AUDIT_LOG_VIEW: "Xem Audit Log",
};
