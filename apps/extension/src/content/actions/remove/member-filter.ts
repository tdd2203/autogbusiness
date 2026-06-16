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
/** Đếm số row member đang hiển thị (debug). */
function visibleRowCount(): number {
  return document.querySelectorAll(
    'tr[data-testid^="member-row"], table tbody tr, [role="row"]',
  ).length;
}

export async function filterAndFindRow(email: string): Promise<HTMLElement | null> {
  const input = findMemberFilterInput();
  if (!input) {
    console.warn("[autogpt-locate] KHÔNG tìm được ô lọc — fallback scroll-find");
    return findMemberRow(email);
  }
  console.log(
    `[autogpt-locate] ô lọc OK (placeholder="${input.placeholder}"), tìm ${email}`,
  );

  // Thử nhiều needle: local-part (tránh maxlength) RỒI full email (giống user
  // gõ tay). ChatGPT "Filter by name" match cả tên + email; needle nào ra row
  // thì dừng. humanType tự clear input trước khi gõ nên gọi lại an toàn.
  const local = email.includes("@") ? email.split("@")[0] : email;
  const needles = local === email ? [local] : [local, email];

  for (const needle of needles) {
    await humanType(input, needle);
    await sleep(700); // chờ React Query / debounce filter
    console.log(
      `[autogpt-locate] đã lọc "${needle}" → ${visibleRowCount()} row hiển thị`,
    );
    try {
      const row = await waitFor(() => findMemberRow(email), 4000, 200);
      if (row) {
        console.log(`[autogpt-locate] ✓ thấy row sau khi lọc "${needle}"`);
        return row;
      }
    } catch {
      console.warn(`[autogpt-locate] lọc "${needle}" chưa ra row, thử cách khác`);
    }
  }
  return null;
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
