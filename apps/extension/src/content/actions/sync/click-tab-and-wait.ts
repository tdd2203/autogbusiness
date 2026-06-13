import { humanClick, sleep } from "../../human";
import { findControlByKey } from "../../i18n-ui";

function findTabButton(
  controlKey: string,
  texts: readonly string[],
): HTMLElement | null {
  return findControlByKey(controlKey, texts, { page: "/admin/members" });
}

/**
 * Click tab + đợi DOM render. Trả true nếu tab tồn tại, false nếu không.
 *
 * Trang /admin/members có 3 tab:
 *   - Người dùng (active members)
 *   - Lời mời đang chờ xử lý (pending invites)
 *   - Yêu cầu đang chờ xử lý (pending requests)
 *
 * Tab buttons là plain <button> Tailwind, không có role="tab" / aria-selected.
 * → Detect "active" qua presence của border class hoặc text color, nhưng đơn giản
 *   nhất là cứ click rồi đợi.
 */
export async function clickTabAndWait(
  controlKey: string,
  tabTexts: readonly string[],
  postClickWaitMs = 1500,
): Promise<boolean> {
  const btn = findTabButton(controlKey, tabTexts);
  if (!btn) {
    console.warn(`[autogpt-sync] tab not found: ${tabTexts[0]}`);
    return false;
  }
  console.log(`[autogpt-sync] clicking tab: ${tabTexts[0]}`);
  await humanClick(btn);
  await sleep(postClickWaitMs);
  return true;
}

/** Export findTabButton để execute-sync.ts dùng (test tabReady predicate). */
export { findTabButton };
