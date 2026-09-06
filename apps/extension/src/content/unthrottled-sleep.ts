/**
 * CHỜ ĐÚNG SỐ MILI GIÂY ĐÃ HẸN, kể cả khi tab đang chạy nền.
 *
 * ĐO THẬT trên máy user 6/9/2026, tab `/admin/members` ở trạng thái `hidden`:
 *
 *   await sleep(300)  →  957 ms
 *   await sleep(0)    →  1000 ms
 *
 * Chrome bóp mọi `setTimeout` của tab ẩn về tối thiểu ~1 giây. Extension mở tab
 * admin bằng `active: false` nên TOÀN BỘ nhịp chờ của bộ quét đều dính. Đây là
 * lý do thật khiến lệnh đồng bộ tốn hàng trăm giây, chứ không phải DOM nặng:
 * cùng lúc đó `document.querySelectorAll` toàn trang chỉ mất **2 ms** và đọc
 * hết 25 dòng mất **0 ms**. Trang nhẹ, chỉ có đồng hồ bị bóp.
 *
 * `human.ts` đã ghi nhận hiện tượng này từ trước và né bằng cách bỏ gõ từng ký
 * tự, nhưng vòng cuộn của bộ quét thì chưa ai đụng tới — mỗi trang tốn hơn chục
 * nhịp chờ, nhân 16 trang là ra đúng con số quan sát được.
 *
 * CÁCH CHỮA: nhờ service worker đếm giờ hộ. Service worker KHÔNG phải một tab
 * nên không dính luật bóp đồng hồ theo trạng thái hiển thị. Content gửi "gọi
 * tôi dậy sau N ms", SW hẹn bằng đồng hồ của nó rồi trả lời. Một lượt nhắn tin
 * tốn ~1 ms, đổi lại nhịp chờ đúng bằng số đã hẹn.
 *
 * Vì sao KHÔNG dùng `MessageChannel` (cách hay được mách trên mạng): đo tại chỗ
 * thì nó đúng 300 ms thật, nhưng phải quay **43.832 vòng** cho một nhịp 300 ms —
 * đó là vòng lặp đốt CPU. Nhờ SW chỉ tốn 2 lượt nhắn tin.
 *
 * ⚠️ CHỈ định tuyến nhịp NGẮN (< 1s). Nhịp dài hơn thì trần 1 giây của Chrome
 * không còn đáng kể, dùng thẳng `setTimeout` cho rẻ và bớt một đường phụ thuộc.
 */

/** Trên mốc này thì sai số 1 giây của Chrome không còn đáng để đi vòng. */
const SHORT_WAIT_MS = 1_000;

/** Trần cho một lượt nhờ SW đếm giờ — dài hơn thì SW dễ bị khai tử giữa chừng. */
const MAX_DELEGATED_MS = 5_000;

/**
 * `false` = đã thử nhờ SW và hỏng (context bị huỷ sau khi extension reload,
 * SW không trả lời...) ⇒ thôi không thử nữa, dùng thẳng `setTimeout`.
 */
let workerCanSleep: boolean | null = null;

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Chỉ để test tiêm trạng thái hiển thị giả. */
export type SleepDeps = {
  hidden: () => boolean;
  ask: (ms: number) => Promise<unknown>;
  fallback: (ms: number) => Promise<void>;
};

const defaultDeps: SleepDeps = {
  // Chạy ngoài trang (test node, worker) thì coi như không bị bóp đồng hồ —
  // đường vòng qua SW chỉ có ý nghĩa cho content script của một tab đang ẩn.
  hidden: () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  ask: (ms) => chrome.runtime.sendMessage({ type: "sleep", ms }),
  fallback: timerSleep,
};

export async function sleepAccurate(
  ms: number,
  deps: SleepDeps = defaultDeps,
): Promise<void> {
  if (ms <= 0) {
    // `setTimeout(0)` ở tab ẩn cũng mất 1 giây — nhường lượt bằng microtask.
    return;
  }
  const worthDelegating =
    ms < SHORT_WAIT_MS && ms <= MAX_DELEGATED_MS && deps.hidden() && workerCanSleep !== false;
  if (!worthDelegating) return deps.fallback(ms);
  try {
    await deps.ask(ms);
    workerCanSleep = true;
  } catch {
    // Kênh tới SW hỏng (thường là extension vừa reload) — từ đây dùng đồng hồ
    // của trang, chậm nhưng không bao giờ treo.
    workerCanSleep = false;
    await deps.fallback(ms);
  }
}

/** Chỉ dùng cho test — quên kết quả dò lần trước. */
export function resetWorkerSleepProbe(): void {
  workerCanSleep = null;
}
