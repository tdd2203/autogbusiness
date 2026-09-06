import { beforeEach, describe, expect, it } from "vitest";

import {
  resetWorkerSleepProbe,
  sleepAccurate,
  type SleepDeps,
} from "./unthrottled-sleep";

function deps(over: Partial<SleepDeps> = {}): SleepDeps & {
  asked: number[];
  fell: number[];
} {
  const asked: number[] = [];
  const fell: number[] = [];
  return {
    asked,
    fell,
    hidden: () => true,
    ask: async (ms) => {
      asked.push(ms);
    },
    fallback: async (ms) => {
      fell.push(ms);
    },
    ...over,
  };
}

describe("sleepAccurate", () => {
  beforeEach(() => resetWorkerSleepProbe());

  it("tab ẩn + nhịp ngắn → nhờ service worker đếm giờ", async () => {
    const d = deps();
    await sleepAccurate(300, d);
    expect(d.asked).toEqual([300]);
    expect(d.fell).toEqual([]);
  });

  it("tab đang hiện → dùng thẳng setTimeout, không phiền service worker", async () => {
    const d = deps({ hidden: () => false });
    await sleepAccurate(300, d);
    expect(d.asked).toEqual([]);
    expect(d.fell).toEqual([300]);
  });

  it("nhịp dài (≥1s) không đi vòng — trần 1 giây của Chrome không còn đáng kể", async () => {
    const d = deps();
    await sleepAccurate(1500, d);
    expect(d.asked).toEqual([]);
    expect(d.fell).toEqual([1500]);
  });

  it("kênh tới service worker hỏng thì lùi về setTimeout và THÔI thử lại", async () => {
    const d = deps({
      ask: async () => {
        throw new Error("Extension context invalidated");
      },
    });
    await sleepAccurate(300, d);
    expect(d.fell).toEqual([300]);
    // Lượt sau không được phí thêm một lượt nhắn tin nữa.
    const d2 = deps();
    await sleepAccurate(300, d2);
    expect(d2.asked).toEqual([]);
    expect(d2.fell).toEqual([300]);
  });

  it("ms <= 0 thì không chờ gì cả (setTimeout(0) ở tab ẩn cũng mất 1 giây)", async () => {
    const d = deps();
    await sleepAccurate(0, d);
    expect(d.asked).toEqual([]);
    expect(d.fell).toEqual([]);
  });
});
