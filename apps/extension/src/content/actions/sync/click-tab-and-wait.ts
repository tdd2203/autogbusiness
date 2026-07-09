import { humanClick, sleep } from "../../human";
import { findControlByKey } from "../../i18n-ui";

function findTabButton(
  controlKey: string,
  texts: readonly string[],
): HTMLElement | null {
  return findControlByKey(controlKey, texts, { page: "/admin/members" });
}

/**
 * Click tab + đợi DOM render. Trả true nếu tab đã ACTIVE, false nếu không.
 *
 * Trang /admin/members có 3 tab:
 *   - Người dùng (active members)         → URL không có ?tab=invites/requests
 *   - Lời mời đang chờ xử lý (pending invites)  → URL = ?tab=invites
 *   - Yêu cầu đang chờ xử lý (pending requests) → URL = ?tab=requests
 *
 * BUG (user report 2026-06-14): khi sync "Lời mời", tab KHÔNG đổi mà vẫn ở tab
 * Người dùng → scrape nhầm. Nguyên nhân: trước đây chỉ `humanClick` rồi `sleep`
 * cố định, KHÔNG kiểm chứng tab đã thực sự đổi (humanClick đôi khi không trigger
 * React onClick, hoặc match nhầm element). FIX: nếu truyền `verifyTabParam` (vd
 * "tab=invites") → sau click poll `location.search` tới khi khớp; chưa khớp thì
 * RETRY click; hết retry vẫn sai → return false (caller bỏ qua, KHÔNG scrape
 * nhầm). Không truyền `verifyTabParam` → giữ hành vi cũ (click + sleep).
 *
 * `waitForButtonMs` (mặc định 0 = giữ hành vi cũ): nếu > 0 và CHƯA thấy nút tab,
 * POLL chờ nút render tới `waitForButtonMs` rồi mới bỏ cuộc. Từ v0.8.13 mỗi action
 * mở tab /admin/members MỚI → content chạy NGAY khi trang vừa load → findTabButton
 * (tra 1 lần) có thể chạy TRƯỚC khi React render thanh tab → null. Gom bước "chờ
 * render" vào đây để MỌI caller chỉ cần truyền `waitForButtonMs`, KHỎI tự nhớ
 * `waitFor` thủ công ở từng action (trước đây lặp ở revoke + sync-member và đã 2
 * lần quên → regression UI_ELEMENT_NOT_FOUND).
 */
export async function clickTabAndWait(
  controlKey: string,
  tabTexts: readonly string[],
  postClickWaitMs = 1500,
  verifyTabParam?: string,
  waitForButtonMs = 0,
): Promise<boolean> {
  let btn = findTabButton(controlKey, tabTexts);
  if (!btn && waitForButtonMs > 0) {
    const deadline = Date.now() + waitForButtonMs;
    while (!btn && Date.now() < deadline) {
      await sleep(300);
      btn = findTabButton(controlKey, tabTexts);
    }
  }
  if (!btn) {
    console.warn(`[autogpt-sync] tab not found: ${tabTexts[0]}`);
    return false;
  }

  // Đã đúng tab sẵn (URL khớp) → khỏi click.
  if (verifyTabParam && location.search.includes(verifyTabParam)) {
    console.log(
      `[autogpt-sync] tab '${tabTexts[0]}' đã active sẵn (${location.search})`,
    );
    return true;
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    btn = attempt === 0 ? btn : findTabButton(controlKey, tabTexts);
    if (!btn) break;
    console.log(
      `[autogpt-sync] clicking tab: ${tabTexts[0]} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
    );
    await humanClick(btn);

    // Không cần verify URL → giữ hành vi cũ: sleep cố định rồi coi như xong.
    if (!verifyTabParam) {
      await sleep(postClickWaitMs);
      return true;
    }

    // Poll URL tới khi có param mong muốn (tab thực sự đổi).
    const deadline = Date.now() + Math.max(postClickWaitMs, 3000);
    while (Date.now() < deadline) {
      await sleep(250);
      if (location.search.includes(verifyTabParam)) {
        console.log(
          `[autogpt-sync] tab '${tabTexts[0]}' đã active (URL ${location.search})`,
        );
        await sleep(500); // chờ list render xong trước khi scrape
        return true;
      }
    }
    console.warn(
      `[autogpt-sync] click tab '${tabTexts[0]}' attempt ${attempt + 1}: URL chưa có '${verifyTabParam}' (search='${location.search}') — retry`,
    );
  }

  console.warn(
    `[autogpt-sync] KHÔNG đổi được sang tab '${tabTexts[0]}' (cần '${verifyTabParam}') sau ${MAX_ATTEMPTS} lần — bỏ qua, KHÔNG scrape nhầm tab`,
  );
  return false;
}

/** Export findTabButton để execute-sync.ts dùng (test tabReady predicate). */
export { findTabButton };
