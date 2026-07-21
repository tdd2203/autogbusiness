import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS } from "../../selectors";
import { findMemberRow } from "../member-row";
import { scrollScanForRow } from "../remove/locate-member";
import { findPaginationState } from "../sync/pagination";

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
  // 1 TRANG (không có thanh phân trang) → KHỎI search, quét thẳng vị trí (user
  // 2026-07-13). Ô "Search for invites" đôi khi lọc lỗi / row sau lọc render menu
  // thiếu mục "Thu hồi lời mời" → thao tác fail. List 1 trang thì scroll-scan phủ
  // hết & tin cậy hơn. Nhiều trang mới cần search để rút gọn.
  if (findPaginationState() === null) {
    console.log(
      "[autogpt-revoke] tab Lời mời chỉ 1 trang → quét vị trí trực tiếp (bỏ search)",
    );
    return scrollScanForRow(email);
  }
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

  // Gõ CHÍNH XÁC email ĐẦY ĐỦ 1 LẦN (user 2026-07-13: không gõ nửa rồi gõ full =
  // 2 lần tra, tốn thời gian). humanType tự clear input trước khi gõ.
  await humanType(input, email);
  await sleep(700); // chờ React Query / debounce filter
  try {
    const row = await waitFor(() => findMemberRow(email), 3000, 200);
    if (row) {
      console.log(`[autogpt-revoke] ✓ search thấy ${email}`);
      return row;
    }
  } catch {
    // không ra row → email thật sự không phải pending.
  }

  // Ô search hoạt động nhưng KHÔNG ra row → email thật sự không phải pending.
  console.log(`[autogpt-revoke] ✗ search không thấy ${email} trong tab Lời mời`);
  clearPendingSearch(input);
  await sleep(200);
  return null;
}
