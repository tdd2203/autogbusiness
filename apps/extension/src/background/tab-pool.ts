/**
 * BỂ TAB của extension — quy tắc tab do user chốt 2026-08-24.
 *
 *   "Đánh dấu các tab extension mở. Cho phép tối đa 2 tab để chạy lệnh, tức là
 *    2 lệnh có thể chạy đồng thời. Tab nào đã mở sẵn thì F5 làm mới dữ liệu
 *    trước khi chạy; action nào tự F5 rồi thì bỏ qua lần reload này."
 *
 * Hai điều bể tab này thay đổi so với `ensureAdminTab` cũ:
 *
 * 1. **Có ĐÁNH DẤU.** Trước đây runner tóm *bất kỳ* tab chatgpt.com/admin nào
 *    đang mở rồi F5 — kể cả tab user đang tự thao tác, đang mở dở một hộp thoại.
 *    Nay mỗi tab extension tự mở được ghi vào một Ô (slot 1 hoặc 2); chỉ tab
 *    trong ô mới bị đụng tới. Tab của user KHÔNG bao giờ bị F5 hay bị đóng.
 *
 * 2. **Hai ô = hai lệnh chạy song song.** Mỗi task giữ một ô suốt thời gian chạy
 *    rồi trả lại. Task thứ ba phải xếp hàng đợi ô trống.
 *
 * Sổ ghi ô để ở `chrome.storage.session`: sống qua các lần service-worker MV3
 * ngủ/dậy (mất khi đóng hẳn Chrome — lúc đó tab cũng không còn, đằng nào cũng
 * phải mở mới). Khoá giữ-ô là biến in-memory: khoá chỉ có nghĩa trong đúng một
 * lượt SW còn sống, SW chết là task cũng chết theo.
 */

const POOL_KEY = "autogpt.tabPool";

/** Số tab tối đa extension được mở để chạy lệnh = số lệnh chạy song song tối đa. */
export const TAB_SLOTS = [1, 2] as const;
export type TabSlot = (typeof TAB_SLOTS)[number];

type PoolMap = Partial<Record<TabSlot, number>>;

const LOG = "[autogpt-tabpool]";

/** Ô đang có task giữ. */
const leased = new Set<TabSlot>();
/** Hàng đợi task đang chờ ô trống (FIFO). */
const waiting: Array<(slot: TabSlot) => void> = [];

async function readPool(): Promise<PoolMap> {
  try {
    const obj = await chrome.storage.session.get(POOL_KEY);
    const raw = obj[POOL_KEY];
    return raw && typeof raw === "object" ? (raw as PoolMap) : {};
  } catch {
    return {};
  }
}

async function writePool(pool: PoolMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [POOL_KEY]: pool });
  } catch (e) {
    console.warn(`${LOG} ghi sổ ô lỗi (bỏ qua)`, e);
  }
}

/** Tab đang gán cho ô, hoặc null nếu ô trống / tab đã bị đóng. */
export async function getSlotTabId(slot: TabSlot): Promise<number | null> {
  const pool = await readPool();
  const tabId = pool[slot];
  if (typeof tabId !== "number") return null;
  try {
    await chrome.tabs.get(tabId);
    return tabId;
  } catch {
    // Tab đã đóng (user tự đóng, Chrome dọn) → xoá khỏi sổ.
    await setSlotTabId(slot, null);
    return null;
  }
}

export async function setSlotTabId(
  slot: TabSlot,
  tabId: number | null,
): Promise<void> {
  const pool = await readPool();
  if (tabId === null) delete pool[slot];
  else pool[slot] = tabId;
  await writePool(pool);
}

/**
 * Đổi tab của ô đang trỏ `oldTabId` sang `newTabId`.
 *
 * Dùng khi luồng khác thay tab GIỮA CHỪNG mà không đi qua `ensureAdminTab` —
 * cụ thể là Step 3 NUCLEAR của `ensureContentInjected` (đóng tab kẹt rồi mở tab
 * mới). Không cập nhật sổ thì ô còn trỏ tab đã đóng, còn tab mới nằm NGOÀI sổ:
 * lần chạy sau mở thêm tab nữa, mà idle-close (chỉ đóng tab trong sổ) không bao
 * giờ dọn tab mồ côi đó.
 *
 * Không thấy ô nào giữ `oldTabId` → không làm gì (tab đó không phải của mình).
 */
export async function replaceSlotTab(
  oldTabId: number,
  newTabId: number,
): Promise<void> {
  const pool = await readPool();
  for (const slot of TAB_SLOTS) {
    if (pool[slot] === oldTabId) {
      pool[slot] = newTabId;
      await writePool(pool);
      console.log(`${LOG} ô ${slot}: tab ${oldTabId} → ${newTabId} (tab cũ bị thay)`);
      return;
    }
  }
}

/** Mọi tab extension đang giữ (dùng cho idle-close: chỉ đóng tab của mình). */
export async function poolTabIds(): Promise<number[]> {
  const pool = await readPool();
  const ids: number[] = [];
  for (const slot of TAB_SLOTS) {
    const id = pool[slot];
    if (typeof id === "number") ids.push(id);
  }
  return ids;
}

export async function clearPool(): Promise<void> {
  await writePool({});
}

/**
 * Giữ một ô. Hết ô thì ĐỢI tới khi có task khác trả — không mở tab thứ 3.
 *
 * Luôn phải `releaseSlot` trong `finally`, kẻo ô kẹt vĩnh viễn và runner đứng im.
 */
export function acquireSlot(): Promise<TabSlot> {
  for (const slot of TAB_SLOTS) {
    if (!leased.has(slot)) {
      leased.add(slot);
      return Promise.resolve(slot);
    }
  }
  console.log(`${LOG} cả ${TAB_SLOTS.length} ô đều bận → xếp hàng đợi`);
  return new Promise<TabSlot>((resolve) => {
    waiting.push(resolve);
  });
}

export function releaseSlot(slot: TabSlot): void {
  const next = waiting.shift();
  if (next) {
    // Chuyển thẳng ô cho người đang đợi — KHÔNG nhả `leased` ở giữa, kẻo lượt
    // acquire khác chen vào và người xếp hàng trước bị bỏ đói.
    next(slot);
    return;
  }
  leased.delete(slot);
}

/** Có ô nào đang chạy task không (dùng để biết runner còn bận). */
export function anySlotLeased(): boolean {
  return leased.size > 0;
}
