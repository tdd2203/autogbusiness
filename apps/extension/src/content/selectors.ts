/**
 * CSS selectors cho ChatGPT Business Admin UI.
 *
 * ⚠️ ChatGPT đổi UI thường xuyên → mỗi selector có nhiều fallback.
 * Khi extension báo `UI_ELEMENT_NOT_FOUND`:
 *   1. Mở DevTools tại chatgpt.com/admin/people
 *   2. Inspect element thật sự (data-testid, aria-label, class)
 *   3. Thêm/sửa entries trong file này
 *   4. Bấm reload extension trong chrome://extensions
 *
 * KHÔNG ĐOÁN selector — verify bằng cách inspect thật trước.
 */

export const SELECTORS = {
  // Nút mở dialog "Invite members". Trang vi-VN dùng "Mời thành viên".
  // ChatGPT hiện không có data-testid → phải fallback text (xem TEXT_FALLBACKS).
  inviteButtonOpen: [
    'button[data-testid="invite-members-button"]',
    'button[aria-label*="Invite" i]',
    'button[aria-label*="Mời" i]',
    // ChatGPT hiện dùng Tailwind class btn-primary cho nút action chính
    'button.btn-primary',
  ],

  // Input email/textarea trong dialog Invite. ChatGPT 2026 thường dùng textarea
  // cho multi-email hoặc input contenteditable.
  inviteEmailInput: [
    'input[data-testid="invite-email-input"]',
    'textarea[data-testid="invite-email-input"]',
    '[role="dialog"] input[type="email"]',
    '[role="dialog"] textarea',
    '[role="dialog"] input[type="text"]',
    'input[type="email"]',
    'input[placeholder*="email" i]',
    'textarea[placeholder*="email" i]',
  ],

  // Select role trong dialog Invite (combobox Radix UI).
  inviteRoleSelect: [
    'select[data-testid="invite-role-select"]',
    'select[name="role"]',
    '[role="dialog"] button[role="combobox"]',
    'button[role="combobox"][aria-label*="role" i]',
    'button[role="combobox"][aria-label*="vai trò" i]',
  ],

  // Nút submit trong dialog Invite.
  inviteSubmitButton: [
    'button[data-testid="invite-submit-button"]',
    'button[type="submit"][aria-label*="invite" i]',
    '[role="dialog"] button.btn-primary',
    '[role="dialog"] button[type="submit"]',
  ],

  // Tab navigation trên trang /admin/members
  // (Người dùng / Lời mời đang chờ xử lý / Yêu cầu đang chờ xử lý)
  memberTabContainer: [
    // Container chứa 3 button tab — Tailwind classes (best-effort)
    'div.flex.gap-2',
    '[role="tablist"]',
    'nav[aria-label*="tab" i]',
  ],

  // Toast/banner xác nhận thành công (multi-selector + text fallback ở action layer)
  inviteSuccessToast: [
    '[role="status"]',
    '[data-testid="toast-success"]',
    '.toast-success',
  ],

  // Member rows — thử nhiều pattern. Scrape fallback theo email regex nếu tất cả fail.
  memberRow: [
    'tr[data-testid^="member-row"]',
    'div[data-testid^="member-row"]',
    '[role="row"]',
    '[data-row-index]',
    'li[role="listitem"]',
    'div[class*="MemberRow" i]',
    'div[class*="member-row" i]',
    'table tbody tr',
  ],

  // Selectors bên trong row member (relative)
  memberRowEmail: [
    '[data-testid="member-email"]',
    '.member-email',
  ],
  memberRowName: [
    '[data-testid="member-name"]',
    '.member-name',
  ],
  memberRowRole: [
    '[data-testid="member-role"]',
    '.member-role',
  ],
  // Nút "..." trong row (mở action menu)
  memberRowMenu: [
    'button[data-testid="member-menu-button"]',
    'button[aria-label*="actions" i]',
    'button[aria-haspopup="menu"]',
  ],

  // Menu item "Remove"
  removeMenuItem: [
    '[role="menuitem"][data-action="remove"]',
    '[role="menuitem"][data-testid*="remove" i]',
  ],
  // Menu item "Change role"
  changeRoleMenuItem: [
    '[role="menuitem"][data-action="change-role"]',
    '[role="menuitem"][data-testid*="change-role" i]',
  ],

  // Confirm dialog "Remove member"
  confirmRemoveButton: [
    'button[data-testid="confirm-remove-button"]',
    'button[data-variant="destructive"]',
  ],

  // Page identification
  adminPeoplePage: [
    'main[data-testid="admin-people-page"]',
    'h1[data-testid="admin-people-title"]',
  ],

  // User profile info (ChatGPT user đang đăng nhập trên browser)
  // Thường nằm ở dropdown profile góc trên phải; cũng có thể nhúng trong header
  userProfileTrigger: [
    'button[data-testid="profile-button"]',
    'button[aria-label*="profile" i]',
    'button[aria-label*="account" i]',
    'header button[aria-haspopup="menu"]',
  ],
  userEmailInDom: [
    '[data-testid="user-email"]',
    'div[class*="UserMenu"] [class*="email"]',
  ],
  userNameInDom: [
    '[data-testid="user-name"]',
    'div[class*="UserMenu"] [class*="name"]',
  ],
};

// Text fallback cho các nút khi không match selector.
// Multi-language: vi + en + zh-CN (ChatGPT auto-localize theo user setting).
export const TEXT_FALLBACKS = {
  inviteButtonOpen: [
    "Mời thành viên", "Invite members", "Invite", "Mời",
    "邀请成员", "邀请",
  ],
  inviteSubmitButton: [
    "Gửi lời mời", "Send invite", "Mời thành viên", "Invite", "Mời",
    "发送邀请", "邀请",
  ],
  removeMenuItem: [
    "Remove from workspace", "Remove", "Xoá khỏi workspace", "Xoá",
    "从工作区移除", "移除", "删除",
  ],
  changeRoleMenuItem: [
    "Change role", "Đổi vai trò",
    "更改角色", "修改角色",
  ],
  confirmRemoveButton: [
    "Remove", "Xoá", "Confirm", "Xác nhận",
    "移除", "确认", "删除",
  ],

  // Tabs trên trang /admin/members
  tabActiveMembers: [
    "Người dùng", "Members", "Users",
    "用户", "成员",
  ],
  tabPendingInvites: [
    "Lời mời đang chờ xử lý", "Pending invitations", "Pending invites",
    "待处理邀请", "待处理的邀请",
  ],
  tabPendingRequests: [
    "Yêu cầu đang chờ xử lý", "Pending requests",
    "待处理申请", "待处理的请求",
  ],

  // Tabs trên trang /admin/billing
  tabBillingPlan: ["Kế hoạch", "Plan", "套餐", "方案", "计划"],
  tabBillingInvoices: ["Hoá đơn", "Hóa đơn", "Invoices", "账单", "发票"],
};
