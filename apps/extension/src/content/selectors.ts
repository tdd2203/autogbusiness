/**
 * CSS selectors cho ChatGPT Business Admin UI.
 *
 * ⚠️ ChatGPT đổi UI thường xuyên → mỗi selector có nhiều fallback.
 * Text fallback (vi/en/zh-CN) nằm ở i18n-ui.ts — import TEXT_FALLBACKS từ đó.
 */

export { TEXT_FALLBACKS } from "./i18n-ui";

export const SELECTORS = {
  // Nút mở dialog "Invite members". Trang vi-VN dùng "Mời thành viên".
  // ChatGPT hiện không có data-testid → phải fallback text (xem TEXT_FALLBACKS).
  //
  // QUAN TRỌNG: KHÔNG dùng selector `button[aria-label*="Mời" i]` — quá greedy,
  // match toggle "Cho phép lời mời từ miền bên ngoài" trên /admin/identity. Phải
  // match cụm 2-3 từ (member/thành viên/成员) để loại trừ toggles.
  inviteButtonOpen: [
    'button[data-testid="invite-members-button"]',
    'button[data-testid="invite-button"]',
    // Aria-label SPECIFIC (cả 2 từ "invite + member" / "mời + thành viên")
    'button[aria-label*="Invite member" i]',
    'button[aria-label*="Invite members" i]',
    'button[aria-label*="Mời thành viên" i]',
    'button[aria-label*="邀请成员" i]',
  ],

  // Input email/textarea trong dialog Invite. ChatGPT 2026 dùng Radix UI →
  // dialog có thể có `role="alertdialog"`, `aria-modal="true"`, hoặc
  // `[data-state="open"]` thay vì `role="dialog"`. List multi-selector phủ
  // tất cả pattern + fallback page-wide.
  inviteEmailInput: [
    'input[data-testid="invite-email-input"]',
    'textarea[data-testid="invite-email-input"]',
    // Dialog scoped — đa pattern Radix UI
    '[role="dialog"] input[type="email"]',
    '[role="dialog"] textarea',
    '[role="dialog"] input[type="text"]',
    '[role="alertdialog"] input[type="email"]',
    '[role="alertdialog"] input[type="text"]',
    '[aria-modal="true"] input[type="email"]',
    '[aria-modal="true"] input[type="text"]',
    '[aria-modal="true"] textarea',
    '[data-state="open"] input[type="email"]',
    '[data-state="open"] input[type="text"]',
    // Page-wide fallback (last resort) — vẫn ưu tiên email type
    'input[type="email"]',
    'input[placeholder*="email" i]',
    'input[name*="email" i]',
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

  // Input "Lọc theo tên" trên /admin/members (tab Người dùng) — UI 2026 có
  // ô search filter ngay phía trên list. Dùng để filter row khi cần REMOVE
  // member trong list dài (tránh phải scroll qua hết 100+ row).
  memberFilterInput: [
    'input[data-testid="member-filter-input"]',
    'input[type="search"]',
    'input[placeholder*="Lọc" i]',
    'input[placeholder*="Filter" i]',
    'input[placeholder*="筛选" i]',
    'input[placeholder*="过滤" i]',
    'input[aria-label*="Lọc" i]',
    'input[aria-label*="Filter" i]',
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
