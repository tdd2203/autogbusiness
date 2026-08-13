import type { ScrapedMember } from "../../../shared/messages";
import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS } from "../../selectors";
import { scrapeAllRows } from "../sync/scrape-all-rows";

/**
 * Tìm ô search của tab "Lời mời đang chờ xử lý".
 *
 * QUAN TRỌNG (v0.8.7): tab này KHÔNG dùng chung ô "Lọc theo tên" của tab Người
 * dùng — placeholder là "Search for invites" và thường là input[type="text"]
 * (không phải type="search") → `memberFilterInput` trượt hết → trước đây fallback
 * scrape full (đọc cả trang + lật trang). Ưu tiên `pendingSearchInput` (match
 * placeholder/aria "Search"/"Tìm"/"搜索"), rồi mới fallback `memberFilterInput`.
 */
function findPendingFilterInput(): HTMLInputElement | null {
  return (
    querySelectorFirst<HTMLInputElement>(SELECTORS.pendingSearchInput) ??
    querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput)
  );
}

/** Clear ô lọc về rỗng để list pending về trạng thái đầy đủ sau verify. */
function clearFilter(input: HTMLInputElement): void {
  try {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    console.warn("[autogpt-invite-verify] clear filter pending failed:", e);
  }
}

/**
 * Gõ từng email vào ô tìm kiếm của tab "Lời mời đang chờ xử lý" → list rút còn
 * 0-1 row → đọc ngay. Caller PHẢI đã ở tab Lời mời.
 *
 * CHỈ dùng khi danh sách lời mời có ≥ 2 TRANG (user 2026-08-13): email còn thiếu
 * lúc đó có thể nằm ở trang sau nên quét DOM trang hiện tại không thấy được.
 * Danh sách 1 trang — trường hợp gần như luôn xảy ra — thì `scanPendingForEmails`
 * quét thẳng DOM là đủ và nhanh hơn (mỗi email gõ ở đây tốn ~1s + rủi ro ô lọc
 * đổi UI). Xem [`scan-pending-page.ts`](./scan-pending-page.ts).
 *
 * Trả về:
 *   - `ScrapedMember[]` (status="pending") của các email ĐÃ thấy (có thể rỗng).
 *   - `null` khi KHÔNG thấy ô tìm kiếm → caller giữ kết quả quét DOM / fallback.
 *
 * KHÔNG throw — mọi lỗi nội bộ (waitFor timeout) coi như "chưa thấy email đó".
 */
export async function searchPendingForEmails(
  emails: string[],
): Promise<ScrapedMember[] | null> {
  const input = findPendingFilterInput();
  if (!input) {
    console.warn(
      "[autogpt-invite-verify] KHÔNG thấy ô tìm kiếm tab Lời mời → null",
    );
    return null;
  }
  console.log(
    `[autogpt-invite-verify] ô tìm kiếm OK (placeholder="${input.placeholder}") — tìm ${emails.length} email`,
  );

  const matched = new Map<string, ScrapedMember>();
  for (const email of emails) {
    const lower = email.toLowerCase();
    // Gõ CHÍNH XÁC email đầy đủ 1 LẦN (user 2026-07-13: không gõ nửa rồi full = 2 lần).
    let hit: ScrapedMember | undefined;
    await humanType(input, email);
    await sleep(600); // chờ React Query / debounce filter
    try {
      hit = await waitFor(
        () => scrapeAllRows().find((m) => m.email.toLowerCase() === lower) ?? null,
        3000,
        200,
      );
    } catch {
      hit = undefined;
    }

    if (hit) {
      matched.set(lower, { ...hit, status: "pending" });
      console.log(`[autogpt-invite-verify] ✓ tìm thấy ${email}`);
    } else {
      console.log(`[autogpt-invite-verify] ✗ tìm không ra ${email}`);
    }
  }

  clearFilter(input);
  await sleep(200);

  console.log(
    `[autogpt-invite-verify] tìm kiếm: ${matched.size}/${emails.length} email thấy trong tab Lời mời`,
  );
  return Array.from(matched.values());
}
