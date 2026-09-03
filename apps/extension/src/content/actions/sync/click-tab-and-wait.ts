import { humanClick, sleep } from "../../human";
import { findControlByKey } from "../../i18n-ui";

function findTabButton(
  controlKey: string,
  texts: readonly string[],
): HTMLElement | null {
  return findControlByKey(controlKey, texts, { page: "/admin/members" });
}

/**
 * Tab "Người dùng" là tab MẶC ĐỊNH của /admin/members — URL của nó KHÔNG mang
 * `?tab=`. Truyền hằng này vào `verifyTabParam` để ĐÒI KIỂM CHỨNG đã về đúng tab
 * đó, thay vì tin vào một cú click không ai soát lại.
 *
 * VÌ SAO CẦN (ca thật 28/8/2026, workspace GPT1): `SYNC_MEMBERS_BATCH` click tab
 * "Người dùng" rồi ngủ 800ms là coi như xong. Tab admin được tái dùng nên URL còn
 * `?tab=invites` do lệnh mời trước để lại; cú click rơi vào lúc React chưa gắn
 * handler ⇒ vẫn đứng ở tab "Lời mời đang chờ xử lý". Ô lọc ở đó tìm THẤY email
 * đang chờ ⇒ báo "đã tham gia" ⇒ backend nâng pending → active cho người chưa hề
 * vào team. Dashboard đếm 244 trong khi ChatGPT chỉ có 243.
 */
export const DEFAULT_TAB_VERIFY = "\u0000default-tab";

const WRONG_SUB_TAB_RE = /[?&]tab=(invites|requests)/;

/** Đang đứng ở tab "Lời mời"/"Yêu cầu" (đọc theo URL) hay không. */
export function onWrongSubTab(): boolean {
  return WRONG_SUB_TAB_RE.test(location.search);
}

/**
 * Chốt "DANH SÁCH đã đổi", đi kèm chốt "URL đã đổi".
 *
 * VÌ SAO CẦN (auto-sync 25/8 → 3/9/2026): URL đổi sang `?tab=invites` NGAY khi
 * bấm, nhưng bảng bên dưới đổi sau — và bảng cũ còn nằm lại trong DOM. Chỉ soi
 * URL thì mẻ quét lao vào ngay và đọc trúng danh sách của tab trước, rồi gắn
 * nhãn theo tab mới. Cửa này bắt danh sách ĐANG HIỆN phải khác trước lúc bấm;
 * không khác trong hạn thì thà bỏ tab đó còn hơn quét nhầm.
 */
export type ListSwapCheck = {
  /** Chữ ký danh sách đang hiện (vd vài email đầu). "" = chưa có dòng nào. */
  signature: () => string;
  /** Hạn chờ danh sách đổi, mặc định 6s. */
  timeoutMs?: number;
};

/**
 * Danh sách đã đổi hay chưa. Tách riêng để test được mà không cần DOM.
 *
 * Chữ ký RỖNG cũng là một thay đổi hợp lệ: tab "Lời mời" không còn lời mời nào
 * thì bảng trống — đó là kết quả thật, không phải lỗi.
 */
export function listSwapped(before: string, after: string): boolean {
  return after !== before;
}

/** Poll tới khi `listSwapped` hoặc hết hạn. */
async function waitForListSwap(
  check: ListSwapCheck,
  sigBeforeClick: string,
  tabLabel: string,
): Promise<boolean> {
  const deadline = Date.now() + (check.timeoutMs ?? 6000);
  while (Date.now() < deadline) {
    if (listSwapped(sigBeforeClick, check.signature())) return true;
    await sleep(250);
  }
  console.warn(
    `[autogpt-sync] tab '${tabLabel}': URL đã đổi nhưng DANH SÁCH y nguyên sau ` +
      `${(check.timeoutMs ?? 6000) / 1000}s — bỏ tab này, KHÔNG gắn nhãn cho danh sách tab cũ`,
  );
  return false;
}

/** Tên đọc được của mốc kiểm chứng, để ghi nhật ký. */
function verifyLabel(verifyTabParam: string): string {
  return verifyTabParam === DEFAULT_TAB_VERIFY
    ? "URL sạch (không ?tab=invites/requests)"
    : verifyTabParam;
}

/** URL hiện tại đã khớp tab cần tới chưa. */
function tabParamMatches(verifyTabParam: string): boolean {
  return verifyTabParam === DEFAULT_TAB_VERIFY
    ? !onWrongSubTab()
    : location.search.includes(verifyTabParam);
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
  listSwap?: ListSwapCheck,
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
  if (verifyTabParam && tabParamMatches(verifyTabParam)) {
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
    const sigBeforeClick = listSwap ? listSwap.signature() : "";
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
      if (tabParamMatches(verifyTabParam)) {
        console.log(
          `[autogpt-sync] tab '${tabTexts[0]}' đã active (URL ${location.search})`,
        );
        await sleep(500); // chờ list render xong trước khi scrape
        if (!listSwap) return true;
        if (await waitForListSwap(listSwap, sigBeforeClick, tabTexts[0])) {
          return true;
        }
        break; // URL đúng nhưng danh sách chưa đổi → không retry click nữa
      }
    }
    console.warn(
      `[autogpt-sync] click tab '${tabTexts[0]}' attempt ${attempt + 1}: URL chưa khớp '${verifyLabel(verifyTabParam)}' (search='${location.search}') — retry`,
    );
  }

  console.warn(
    `[autogpt-sync] KHÔNG đổi được sang tab '${tabTexts[0]}' (cần '${verifyLabel(verifyTabParam ?? "")}') sau ${MAX_ATTEMPTS} lần — bỏ qua, KHÔNG scrape nhầm tab`,
  );
  return false;
}

/** Export findTabButton để execute-sync.ts dùng (test tabReady predicate). */
export { findTabButton };
