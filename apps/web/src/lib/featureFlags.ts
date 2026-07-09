/**
 * Cờ bật/tắt tính năng ở dashboard web — gating UI để ẨN tính năng mà KHÔNG xoá code.
 *
 * LICENSE_FEATURE_ENABLED — chức năng "đổi giấy phép" (ChatGPT/Codex) của member.
 *   Tắt (false) từ 2026-06-25: ChatGPT đã mặc định là "ChatGPT" cho mọi member nên
 *   cơ chế đổi giấy phép không còn khớp/ý nghĩa. Tắt cờ này ẩn TOÀN BỘ phần UI liên
 *   quan: cột "Giấy phép" trong bảng thành viên (Members.tsx), dropdown đổi đơn,
 *   các option đổi hàng loạt (dropdown + modal Cập nhật hàng loạt). Code backend /
 *   extension / mutation giữ nguyên (không gọi tới) để có thể bật lại bằng cách đặt
 *   cờ = true. Banner tiến trình/hoàn tất của task CHANGE_LICENSE_TYPE cũ vẫn hiển
 *   thị bình thường cho lịch sử — chỉ là không tạo task mới nữa.
 */
export const LICENSE_FEATURE_ENABLED = false;
