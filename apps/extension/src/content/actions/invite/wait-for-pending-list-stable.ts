import { sleep } from "../../human";

/**
 * Poll DOM tới khi danh sách pending invite STABLE.
 *
 * Stable định nghĩa: row count (đếm text node email pattern) không tăng trong
 * 2 tick liên tiếp HOẶC tất cả `expectedEmails` đã xuất hiện trong DOM.
 *
 * Dùng SAU click tab "Lời mời" + TRƯỚC F5 — để đảm bảo ChatGPT đã fetch +
 * render xong pending list từ server. Nếu F5 ngắt giữa fetch, sau F5 ChatGPT
 * có thể serve cache → scrape miss.
 *
 * Không throw — chỉ best-effort poll. Hết timeout vẫn return (caller tự F5).
 */
export async function waitForPendingListStable(
  expectedEmails: string[],
  timeoutMs: number,
): Promise<void> {
  const expectedLower = expectedEmails.map((e) => e.toLowerCase());
  const start = Date.now();
  let lastCount = -1;
  let stableTicks = 0;
  // Regex full email — match text node chỉ chứa email
  const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

  while (Date.now() - start < timeoutMs) {
    await sleep(500);

    // Đếm email-format text nodes trong main content
    const main = document.querySelector("main, [role='main']") ?? document.body;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const found = new Set<string>();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue ?? "").trim();
      if (text.length > 0 && text.length <= 100 && EMAIL_RE.test(text)) {
        found.add(text.toLowerCase());
      }
    }
    const count = found.size;

    // Best case: tất cả email vừa mời đã thấy → return ngay
    const allExpectedFound = expectedLower.every((e) => found.has(e));
    if (allExpectedFound) {
      console.log(
        `[autogpt-invite-stable] tất cả ${expectedLower.length} email vừa mời đã thấy trong DOM (count=${count}) sau ${Date.now() - start}ms`,
      );
      return;
    }

    // Stable case: row count không tăng 2 tick liên tiếp
    if (count === lastCount && count > 0) {
      stableTicks += 1;
      if (stableTicks >= 2) {
        console.log(
          `[autogpt-invite-stable] DOM stable (count=${count}, ${stableTicks} ticks) sau ${Date.now() - start}ms — chưa thấy đủ email vừa mời nhưng list đã render xong`,
        );
        return;
      }
    } else {
      stableTicks = 0;
      lastCount = count;
    }
  }
  console.warn(
    `[autogpt-invite-stable] timeout ${timeoutMs}ms — list pending chưa stable (last count=${lastCount}). F5 vẫn tiến hành.`,
  );
}
