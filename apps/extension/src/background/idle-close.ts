/**
 * Tự động ĐÓNG tab chatgpt.com/admin do EXTENSION mở khi tab đó không được dùng
 * tới trong **30 phút** (user chốt 2026-08-24).
 *
 * "Không dùng đến" nghĩa là, TÍNH RIÊNG TỪNG TAB:
 *   - Extension KHÔNG chạy task nào trên tab đó (`markAdminTabActivity` không
 *     được gọi cho tab đó), VÀ
 *   - User KHÔNG mở/xem tab đó (`tab.active=false` và `tab.lastAccessed` cũ).
 *
 * **Tính riêng từng tab** là chỗ khác bản trước (2026-07-27). Bể tab có 2 ô
 * (xem `tab-pool.ts`); bản cũ dùng MỘT đồng hồ chung cho cả hai, mà đồng hồ đó
 * reset mỗi khi có bất kỳ task nào chạy. Hệ quả: ô 2 chỉ được mở trong một đợt
 * hai lệnh song song rồi nằm không, nhưng hễ ô 1 còn việc đều đều là ô 2 KHÔNG
 * BAO GIỜ bị đóng. Nay mỗi tab một đồng hồ: tab nào để không 30 phút thì tab đó
 * đóng, tab kia đang có việc vẫn giữ nguyên.
 *
 * **Ngưỡng cố định 30 phút** cũng khác bản trước: trước đây mỗi phiên idle bốc
 * một ngưỡng ngẫu nhiên 10→60 phút cho hợp triết lý "thao tác như người thật".
 * User chốt lại con số cụ thể, và đóng tab là việc của TRÌNH DUYỆT (không phải
 * thao tác gửi tới ChatGPT) nên nhịp đều không lộ gì ra phía server.
 *
 * Cơ chế: alarm ~1 phút/lần (min cho phép ở prod Chrome). Mỗi tick:
 *   1. Đọc sổ ô → chỉ xét tab CỦA MÌNH. Tab admin user tự mở không bao giờ bị
 *      đụng tới. Sổ rỗng → xoá state, thôi.
 *   2. Với từng tab: mốc hoạt động = max(lần cuối extension dùng tab đó,
 *      `tab.lastAccessed`, now-nếu-tab-đang-active).
 *   3. Runner đang chạy task → KHÔNG đóng gì (tránh cắt ngang).
 *   4. Tab nào idle ≥ 30 phút → đóng tab đó + xoá nó khỏi sổ ô.
 */

import { forgetTab, poolEntries } from "./tab-pool";

const IDLE_CLOSE_ALARM = "autogpt-idle-close";
const STATE_KEY = "autogpt.adminIdle";

const CHATGPT_TAB_MATCH = "https://chatgpt.com/admin/*";

/** Ngưỡng để không trước khi tự đóng — user chốt 30 phút (2026-08-24). */
export const IDLE_CLOSE_MS = 30 * 60 * 1000;

/** Mốc hoạt động gần nhất của từng tab: `{ [tabId]: epoch ms }`. */
export type IdleState = Record<number, number>;

/** Thứ duy nhất hàm quyết định cần biết về một tab. */
export type TabIdleInfo = {
  tabId: number;
  active: boolean;
  lastAccessed?: number;
};

export type IdleDecision = {
  /** State ghi lại cho tick sau (đã bỏ tab không còn tồn tại / vừa bị đóng). */
  nextState: IdleState;
  /** Tab để không quá ngưỡng → cần đóng. */
  closeIds: number[];
};

/**
 * Runner đang chạy task hay không. Bận thì KHÔNG đóng tab nào (dù đã quá ngưỡng)
 * để không cắt ngang thao tác đang diễn ra. In-memory là đủ vì `runUntilIdle`
 * chạy trong cùng service-worker lifetime; SW bị kill giữa chừng thì task cũng
 * chết, không còn gì để bảo vệ.
 */
let runnerBusy = false;

export function setRunnerBusy(busy: boolean): void {
  runnerBusy = busy;
}

async function getState(): Promise<IdleState> {
  try {
    const obj = await chrome.storage.local.get(STATE_KEY);
    const raw = obj[STATE_KEY];
    // Bản cũ lưu `{lastActivity, threshold}` — hình dạng khác hẳn. Gặp thì bỏ,
    // tick này coi như mới thấy tab lần đầu (đếm lại từ bây giờ).
    if (!raw || typeof raw !== "object" || "lastActivity" in raw) return {};
    return raw as IdleState;
  } catch {
    return {};
  }
}

async function setState(state: IdleState): Promise<void> {
  try {
    await chrome.storage.local.set({ [STATE_KEY]: state });
  } catch (e) {
    console.warn("[autogpt-idle] ghi state lỗi (bỏ qua)", e);
  }
}

async function clearState(): Promise<void> {
  try {
    await chrome.storage.local.remove(STATE_KEY);
  } catch {
    // Không có state cũng chẳng sao — tick sau đọc ra rỗng.
  }
}

/**
 * Đánh dấu extension VỪA dùng MỘT tab admin cụ thể. Gọi mỗi lần runner lấy tab
 * của một ô ra dùng (`ensureAdminTab`) — nhờ vậy đồng hồ của từng tab mới đúng
 * là "tab NÀY lần cuối được dùng lúc nào".
 */
export async function markAdminTabActivity(tabId: number): Promise<void> {
  const state = await getState();
  state[tabId] = Date.now();
  await setState(state);
}

/** Đánh dấu MỌI tab trong sổ vừa được dùng (không rõ tab nào). */
export async function markAdminActivity(): Promise<void> {
  const entries = await poolEntries();
  if (entries.length === 0) return;
  const state = await getState();
  const now = Date.now();
  for (const { tabId } of entries) state[tabId] = now;
  await setState(state);
}

export function setupIdleCloseAlarm(): void {
  chrome.alarms.create(IDLE_CLOSE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });
}

export function isIdleCloseAlarm(name: string): boolean {
  return name === IDLE_CLOSE_ALARM;
}

/**
 * Phần QUYẾT ĐỊNH, tách riêng để test được (không đụng chrome.*).
 *
 * Tab mới thấy lần đầu mà không có mốc nào (state trống, `lastAccessed` rỗng) →
 * tính mốc là `now`: thà giữ thêm 30 phút còn hơn đóng nhầm tab vừa mở.
 */
export function decideIdleClose(
  tabs: TabIdleInfo[],
  state: IdleState,
  now: number,
  opts: { busy: boolean; idleMs?: number },
): IdleDecision {
  const idleMs = opts.idleMs ?? IDLE_CLOSE_MS;
  const nextState: IdleState = {};
  const closeIds: number[] = [];

  for (const tab of tabs) {
    const known = state[tab.tabId] ?? 0;
    const seen = tab.active ? now : tab.lastAccessed ?? 0;
    const activity = Math.max(known, seen) || now;

    if (!opts.busy && now - activity >= idleMs) {
      closeIds.push(tab.tabId);
      continue; // đóng rồi thì không giữ mốc của nó nữa
    }
    nextState[tab.tabId] = activity;
  }

  return { nextState, closeIds };
}

/**
 * Xử lý 1 tick alarm: tab nào của mình để không quá ngưỡng thì đóng tab đó.
 * Không throw ra ngoài (best-effort) — lỗi query/close chỉ log.
 */
export async function handleIdleCloseTick(): Promise<void> {
  // CHỈ xét tab do EXTENSION mở (nằm trong bể ô — xem `tab-pool.ts`). Tab admin
  // do USER tự mở không phải của mình: bản đầu tiên của tick này đóng sạch mọi
  // tab chatgpt.com/admin, kể cả tab user đang để dở.
  let tabs: TabIdleInfo[];
  try {
    const entries = await poolEntries();
    if (entries.length === 0) {
      await clearState();
      return;
    }
    const ownIds = entries.map((e) => e.tabId);
    const all = await chrome.tabs.query({ url: CHATGPT_TAB_MATCH });
    tabs = all
      .filter((t) => t.id !== undefined && ownIds.includes(t.id))
      .map((t) => ({
        tabId: t.id as number,
        active: t.active === true,
        lastAccessed: t.lastAccessed,
      }));
  } catch (e) {
    console.warn("[autogpt-idle] query tab admin lỗi (bỏ qua)", e);
    return;
  }
  if (tabs.length === 0) {
    await clearState();
    return;
  }

  const now = Date.now();
  const { nextState, closeIds } = decideIdleClose(tabs, await getState(), now, {
    busy: runnerBusy,
  });
  await setState(nextState);
  if (closeIds.length === 0) return;

  console.log(
    `[autogpt-idle] ${closeIds.length} tab admin để không ≥ ${IDLE_CLOSE_MS / 60000} phút — tự đóng: ${closeIds.join(",")}`,
  );
  for (const id of closeIds) {
    try {
      await chrome.tabs.remove(id);
    } catch (e) {
      console.warn(`[autogpt-idle] đóng tab ${id} lỗi (bỏ qua)`, e);
    }
    // Đóng tab rồi thì ô phải trống theo, kẻo lần chạy sau còn trỏ vào tab chết.
    await forgetTab(id);
  }
}
