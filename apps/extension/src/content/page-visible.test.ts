import { describe, expect, it } from "vitest";

import {
  pageHiddenMidRunMessage,
  pageIsVisible,
  waitForPageVisible,
  type VisibilityDeps,
} from "./page-visible";

function deps(states: DocumentVisibilityState[]): VisibilityDeps & { waits: number } {
  let i = 0;
  let now = 0;
  const box = {
    waits: 0,
    state: () => states[Math.min(i, states.length - 1)],
    wait: async (ms: number) => {
      box.waits += 1;
      now += ms;
      i += 1;
    },
    now: () => now,
  };
  return box;
}

describe("waitForPageVisible", () => {
  it("tab đang hiện → đi tiếp ngay, không chờ nhịp nào", async () => {
    const d = deps(["visible"]);
    await expect(waitForPageVisible(8000, d)).resolves.toBe(true);
    expect(d.waits).toBe(0);
  });

  it("tab vừa mở còn ẩn rồi hiện → chờ được, không báo hỏng oan", async () => {
    const d = deps(["hidden", "hidden", "visible"]);
    await expect(waitForPageVisible(8000, d)).resolves.toBe(true);
    expect(d.waits).toBe(2);
  });

  it("ẩn suốt tới hết hạn → trả false để caller dừng, KHÔNG đọc bảng cũ", async () => {
    const d = deps(["hidden"]);
    await expect(waitForPageVisible(1000, d)).resolves.toBe(false);
  });

  it("hạn 0 mà đang ẩn → dừng ngay, không chờ", async () => {
    const d = deps(["hidden"]);
    await expect(waitForPageVisible(0, d)).resolves.toBe(false);
    expect(d.waits).toBe(0);
  });
});

describe("pageIsVisible", () => {
  it("trả đúng trạng thái ngay lúc gọi, không chờ", () => {
    expect(pageIsVisible({ state: () => "visible" })).toBe(true);
    expect(pageIsVisible({ state: () => "hidden" })).toBe(false);
  });
});

describe("pageHiddenMidRunMessage", () => {
  it("nói rõ đã thu được bao nhiêu dòng trước khi dừng", () => {
    const m = pageHiddenMidRunMessage(137);
    expect(m).toContain("137");
    // Phải nói việc cần làm, không phải "thử lại sau".
    expect(m).toContain("ở trước");
  });
});
