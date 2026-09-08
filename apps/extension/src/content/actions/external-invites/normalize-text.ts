/**
 * Bỏ dấu + gộp khoảng trắng + thường hoá, để khớp chữ trên /admin/identity bất
 * kể ChatGPT đang vẽ bằng locale nào.
 *
 * Dùng chung cho hai bộ đọc chữ của trang này (`detect-toggle-toast` bắt câu
 * xác nhận, `detect-error-banner` bắt băng-rôn đỏ). Tách ra vì hai bộ PHẢI
 * chuẩn hoá y hệt nhau: lệch một nhịp là một bên khớp, bên kia không, mà cả hai
 * lại cùng phán về một cú bấm.
 */
export function normalizeIdentityText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
