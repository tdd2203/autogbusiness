const PERMISSIONS = {
  USER_MANAGE: "USER_MANAGE",
  EXTENSION_CONFIG: "EXTENSION_CONFIG",
  BILLING_VIEW: "BILLING_VIEW",
  BILLING_PAY: "BILLING_PAY",
  MEMBER_CHANGE_ROLE: "MEMBER_CHANGE_ROLE",
  UI_LABEL_MANAGE: "UI_LABEL_MANAGE",
  MEMBER_VIEW: "MEMBER_VIEW",
  MEMBER_INVITE: "MEMBER_INVITE",
  MEMBER_REMOVE: "MEMBER_REMOVE",
  MEMBER_SET_USAGE_LIMIT: "MEMBER_SET_USAGE_LIMIT",
  WORKSPACE_SYNC_TRIGGER: "WORKSPACE_SYNC_TRIGGER",
  QUEUE_VIEW: "QUEUE_VIEW",
  AUDIT_LOG_VIEW: "AUDIT_LOG_VIEW",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const GRANTABLE: PermissionKey[] = [
  "MEMBER_VIEW",
  "MEMBER_INVITE",
  "MEMBER_REMOVE",
  // MEMBER_SET_USAGE_LIMIT: yêu cầu đặt giới hạn tín dụng (vẫn cần admin DUYỆT +
  // chỉ trong NGÂN SÁCH cấp riêng từng workspace).
  "MEMBER_SET_USAGE_LIMIT",
  "WORKSPACE_SYNC_TRIGGER",
  "QUEUE_VIEW",
  "AUDIT_LOG_VIEW",
  // BILLING_VIEW: cấp được cho sub-admin (chỉ xem thanh toán).
  "BILLING_VIEW",
];

// Quyền mặc định khi tạo tài khoản phụ mới: add thành viên + xem thành viên đã
// add + xem queue task (chỉ task do chính họ tạo) + thu hồi/xoá thành viên
// (MEMBER_REMOVE — vẫn chỉ xoá được member do chính họ mời, theo visibility
// filter ở backend). Mọi admin phụ đều có sẵn chức năng thu hồi/xoá.
export const DEFAULT_SUB_ADMIN_PERMS: PermissionKey[] = [
  "MEMBER_VIEW",
  "MEMBER_INVITE",
  "MEMBER_REMOVE",
  "QUEUE_VIEW",
  "WORKSPACE_SYNC_TRIGGER",
];
