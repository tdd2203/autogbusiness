/**
 * SỔ TAB DO EXTENSION MỞ + TRẦN 3 TAB (user chốt 29/8/2026: "cần phải tự động
 * đóng các tab thừa để nó không được vượt quá 3 tab do extension bật lên").
 *
 * VÌ SAO CẦN (trước bản này): bể tab admin đã tự giới hạn 2 ô (`tab-pool.ts`),
 * nhưng đó KHÔNG phải toàn bộ số tab extension mở ra:
 *
 *   - Chuỗi thanh toán mở tab Stripe rồi tab Link checkout và **không đóng cái
 *     nào** — mỗi lần mua suất là hai tab nằm lại vĩnh viễn.
 *   - Bước NUCLEAR của `ensureContentInjected` đóng tab kẹt rồi mở tab mới; cập
 *     nhật sổ ô hụt một nhịp là tab cũ thành mồ côi, mà idle-close chỉ đụng tới
 *     tab CÓ TRONG SỔ nên không ai dọn nó.
 *
 * Sổ này ghi MỌI tab extension mở, để trần 3 tab có cái mà đếm và dọn.
 *
 * ĐIỀU KHÔNG BAO GIỜ ĐƯỢC LÀM: đụng vào tab của USER. Sổ chỉ có tab do chính
 * extension mở, nên tab admin user tự mở không nằm trong tầm với — đúng nguyên
 * tắc đã có từ `tab-pool.ts` và `idle-close.ts`.
 *
 * Sổ để ở `chrome.storage.session`: sống qua các lần service-worker MV3 ngủ/dậy,
 * mất khi đóng hẳn Chrome — lúc đó id tab cũng đã đổi hết, có giữ cũng vô nghĩa.
 */

import { poolTabIds, leasedTabIds, forgetTab } from "./tab-pool";

const KEY = "autogpt.openedTabs";
const LOG = "[autogpt-tabcap]";

/** Trần số tab extension được phép mở cùng lúc (user chốt 29/8/2026). */
export const MAX_OPEN_TABS = 3;

/**
 * Tab vừa mở dưới ngưỡng này KHÔNG bị coi là thừa. Giữa lúc `tabs.create` trả về
 * và lúc runner ghi tab vào sổ ô có một khoảng trống — quét đúng khoảng đó là
 * đóng ngay cái tab lệnh đang chuẩn bị dùng.
 */
export const NEW_TAB_GRACE_MS = 60_000;

/**
 * Trần thời gian một tab được đánh dấu "đang có lệnh dùng". Cờ bận nằm ở session
 * storage nên nó SỐNG SÓT qua cú service-worker bị khai tử giữa chừng — lúc đó
 * lệnh đã chết mà cờ còn, tab thành bất tử. Cho cờ tự hết hạn là đường lui.
 */
export const BUSY_TTL_MS = 10 * 60 * 1000;

/**
 * Tab của chuỗi thanh toán chỉ được dọn sau ngần này KỂ TỪ LÚC chuỗi trả quyền.
 *
 * Không dọn ngay: bước cuối của Link checkout có thể đòi OTP/3DS và
 * `link-checkout.ts` cố ý dừng lại cho admin tự xác minh (xem nhánh
 * "admin verify"). Đóng tab lúc đó là cắt ngang một giao dịch đã bắt đầu tiêu
 * tiền — hỏng nặng hơn nhiều so với để thừa một tab thêm mười phút.
 */
export const PAYMENT_COOLDOWN_MS = 10 * 60 * 1000;

/** User vừa nhìn tab trong ngần này thì không đóng (dù nó thuộc diện dọn). */
export const USER_LOOK_MS = 5 * 60 * 1000;

export type OpenedTabKind = "admin" | "payment";

type Entry = { at: number; kind: OpenedTabKind; busyUntil: number };
type Book = Record<string, Entry>;

async function readBook(): Promise<Book> {
  try {
    const obj = await chrome.storage.session.get(KEY);
    const raw = obj[KEY];
    return raw && typeof raw === "object" ? (raw as Book) : {};
  } catch {
    return {};
  }
}

async function writeBook(book: Book): Promise<void> {
  try {
    await chrome.storage.session.set({ [KEY]: book });
  } catch (e) {
    console.warn(`${LOG} ghi sổ tab lỗi (bỏ qua)`, e);
  }
}

/**
 * Ghi một tab vào sổ.
 *
 * `busyMs > 0` = đang có lệnh dùng tab này, KHÔNG được đóng cho tới khi hết hạn
 * hoặc `releaseOpenedTab`.
 */
export async function trackOpenedTab(
  tabId: number,
  kind: OpenedTabKind,
  busyMs = 0,
): Promise<void> {
  const book = await readBook();
  const now = Date.now();
  book[String(tabId)] = {
    at: book[String(tabId)]?.at ?? now,
    kind,
    busyUntil: busyMs > 0 ? now + Math.min(busyMs, BUSY_TTL_MS) : 0,
  };
  await writeBook(book);
}

/** Lệnh đã dùng xong tab — từ đây nó vào diện có thể dọn. */
export async function releaseOpenedTab(tabId: number): Promise<void> {
  const book = await readBook();
  const e = book[String(tabId)];
  if (!e) return;
  e.busyUntil = Date.now();
  await writeBook(book);
}

/** Xoá tab khỏi sổ (đã đóng). */
export async function forgetOpenedTab(tabId: number): Promise<void> {
  const book = await readBook();
  if (!(String(tabId) in book)) return;
  delete book[String(tabId)];
  await writeBook(book);
}

/** Mở tab MỚI và ghi ngay vào sổ. Mọi chỗ mở tab của extension phải đi qua đây. */
export async function createTrackedTab(
  props: chrome.tabs.CreateProperties,
  kind: OpenedTabKind,
  busyMs = BUSY_TTL_MS,
): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create(props);
  if (tab.id !== undefined) {
    await trackOpenedTab(tab.id, kind, busyMs);
    // Quét NGAY sau khi mở: tab vừa mở được `NEW_TAB_GRACE_MS` che nên lượt quét
    // này chỉ đụng tới tab thừa có sẵn từ trước.
    void enforceTabCap();
  }
  return tab;
}

/** Một tab trong sổ, kèm mọi thứ vòng quyết định cần biết. */
export type SweepTab = {
  tabId: number;
  kind: OpenedTabKind;
  /** Lúc extension mở tab. */
  at: number;
  /** Đang có lệnh dùng tới mốc này (0 = rảnh). */
  busyUntil: number;
  /** Là tab của bể tab admin. */
  inPool: boolean;
  /** Ô của nó đang có task giữ. */
  leased: boolean;
  /** User đang xem tab này. */
  active: boolean;
  /** Lần cuối user xem tab (Chrome cấp). */
  lastAccessed: number;
};

export type SweepDecision = {
  closeIds: number[];
  /** Vẫn quá trần sau khi đã chọn (mọi tab còn lại đều đang được dùng). */
  stillOver: boolean;
};

/**
 * CHỌN tab để đóng — tách khỏi `chrome.*` để khoá bằng test.
 *
 * Thứ tự ưu tiên đóng, từ rác nhất tới tiếc nhất:
 *
 *   1. Tab admin MỒ CÔI (không còn trong bể tab) — không ai dùng tới nữa.
 *   2. Tab của chuỗi thanh toán đã qua thời gian nguội — việc xong từ lâu.
 *   3. Tab admin trong bể nhưng KHÔNG có lệnh nào giữ — đóng đi thì lượt sau
 *      runner mở lại, chỉ tốn một lần tải trang.
 *
 * (1) và (2) là RÁC: đóng kể cả khi chưa chạm trần. (3) chỉ đóng đúng số cần để
 * về trần.
 *
 * KHÔNG BAO GIỜ đóng: tab đang có lệnh giữ (ô đang thuê / cờ bận còn hạn), tab
 * vừa mở chưa qua `NEW_TAB_GRACE_MS`, tab user đang xem hoặc vừa xem.
 */
export function chooseTabsToClose(
  tabs: SweepTab[],
  now: number,
  opts: {
    max?: number;
    graceMs?: number;
    cooldownMs?: number;
    userLookMs?: number;
  } = {},
): SweepDecision {
  const max = opts.max ?? MAX_OPEN_TABS;
  const graceMs = opts.graceMs ?? NEW_TAB_GRACE_MS;
  const cooldownMs = opts.cooldownMs ?? PAYMENT_COOLDOWN_MS;
  const userLookMs = opts.userLookMs ?? USER_LOOK_MS;

  const locked = (t: SweepTab): boolean =>
    t.leased ||
    now < t.busyUntil ||
    now - t.at < graceMs ||
    t.active ||
    now - t.lastAccessed < userLookMs;

  const free = tabs.filter((t) => !locked(t));
  const byAge = (a: SweepTab, b: SweepTab): number => a.at - b.at;

  const garbage = free
    .filter(
      (t) =>
        (t.kind === "admin" && !t.inPool) ||
        (t.kind === "payment" && now - t.busyUntil >= cooldownMs),
    )
    .sort(byAge);
  const garbageIds = new Set(garbage.map((t) => t.tabId));

  const over = tabs.length - garbage.length - max;
  const spare = free.filter((t) => !garbageIds.has(t.tabId)).sort(byAge);
  const extra = over > 0 ? spare.slice(0, over) : [];

  return {
    closeIds: [...garbage, ...extra].map((t) => t.tabId),
    stillOver: over > extra.length,
  };
}

/** Sổ + trạng thái thật của từng tab, đã bỏ tab không còn tồn tại. */
async function liveTabs(): Promise<SweepTab[]> {
  const book = await readBook();
  const ids = Object.keys(book);
  if (ids.length === 0) return [];
  const pool = new Set(await poolTabIds());
  const leased = new Set(await leasedTabIds());
  const out: SweepTab[] = [];
  for (const key of ids) {
    const tabId = Number(key);
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      // Tab đã đóng (user đóng, Chrome dọn) → bỏ khỏi sổ.
      await forgetOpenedTab(tabId);
      continue;
    }
    const e = book[key];
    out.push({
      tabId,
      kind: e.kind,
      at: e.at,
      busyUntil: e.busyUntil,
      inPool: pool.has(tabId),
      leased: leased.has(tabId),
      active: tab.active === true,
      lastAccessed: tab.lastAccessed ?? 0,
    });
  }
  return out;
}

/**
 * Dọn tab thừa để extension không giữ quá `MAX_OPEN_TABS` tab.
 *
 * Không throw (best-effort) — gọi được từ alarm, từ chỗ mở tab, từ đâu cũng được.
 */
export async function enforceTabCap(): Promise<number[]> {
  let tabs: SweepTab[];
  try {
    tabs = await liveTabs();
  } catch (e) {
    console.warn(`${LOG} đọc sổ tab lỗi (bỏ qua)`, e);
    return [];
  }
  if (tabs.length === 0) return [];

  const { closeIds, stillOver } = chooseTabsToClose(tabs, Date.now());
  if (closeIds.length === 0) {
    if (stillOver) {
      console.warn(
        `${LOG} đang giữ ${tabs.length} tab (trần ${MAX_OPEN_TABS}) nhưng tab nào ` +
          `cũng đang có lệnh dùng / user đang xem — chờ lượt quét sau`,
      );
    }
    return [];
  }

  console.log(
    `${LOG} đang giữ ${tabs.length} tab (trần ${MAX_OPEN_TABS}) → đóng ${closeIds.length}: ${closeIds.join(",")}`,
  );
  for (const id of closeIds) {
    try {
      await chrome.tabs.remove(id);
    } catch (e) {
      console.warn(`${LOG} đóng tab ${id} lỗi (bỏ qua)`, e);
    }
    await forgetOpenedTab(id);
    // Đóng tab rồi thì ô của bể tab phải trống theo, kẻo lượt chạy sau còn trỏ
    // vào tab chết (cùng lý do `idle-close.ts` gọi `forgetTab`).
    await forgetTab(id);
  }
  return closeIds;
}

/** Tab bị đóng (user đóng tay, Chrome dọn) → xoá khỏi sổ. */
export function setupOpenedTabsListener(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void forgetOpenedTab(tabId);
  });
}
