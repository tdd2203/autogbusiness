/**
 * Đồng hồ chờ content script CÓ GIA HẠN theo nhịp tiến độ.
 *
 * VÌ SAO TÁCH RA (ca thật CHATGPT PRO 4→6/9/2026): `runner.ts` chờ content bằng
 * một con số CỨNG cho mỗi loại lệnh — con số đó đoán trước "lượt chạy hợp lệ dài
 * nhất". Đoán sát quá thì hỏng theo kiểu tệ nhất: chặng chốt suất + mua suất của
 * một lệnh mời trên workspace 400 người tốn đúng ~300s, đúng bằng mốc, nên nó
 * thành trò tung đồng xu — có lệnh xong ở 312s/335s và được ghi COMPLETED (đồng
 * hồ chết theo service worker trước khi kịp nổ), có lệnh bị chém ở đúng 300s DÙ
 * LỜI MỜI ĐÃ GỬI XONG.
 *
 * Nhịp tiến độ phân biệt được hai ca mà con số cứng không phân biệt nổi:
 * `progress-beat.ts` vốn đã đo "content còn sống hay không" nhưng chỉ dùng để
 * viết câu giải thích SAU KHI đã giết. Ở đây nó được dùng để KHÔNG giết.
 *
 * Luật: quá `baseMs` thì chưa giết ngay — còn nhịp trong `aliveWindowMs` thì cho
 * chạy tiếp tới `ceilingMs`; im quá `aliveWindowMs` thì giết NGAY, không đợi hết
 * trần. Hai lý do dừng có câu lỗi khác nhau để phần chẩn đoán không nói ngược.
 */

export type LiveTimeoutDeps = {
  now: () => number;
  /** Mốc nhịp gần nhất của task (ms), null khi chưa có nhịp nào. */
  lastBeatAt: () => number | null;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const realDeps = (lastBeatAt: () => number | null): LiveTimeoutDeps => ({
  now: () => Date.now(),
  lastBeatAt,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
});

export type LiveTimeoutOptions = {
  /** Mốc cứng như cũ — tới đây mới bắt đầu soi nhịp. */
  baseMs: number;
  /** Trần TRÊN tuyệt đối, kể cả khi nhịp vẫn về đều. */
  ceilingMs: number;
  /** Im lâu hơn ngần này thì kết luận content chết/treo. */
  aliveWindowMs: number;
  /** Nhịp soi lại. */
  checkMs: number;
  label: string;
  lastBeatAt: () => number | null;
};

export function withLiveTimeout<T>(
  p: Promise<T>,
  opts: LiveTimeoutOptions,
  deps: LiveTimeoutDeps = realDeps(opts.lastBeatAt),
): Promise<T> {
  const hardMs = Math.max(opts.baseMs, opts.ceilingMs);
  const startedAt = deps.now();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let handle: unknown = null;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      if (handle !== null) deps.clearInterval(handle);
      fn();
    };
    handle = deps.setInterval(() => {
      const elapsed = deps.now() - startedAt;
      if (elapsed < opts.baseMs) return;
      const beat = deps.lastBeatAt();
      // Chưa có nhịp nào ⇒ coi như im từ lúc bắt đầu.
      const silentMs = beat === null ? elapsed : deps.now() - beat;
      if (silentMs > opts.aliveWindowMs) {
        finish(() =>
          reject(
            new Error(
              `timeout:${opts.label} sau ${elapsed}ms ` +
                `(im lặng ${Math.round(silentMs / 1000)}s)`,
            ),
          ),
        );
        return;
      }
      if (elapsed >= hardMs) {
        finish(() =>
          reject(
            new Error(
              `timeout:${opts.label} sau ${elapsed}ms ` +
                `(chạm trần ${Math.round(hardMs / 1000)}s dù content vẫn báo nhịp)`,
            ),
          ),
        );
      }
    }, opts.checkMs);
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}
