/**
 * Tự động ĐÓNG tab chatgpt.com/admin/* khi KHÔNG được dùng đến trong một khoảng
 * thời gian NGẪU NHIÊN (~10 phút → ~1 tiếng). Yêu cầu user 2026-07-27.
 *
 * "Không dùng đến" nghĩa là:
 *   - Extension KHÔNG chạy task nào trên tab admin (markAdminActivity không được
 *     gọi), VÀ
 *   - User KHÔNG đang mở/xem tab đó (tab.active=false và tab.lastAccessed cũ).
 *
 * Vì sao NGẪU NHIÊN chứ không cố định: hợp với triết lý "thao tác như người dùng
 * thật" của extension — không tạo pattern đóng tab đều tăm tắp dễ bị nhận là bot.
 * Mỗi phiên idle mới bốc 1 ngưỡng random trong [MIN, MAX].
 *
 * Cơ chế: alarm ~1 phút/lần (min cho phép ở prod Chrome). Mỗi tick:
 *   1. Query tab admin. Không còn tab → xoá state, thôi.
 *   2. Tính mốc "hoạt động gần nhất" = max(lần cuối extension dùng tab,
 *      tab.lastAccessed, now-nếu-tab-đang-active).
 *   3. Nếu có hoạt động mới hơn state đã lưu → reset lastActivity + bốc ngưỡng
 *      random MỚI (mỗi phiên idle một ngưỡng khác nhau).
 *   4. Đang bận chạy task → KHÔNG đóng (tránh cắt ngang).
 *   5. idle = now - lastActivity ≥ threshold → đóng HẾT tab admin, xoá state.
 */

const IDLE_CLOSE_ALARM = "autogpt-idle-close";
const STATE_KEY = "autogpt.adminIdle";

const CHATGPT_TAB_MATCH = "https://chatgpt.com/admin/*";

// Khoảng ngưỡng idle ngẫu nhiên: 10 phút → 60 phút.
const MIN_IDLE_MS = 10 * 60 * 1000;
const MAX_IDLE_MS = 60 * 60 * 1000;

interface IdleState {
  /** Mốc thời gian (epoch ms) của hoạt động gần nhất trên tab admin. */
  lastActivity: number;
  /** Ngưỡng idle (ms) random cho phiên idle hiện tại. */
  threshold: number;
}

/**
 * Runner đang chạy task hay không. Khi bận thì KHÔNG đóng tab (dù đã quá ngưỡng)
 * để không cắt ngang thao tác đang diễn ra. In-memory là đủ vì runUntilIdle
 * chạy trong cùng service-worker lifetime; nếu SW bị kill giữa chừng thì task
 * cũng dừng, không còn gì để bảo vệ.
 */
let runnerBusy = false;

export function setRunnerBusy(busy: boolean): void {
  runnerBusy = busy;
}

function randomThresholdMs(): number {
  // Math.random OK trong runtime extension (khác sandbox Workflow).
  return Math.floor(MIN_IDLE_MS + Math.random() * (MAX_IDLE_MS - MIN_IDLE_MS));
}

async function getState(): Promise<IdleState | null> {
  const obj = await chrome.storage.local.get(STATE_KEY);
  return (obj[STATE_KEY] as IdleState | undefined) ?? null;
}

async function setState(state: IdleState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function clearState(): Promise<void> {
  await chrome.storage.local.remove(STATE_KEY);
}

/**
 * Đánh dấu extension VỪA dùng tab admin (mỗi khi có task thực sự chạy xong).
 * Reset lastActivity=now và bốc ngưỡng idle random MỚI cho phiên kế tiếp.
 */
export async function markAdminActivity(): Promise<void> {
  await setState({ lastActivity: Date.now(), threshold: randomThresholdMs() });
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
 * Xử lý 1 tick alarm: quyết định có đóng tab admin idle hay không.
 * Không throw ra ngoài (best-effort) — lỗi query/close chỉ log.
 */
export async function handleIdleCloseTick(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: CHATGPT_TAB_MATCH });
  } catch (e) {
    console.warn("[autogpt-idle] query tab admin lỗi (bỏ qua)", e);
    return;
  }
  if (tabs.length === 0) {
    await clearState();
    return;
  }

  const now = Date.now();
  const anyActive = tabs.some((t) => t.active);
  const maxAccessed = tabs.reduce(
    (mx, t) => Math.max(mx, t.lastAccessed ?? 0),
    0,
  );
  // User đang xem tab (active) = coi như vừa hoạt động ngay bây giờ.
  const userActivity = anyActive ? now : maxAccessed;

  const state = await getState();
  let lastActivity = state?.lastActivity ?? 0;
  let threshold = state?.threshold ?? 0;

  // Có hoạt động mới hơn (extension chạy task, hoặc user vừa xem tab) → reset
  // cửa sổ idle + bốc ngưỡng random mới cho phiên này.
  if (!threshold || userActivity > lastActivity) {
    lastActivity = Math.max(lastActivity, userActivity, now - MAX_IDLE_MS);
    threshold = randomThresholdMs();
    await setState({ lastActivity, threshold });
  }

  // Đang chạy task → tuyệt đối không đóng.
  if (runnerBusy) return;

  const idle = now - lastActivity;
  if (idle < threshold) return;

  const ids = tabs
    .map((t) => t.id)
    .filter((id): id is number => id !== undefined);
  console.log(
    `[autogpt-idle] tab admin idle ${Math.round(idle / 60000)} phút ≥ ngưỡng ${Math.round(
      threshold / 60000,
    )} phút — tự đóng ${ids.length} tab: ${ids.join(",")}`,
  );
  try {
    await chrome.tabs.remove(ids);
  } catch (e) {
    console.warn("[autogpt-idle] đóng tab admin lỗi (bỏ qua)", e);
  }
  await clearState();
}
