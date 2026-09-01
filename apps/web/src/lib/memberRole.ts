/**
 * Khoá i18n cho vai trò thành viên.
 *
 * Vai trò lưu trong DB (`members.chatgpt_role`) là snake_case: ChatGPT có
 * `analytics_viewer`, Canva có `brand_designer`. Khoá i18n lại là PascalCase
 * (`member.roleAnalyticsViewer`) nên phải ghép viết hoa TỪNG chữ đầu — chỉ hoa chữ
 * cái đầu chuỗi sẽ ra khoá không tồn tại và trang bày nguyên khoá ra cho khách xem.
 */
export function roleKeySuffix(role: string): string {
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
