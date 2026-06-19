import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS } from "../../selectors";
import { findMemberRow } from "../member-row";
import { scrollScanForRow } from "../remove/locate-member";

/**
 * Ô "Search for invites" trên tab "Lời mời đang chờ xử lý". Thử
 * `pendingSearchInput` (placeholder "Search for invites", thường type=text)
 * trước, rồi fallback `memberFilterInput`.
 */
function findPendingSearchInput(): HTMLInputElement | null {
  return (
    querySelectorFirst<HTMLInputElement>(SELECTORS.pendingSearchInput) ??
    querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput)
  );
}

/** Clear ô search về rỗng để list pending về đầy đủ giữa các email. */
function clearPendingSearch(input: HTMLInputElement): void {
  try {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    console.warn("[autogpt-revoke] clear pending search failed:", e);
  }
}

/**
 * Định vị row của 1 pending invite trên tab "Lời mời đang chờ xử lý".
 *
 * FAST PATH (v0.8.8): gõ email vào ô "Search for invites" → list rút còn 0-1 row
 * → đọc ngay. Đây mới là cách ĐÚNG: trước đây revoke chỉ `scrollScanForRow`
 * (cuộn list virtualized) nên dễ MISS row → kết luận nhầm `notInPending` →
 * fallback nhầm sang tab "Người dùng" (xem bug oewi@gmail.com 2026-06-17:
 * invite OK rồi revoke 27s sau lại báo "không có trên tab Lời mời").
 *
 * Fallback scroll-scan CHỈ khi không tìm thấy ô search (UI đổi) — để không
 * regress workspace cũ chưa có ô này.
 *
 * Trả row, hoặc null nếu email thật sự KHÔNG có trên tab Lời mời.
 */
export async function locatePendingRow(
  email: string,
): Promise<HTMLElement | null> {
  const input = findPendingSearchInput();
  if (!input) {
    console.warn(
      "[autogpt-revoke] KHÔNG thấy ô 'Search for invites' → fallback scroll-scan",
    );
    return scrollScanForRow(email);
  }
  console.log(
    `[autogpt-revoke] ô search OK (placeholder="${input.placeholder}") — tìm ${email}`,
  );

  // local-part trước (tránh maxlength), rồi full email — needle nào ra row thì
  // dừng. humanType tự clear input trước khi gõ nên gọi lại an toàn.
  const local = email.includes("@") ? email.split("@")[0] : email;
  const needles = local === email ? [local] : [local, email];

  for (const needle of needles) {
    await humanType(input, needle);
    await sleep(700); // chờ React Query / debounce filter
    try {
      const row = await waitFor(() => findMemberRow(email), 3000, 200);
      if (row) {
        console.log(`[autogpt-revoke] ✓ search thấy ${email}`);
        return row;
      }
    } catch {
      // needle này chưa ra row → thử needle kế.
    }
  }

  // Ô search hoạt động nhưng KHÔNG ra row → email thật sự không phải pending.
  console.log(`[autogpt-revoke] ✗ search không thấy ${email} trong tab Lời mời`);
  clearPendingSearch(input);
  await sleep(200);
  return null;
}
