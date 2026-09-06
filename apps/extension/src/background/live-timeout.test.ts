import { describe, expect, it } from "vitest";

import { withLiveTimeout, type LiveTimeoutDeps } from "./live-timeout";

/**
 * Đồng hồ giả: `tick(ms)` nhích giờ rồi chạy mọi hàm đã đăng ký với setInterval
 * đúng số nhịp tương ứng. Không dùng fake timer của vitest để test đọc thẳng ra
 * "sau ngần này giây thì chuyện gì xảy ra".
 */
function fakeClock(): {
  deps: (lastBeatAt: () => number | null) => LiveTimeoutDeps;
  tick: (ms: number) => void;
  now: () => number;
} {
  let now = 0;
  const jobs = new Map<number, { fn: () => void; every: number; next: number }>();
  let seq = 0;
  return {
    now: () => now,
    deps: (lastBeatAt) => ({
      now: () => now,
      lastBeatAt,
      setInterval: (fn, every) => {
        const id = ++seq;
        jobs.set(id, { fn, every, next: now + every });
        return id;
      },
      clearInterval: (h) => {
        jobs.delete(h as number);
      },
    }),
    tick: (ms) => {
      const target = now + ms;
      // Chạy từng nhịp một cho tới mốc đích — job có thể tự huỷ giữa chừng.
      for (;;) {
        let soonest: number | null = null;
        for (const j of jobs.values()) {
          if (soonest === null || j.next < soonest) soonest = j.next;
        }
        if (soonest === null || soonest > target) break;
        now = soonest;
        for (const [id, j] of [...jobs]) {
          if (j.next <= now) {
            j.next = now + j.every;
            jobs.get(id)?.fn();
          }
        }
      }
      now = target;
    },
  };
}

const OPTS = {
  baseMs: 300_000,
  ceilingMs: 450_000,
  aliveWindowMs: 60_000,
  checkMs: 5_000,
  label: "content-INVITE_MEMBER",
};

describe("withLiveTimeout", () => {
  it("content xong TRƯỚC mốc cứng thì trả kết quả như thường", async () => {
    const clock = fakeClock();
    let done!: (v: string) => void;
    const p = new Promise<string>((r) => {
      done = r;
    });
    const race = withLiveTimeout(p, { ...OPTS, lastBeatAt: () => null }, clock.deps(() => null));
    clock.tick(120_000);
    done("ok");
    await expect(race).resolves.toBe("ok");
  });

  it("quá mốc cứng mà NHỊP VẪN VỀ thì cho chạy tiếp, không giết ở 300s", async () => {
    const clock = fakeClock();
    let done!: (v: string) => void;
    const p = new Promise<string>((r) => {
      done = r;
    });
    // Nhịp luôn tươi: content đang mua suất và báo 5s/lần.
    const beat = (): number => clock.now();
    const race = withLiveTimeout(p, { ...OPTS, lastBeatAt: beat }, clock.deps(beat));
    clock.tick(340_000);
    done("mời xong");
    // 340s > mốc 300s — bản cũ đã chém ở đây; nay phải về đích.
    await expect(race).resolves.toBe("mời xong");
  });

  it("quá mốc cứng mà IM LẶNG quá cửa sổ sống thì giết ngay", async () => {
    const clock = fakeClock();
    const p = new Promise<string>(() => {});
    // Nhịp cuối lúc 100s rồi tắt hẳn.
    const race = withLiveTimeout(
      p,
      { ...OPTS, lastBeatAt: () => 100_000 },
      clock.deps(() => 100_000),
    );
    const caught = race.catch((e: Error) => e.message);
    clock.tick(305_000);
    expect(await caught).toContain("im lặng");
  });

  it("nhịp vẫn về nhưng chạm TRẦN TRÊN thì vẫn phải dừng", async () => {
    const clock = fakeClock();
    const p = new Promise<string>(() => {});
    const beat = (): number => clock.now();
    const race = withLiveTimeout(p, { ...OPTS, lastBeatAt: beat }, clock.deps(beat));
    const caught = race.catch((e: Error) => e.message);
    clock.tick(455_000);
    expect(await caught).toContain("chạm trần");
  });

  it("không khai trần riêng (ceiling = base) thì giữ nguyên hành vi cũ", async () => {
    const clock = fakeClock();
    const p = new Promise<string>(() => {});
    const beat = (): number => clock.now();
    const race = withLiveTimeout(
      p,
      { ...OPTS, ceilingMs: OPTS.baseMs, lastBeatAt: beat },
      clock.deps(beat),
    );
    const caught = race.catch((e: Error) => e.message);
    clock.tick(305_000);
    expect(await caught).toContain("chạm trần");
  });
});
