export const PERMISSIONS = {
    USER_MANAGE: "USER_MANAGE",
    EXTENSION_CONFIG: "EXTENSION_CONFIG",
    BILLING_VIEW: "BILLING_VIEW",
    BILLING_PAY: "BILLING_PAY",
    MEMBER_CHANGE_ROLE: "MEMBER_CHANGE_ROLE",
    MEMBER_VIEW: "MEMBER_VIEW",
    MEMBER_INVITE: "MEMBER_INVITE",
    MEMBER_REMOVE: "MEMBER_REMOVE",
    WORKSPACE_SYNC_TRIGGER: "WORKSPACE_SYNC_TRIGGER",
    QUEUE_VIEW: "QUEUE_VIEW",
    AUDIT_LOG_VIEW: "AUDIT_LOG_VIEW",
};
export const SUPER_ADMIN_ONLY = [
    "USER_MANAGE",
    "EXTENSION_CONFIG",
    "BILLING_VIEW",
    "BILLING_PAY",
    "MEMBER_CHANGE_ROLE",
];
export const GRANTABLE = [
    "MEMBER_VIEW",
    "MEMBER_INVITE",
    "MEMBER_REMOVE",
    "WORKSPACE_SYNC_TRIGGER",
    "QUEUE_VIEW",
    "AUDIT_LOG_VIEW",
];
export const PERMISSION_LABEL = {
    USER_MANAGE: "Quản lý tài khoản phụ",
    EXTENSION_CONFIG: "Cấu hình Extension",
    BILLING_VIEW: "Xem Billing",
    BILLING_PAY: "Thực hiện thanh toán",
    MEMBER_CHANGE_ROLE: "Đổi vai trò thành viên ChatGPT",
    MEMBER_VIEW: "Xem danh sách thành viên",
    MEMBER_INVITE: "Mời thành viên mới",
    MEMBER_REMOVE: "Xoá thành viên",
    WORKSPACE_SYNC_TRIGGER: "Kích hoạt sync workspace",
    QUEUE_VIEW: "Xem queue task",
    AUDIT_LOG_VIEW: "Xem Audit Log",
};
