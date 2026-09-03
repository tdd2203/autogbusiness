/**
 * Nhịp tiến độ gần nhất của từng task, ghi ngay tại background.
 *
 * VÌ SAO CÓ FILE NÀY: khi `CONTENT_TIMEOUTS` nổ, runner không biết content đang
 * chết hay đang chạy chậm, nên nó dán chung một câu khuyên "xoá cookie, đăng
 * nhập lại ChatGPT" cho mọi ca. Đọc lại 5 mẻ SYNC_DATA hỏng gần nhất trong DB
 * (25/8 → 3/9/2026) thì content vẫn sống nguyên: nó còn gửi nhịp tiến độ thêm
 * 5-13 phút SAU khi task đã bị đánh hỏng. Người dùng đi đăng nhập lại theo lời
 * khuyên đó là chữa nhầm bệnh.
 *
 * Content gửi nhịp qua `chrome.runtime.sendMessage({type:'task-progress'})`
 * (xem `content/progress.ts`) → `background/index.ts` gọi `recordProgressBeat`
 * ở đúng chỗ đó. Bộ nhớ này nằm trong RAM của service worker: SW chết thì mất
 * sạch, nhưng đồng hồ timeout cũng chết theo SW nên không có ca nào đọc trúng
 * dữ liệu mồ côi.
 */

export type ProgressBeat = {
  /** Mốc nhận nhịp (ms, đồng hồ máy chạy extension). */
  at: number;
  phase: string | null;
  message: string | null;
};

/** Giữ tối đa ngần này task — chặn rò rỉ khi SW sống lâu. */
const MAX_ENTRIES = 50;

const beats = new Map<string, ProgressBeat>();

export function recordProgressBeat(taskId: string, progress: unknown): void {
  const p = (progress ?? {}) as Record<string, unknown>;
  beats.set(taskId, {
    at: Date.now(),
    phase: typeof p.phase === "string" ? p.phase : null,
    message: typeof p.message === "string" ? p.message : null,
  });
  // Map giữ thứ tự chèn → key đầu tiên là task cũ nhất.
  while (beats.size > MAX_ENTRIES) {
    const oldest = beats.keys().next().value;
    if (oldest === undefined) break;
    beats.delete(oldest);
  }
}

export function readProgressBeat(taskId: string): ProgressBeat | null {
  return beats.get(taskId) ?? null;
}

export function clearProgressBeat(taskId: string): void {
  beats.delete(taskId);
}
