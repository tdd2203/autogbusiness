/** Popup hướng dẫn đầu ngày — danh sách bài + luật "khi nào hiện".
 *
 *  LUẬT (chốt với user 31/8/2026):
 *  - Mỗi NGÀY vào web hiện MỘT bài, chọn ngẫu nhiên trong danh sách.
 *  - Bài đã chọn được ghim theo ngày: F5 hay mở lại trong ngày vẫn đúng bài đó,
 *    không phải mỗi lần load một bài khác.
 *  - Trong một tab, đóng rồi thì thôi (`sessionStorage` sống qua F5), nhưng mở tab
 *    mới trong ngày vẫn hiện lại — trừ khi user tick "Không hiện lại hôm nay".
 *  - Tick "Không hiện lại hôm nay" = tắt hẳn tới hết ngày, mọi tab.
 *
 *  Ngày tính theo giờ VN chứ không theo máy: khách dùng máy ảo/VPS lệch múi giờ
 *  thì "hôm nay" phải khớp với ngày mà cả hệ thống đang nói tới.
 *
 *  Hàm THUẦN (`vnDayKey`, `pickGuideId`, `shouldOpen`) tách khỏi phần đụng
 *  localStorage để test được — xem `guides.test.ts`.
 */
import type { Guide } from "./types";
import chatgptResetLimit from "./chatgpt-reset-limit";

export type { Guide, GuideContent, GuideSection, GuideStep } from "./types";
export { guidePrintHtml, openGuidePrint } from "./printable";

/** Thêm bài mới: viết file nội dung rồi đẩy vào đây, không phải sửa gì thêm. */
export const GUIDES: Guide[] = [chatgptResetLimit];

const STORAGE_KEY = "autogpt.guidePopup.v1";
const SESSION_KEY = "autogpt.guidePopup.session";

export type GuideState = {
  /** Ngày (giờ VN) của bài đang ghim. */
  day?: string;
  /** Bài đã chọn cho `day`. */
  guideId?: string;
  /** Ngày user đã tick "không hiện lại hôm nay". */
  mutedDay?: string;
};

/** "2026-08-31" theo giờ Việt Nam. */
export function vnDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Bài của ngày `day`: giữ nguyên nếu đã chốt, ngược lại bốc ngẫu nhiên.
 *
 *  Sang ngày mới thì TRÁNH bốc lại bài hôm trước (khi có từ 2 bài) — ngẫu nhiên
 *  thuần rất dễ ra cùng một bài hai ngày liền, người dùng tưởng popup hỏng. */
export function pickGuideId(
  day: string,
  state: GuideState,
  guides: Guide[] = GUIDES,
  rand: () => number = Math.random,
): string | null {
  if (guides.length === 0) return null;
  if (state.day === day && guides.some((g) => g.id === state.guideId)) {
    return state.guideId!;
  }
  const pool =
    guides.length > 1 ? guides.filter((g) => g.id !== state.guideId) : guides;
  const idx = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return pool[idx].id;
}

/** Có mở popup cho lượt vào web này không. */
export function shouldOpen(
  day: string,
  state: GuideState,
  sessionSeenDay: string | null,
  guides: Guide[] = GUIDES,
): boolean {
  if (guides.length === 0) return false;
  if (state.mutedDay === day) return false;
  if (sessionSeenDay === day) return false;
  return true;
}

/* ── Phần đụng storage ────────────────────────────────────────────────────── */
// localStorage ném lỗi trong chế độ riêng tư / khi bị chặn cookie bên thứ ba.
// Popup hướng dẫn không đáng để làm sập cả dashboard, nên nuốt lỗi và coi như
// chưa có trạng thái (cùng lắm là hiện lại popup).

export function readState(): GuideState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as GuideState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeState(next: GuideState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* bỏ qua */
  }
}

export function readSessionSeenDay(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function markSeenThisSession(day: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, day);
  } catch {
    /* bỏ qua */
  }
}

export function findGuide(id: string, guides: Guide[] = GUIDES): Guide | null {
  return guides.find((g) => g.id === id) ?? null;
}
