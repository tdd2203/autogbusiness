import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS } from "../../selectors";
import { findMemberRow } from "../member-row";

/**
 * Tìm input "Lọc theo tên" trên tab Người dùng /admin/members.
 * UI 2026 có ô search filter list — dùng để zoom thẳng vào row cần xoá thay
 * vì scroll qua hết list (failmode khi list > 50 row).
 */
function findMemberFilterInput(): HTMLInputElement | null {
  return querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput);
}

/**
 * Filter list xuống chỉ còn row khớp email, rồi đợi DOM render xong.
 * Trả về row tìm được, hoặc null nếu hết timeout vẫn không có row khớp.
 *
 * Nếu không tìm được filter input → fallback scroll-find theo cách cũ
 * (findMemberRow trực tiếp trên DOM hiện tại).
 */
export async function filterAndFindRow(email: string): Promise<HTMLElement | null> {
  const input = findMemberFilterInput();
  if (!input) {
    console.warn("[autogpt-remove] không tìm được filter input — fallback scroll-find");
    return findMemberRow(email);
  }

  // Search bằng phần local-part trước @ — ChatGPT filter theo cả tên + email,
  // dùng prefix giúp tránh giới hạn ký tự nếu input có maxlength.
  const needle = email.includes("@") ? email.split("@")[0] : email;
  await humanType(input, needle);
  // Đợi React Query / debounce filter (ChatGPT thường debounce 200-400ms).
  await sleep(600);

  try {
    return await waitFor(() => findMemberRow(email), 4000, 200);
  } catch {
    return null;
  }
}

/**
 * Clear filter input để list về trạng thái ban đầu sau khi xoá xong.
 * Best-effort — không throw nếu input đã unmount.
 */
export async function clearMemberFilter(): Promise<void> {
  try {
    const input = findMemberFilterInput();
    if (!input) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    console.warn("[autogpt-remove] clear filter failed:", e);
  }
}
