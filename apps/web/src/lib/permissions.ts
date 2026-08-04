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
  // 2 mục ChatGPT thêm vào menu "..." của member đã tham gia (2026-08). Cả 2 KHÔNG
  // nằm trong DEFAULT_SUB_ADMIN_PERMS và KHÔNG backfill cho tài khoản cũ ⇒ mặc định
  // chỉ super-admin dùng được; nút trên UI vẫn hiện nhưng LÀM MỜ khi chưa được cấp.
  MEMBER_EXPORT_DATA: "MEMBER_EXPORT_DATA",
  // XOÁ SẠCH dữ liệu member trên ChatGPT — KHÔNG HOÀN TÁC (nặng hơn MEMBER_REMOVE).
  MEMBER_DELETE_DATA: "MEMBER_DELETE_DATA",
  // Sync lẻ 1 member / batch pending (tab "Chờ tham gia") + sync billing.
  WORKSPACE_SYNC_TRIGGER: "WORKSPACE_SYNC_TRIGGER",
  // Nút TO "Đồng bộ từ ChatGPT" (full-sync toàn workspace). Khoá ĐỘC LẬP với
  // sync lẻ — mặc định TẮT (không nằm trong DEFAULT_SUB_ADMIN_PERMS).
  WORKSPACE_FULL_SYNC: "WORKSPACE_FULL_SYNC",
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
  // Cấp được nhưng KHÔNG default-on (xem DEFAULT_SUB_ADMIN_PERMS) ⇒ khoá sẵn.
  "MEMBER_EXPORT_DATA",
  "MEMBER_DELETE_DATA",
  "WORKSPACE_SYNC_TRIGGER",
  // Full-sync (nút TO "Đồng bộ từ ChatGPT") — grantable nhưng KHÔNG default-on
  // (không có trong DEFAULT_SUB_ADMIN_PERMS) ⇒ khoá sẵn, super-admin tick mới mở.
  "WORKSPACE_FULL_SYNC",
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

// ---------------------------------------------------------------------------
// Metadata trình bày cho trang "Tài khoản phụ" (chỉ dùng ở FE).
//
// Quyền "private": thao tác có sức phá hoại / phạm vi rộng, hoặc lộ thông tin
// toàn hệ thống (nhật ký hệ thống, thanh toán) — được tô riêng (viền + nền đỏ
// nhạt) trong form cấp quyền và trong pill trên bảng để super-admin cân nhắc kỹ
// trước khi cấp.
export const SENSITIVE_PERMS: ReadonlySet<PermissionKey> = new Set<PermissionKey>(
  [
    "MEMBER_REMOVE",
    "MEMBER_SET_USAGE_LIMIT",
    "MEMBER_EXPORT_DATA",
    "MEMBER_DELETE_DATA",
    "WORKSPACE_FULL_SYNC",
    "AUDIT_LOG_VIEW",
    "BILLING_VIEW",
  ],
);

export type PermGroupId = "member" | "view" | "system" | "other";

export type PermGroup = { id: PermGroupId; codes: PermissionKey[] };

// Nhóm quyền theo chủ đề (khớp mockup thiết kế). Mọi quyền GRANTABLE chưa xếp
// nhóm sẽ tự rơi vào nhóm "other" để không bao giờ bị ẩn khỏi form khi thêm
// quyền mới vào GRANTABLE.
export const PERM_GROUPS: PermGroup[] = (() => {
  const base: PermGroup[] = [
    {
      id: "member",
      codes: [
        "MEMBER_VIEW",
        "MEMBER_INVITE",
        "MEMBER_REMOVE",
        "MEMBER_SET_USAGE_LIMIT",
        "MEMBER_EXPORT_DATA",
        "MEMBER_DELETE_DATA",
      ],
    },
    { id: "view", codes: ["QUEUE_VIEW", "AUDIT_LOG_VIEW", "BILLING_VIEW"] },
    { id: "system", codes: ["WORKSPACE_SYNC_TRIGGER", "WORKSPACE_FULL_SYNC"] },
  ];
  const grouped = new Set(base.flatMap((g) => g.codes));
  const leftover = GRANTABLE.filter((p) => !grouped.has(p));
  return leftover.length ? [...base, { id: "other", codes: leftover }] : base;
})();
