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
  // Nút mở dialog "Invite members"
  inviteButtonOpen: [
    'button[data-testid="invite-members-button"]',
    'button[aria-label*="Invite" i]',
    'button[aria-label*="Mời" i]',
  ],

  // Input email trong dialog Invite
  inviteEmailInput: [
    'input[data-testid="invite-email-input"]',
    'input[type="email"]',
    'input[placeholder*="email" i]',
  ],

  // Select role trong dialog Invite
  inviteRoleSelect: [
    'select[data-testid="invite-role-select"]',
    'select[name="role"]',
    'button[role="combobox"][aria-label*="role" i]',
  ],

  // Nút submit Invite
  inviteSubmitButton: [
    'button[data-testid="invite-submit-button"]',
    'button[type="submit"][aria-label*="invite" i]',
  ],

  // Toast/banner xác nhận thành công (multi-selector + text fallback ở action layer)
  inviteSuccessToast: [
    '[role="status"]',
    '[data-testid="toast-success"]',
    '.toast-success',
  ],

  // Member rows
  memberRow: [
    'tr[data-testid^="member-row"]',
    'div[data-testid^="member-row"]',
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
};

// Text fallback cho các nút khi không match selector
export const TEXT_FALLBACKS = {
  inviteButtonOpen: ["Invite members", "Invite", "Mời thành viên", "Mời"],
  inviteSubmitButton: ["Send invite", "Invite", "Mời"],
  removeMenuItem: ["Remove from workspace", "Remove", "Xoá khỏi workspace", "Xoá"],
  changeRoleMenuItem: ["Change role", "Đổi vai trò"],
  confirmRemoveButton: ["Remove", "Xoá", "Confirm", "Xác nhận"],
};
