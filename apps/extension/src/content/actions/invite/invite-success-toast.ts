/**
 * Đọc TOAST xác nhận của ChatGPT sau cú bấm "Gửi lời mời"
 * (ví dụ thật 28/8/2026: "Đã mời 3 users tham gia CHAT GPT PRO").
 *
 * ⚠️ VÌ SAO KHÔNG DÙNG `querySelectorFirst` NHƯ BẢN CŨ: selector đầu danh sách là
 * `[role="status"]` — vùng live-region CHUNG của ChatGPT. Trang admin có nhiều
 * node `[role="status"]` (banner tín dụng, vùng đếm...) và toast mời thường KHÔNG
 * phải node đầu tiên. `querySelectorFirst` lấy đúng node đầu, thấy chữ không khớp
 * là bỏ luôn → mất bằng chứng MẠNH nhất dù ChatGPT đã nói rõ "đã mời".
 * Ở đây quét TOÀN BỘ node khớp selector, gặp node nào có chữ xác nhận thì lấy.
 *
 * Vẫn phải khớp CHỮ (`INVITE_SUCCESS_TOAST_PATTERNS`): thấy live-region rỗng mà
 * kết luận "đã gửi" là bịa bằng chứng — đường tiền dựa vào kết luận này.
 */

import { INVITE_SUCCESS_TOAST_PATTERNS } from "../../i18n-ui";
import { SELECTORS } from "../../selectors";

/** Text của toast xác nhận nếu đọc được, ngược lại `null`. */
export function findInviteSuccessToastText(root: ParentNode = document): string | null {
  for (const sel of SELECTORS.inviteSuccessToast) {
    for (const el of Array.from(root.querySelectorAll(sel))) {
      const text = (el.textContent ?? "").trim();
      if (!text) continue;
      const low = text.toLowerCase();
      if (INVITE_SUCCESS_TOAST_PATTERNS.some((p) => low.includes(p))) return text;
    }
  }
  return null;
}

/** Hộp thoại Mời thành viên còn mở hay không. */
export function isInviteDialogOpen(root: ParentNode = document): boolean {
  return !!root.querySelector('[role="dialog"]');
}
