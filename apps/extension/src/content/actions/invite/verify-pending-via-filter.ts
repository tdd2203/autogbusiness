import type { ScrapedMember } from "../../../shared/messages";
import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS, TEXT_FALLBACKS } from "../../selectors";
import { clickTabAndWait } from "../sync/click-tab-and-wait";
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
 * VERIFY pending invite bằng Ô LỌC thay vì scrape TOÀN BỘ list.
 *
 * Lý do (user 2026-06-18): sau khi mời thành công + F5, trang "Lời mời đang chờ
 * xử lý" có thể có rất nhiều email + nhiều trang. Scrape full (scroll hết list +
 * lật hết trang qua `scrapeCurrentTab`, cap 60s) là thừa khi ta CHỈ cần xác nhận
 * vài email vừa mời. Trang này có sẵn ô "Lọc theo tên" → gõ thẳng từng email →
 * list rút còn 0-1 row → đọc ngay. KHÔNG đọc email khác, KHÔNG chuyển trang.
 * Nhanh hơn nhiều lần (giống fast-path `filterAndFindRow` của REMOVE/CHANGE_ROLE).
 *
 * Trả về:
 *   - `ScrapedMember[]` (status="pending") của các email vừa mời ĐÃ thấy. Mảng
 *     rỗng = list render OK nhưng chưa thấy email nào (caller tự F5 retry).
 *   - `null` khi KHÔNG dùng được ô lọc (không vào được tab / không thấy input)
 *     → caller fallback sang scrape full như cũ.
 *
 * KHÔNG throw — mọi lỗi nội bộ (waitFor timeout) coi như "chưa thấy email đó".
 */
export async function verifyPendingViaFilter(
  emails: string[],
): Promise<ScrapedMember[] | null> {
  // Bảo đảm đang ở tab "Lời mời đang chờ xử lý". Page vừa F5 → KHÔNG bounce tab,
  // click trực tiếp (clickTabAndWait tự bỏ qua nếu đã active).
  const onTab = await clickTabAndWait(
    "tab_pending_invites",
    TEXT_FALLBACKS.tabPendingInvites,
    1500,
  );
  if (!onTab) {
    console.warn(
      "[autogpt-invite-verify] không vào được tab Lời mời → null (fallback scrape full)",
    );
    return null;
  }

  const input = findPendingFilterInput();
  if (!input) {
    console.warn(
      "[autogpt-invite-verify] KHÔNG thấy ô lọc tab Lời mời → null (fallback scrape full)",
    );
    return null;
  }
  console.log(
    `[autogpt-invite-verify] ô lọc OK (placeholder="${input.placeholder}") — verify ${emails.length} email bằng filter`,
  );

  const matched = new Map<string, ScrapedMember>();
  for (const email of emails) {
    const lower = email.toLowerCase();
    // local-part trước (tránh maxlength input), rồi full email — needle nào ra
    // row thì dừng. humanType tự clear input trước khi gõ nên gọi lại an toàn.
    const local = email.includes("@") ? email.split("@")[0] : email;
    const needles = local === email ? [local] : [local, email];

    let hit: ScrapedMember | undefined;
    for (const needle of needles) {
      await humanType(input, needle);
      await sleep(600); // chờ React Query / debounce filter
      try {
        hit = await waitFor(
          () =>
            scrapeAllRows().find((m) => m.email.toLowerCase() === lower) ?? null,
          3000,
          200,
        );
      } catch {
        hit = undefined;
      }
      if (hit) break;
    }

    if (hit) {
      matched.set(lower, { ...hit, status: "pending" });
      console.log(`[autogpt-invite-verify] ✓ lọc thấy ${email}`);
    } else {
      console.log(`[autogpt-invite-verify] ✗ lọc chưa thấy ${email}`);
    }
  }

  clearFilter(input);
  await sleep(200);

  console.log(
    `[autogpt-invite-verify] filter verify: ${matched.size}/${emails.length} email thấy trong tab Lời mời`,
  );
  return Array.from(matched.values());
}
