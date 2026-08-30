import { describe, expect, it } from "vitest";
import {
  EMPTY_CONFIRM_MS,
  EMPTY_HARD_MS,
  LOADING_IGNORE_MS,
  MIN_WAIT_MS,
  POLL_INTERVAL_MS,
  STABLE_TICKS,
  waitForPendingListLoaded,
  walkPendingPages,
  type PageCursor,
  type PendingSnapshot,
} from "./pending-list-loaded";

/**
 * Đồng hồ giả: `sleep` đẩy thẳng thời gian nên vòng chờ chạy tức thì trong test
 * mà vẫn giữ đúng mọi mốc thời gian thật của bản chạy.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const LIST3 = ["a@x.com", "b@x.com", "c@x.com"];

function snap(over: Partial<PendingSnapshot> = {}): PendingSnapshot {
  return {
    onTab: true,
    loading: false,
    listChrome: true,
    rows: over.emails?.length ?? 0,
    emails: [],
    ...over,
  };
}

/** Chạy vòng chờ với bộ đọc phụ thuộc thời gian. */
async function run(
  read: (nowMs: number) => PendingSnapshot,
  baseline: string[] = [],
  budgetMs = 30_000,
) {
  const clock = fakeClock();
  return waitForPendingListLoaded(budgetMs, new Set(baseline), {
    read: () => read(clock.now()),
    now: clock.now,
    sleep: clock.sleep,
  });
}

describe("waitForPendingListLoaded", () => {
  it("chốt khi danh sách có email và đứng yên đủ nhịp", async () => {
    const v = await run(() => snap({ emails: LIST3, rows: 3 }));
    expect(v.loaded).toBe(true);
    if (v.loaded) {
      expect(v.emails).toEqual(LIST3);
      // Đứng yên ngay từ nhịp đầu vẫn phải qua MIN_WAIT mới được chốt.
      expect(v.waitedMs).toBeGreaterThanOrEqual(MIN_WAIT_MS);
      expect(v.waitedMs).toBeGreaterThanOrEqual((STABLE_TICKS - 1) * POLL_INTERVAL_MS);
    }
  });

  it("KHÔNG chốt 0 lời mời khi danh sách còn đang tải", async () => {
    // Đúng ca hỏng user báo 29/8/2026: tab đã đổi, danh sách chưa đổ, DOM đứng
    // yên hoàn hảo ở 0 → bản cũ chốt "không có lời mời nào".
    const v = await run((t) =>
      t < 12_000
        ? snap({ loading: true, listChrome: false })
        : snap({ emails: LIST3, rows: 3 }),
    );
    expect(v.loaded).toBe(true);
    if (v.loaded) {
      expect(v.emails).toEqual(LIST3);
      expect(v.waitedMs).toBeGreaterThanOrEqual(12_000);
    }
  });

  it("danh sách rỗng THẬT vẫn chốt được, sau khi soi đủ lâu", async () => {
    const v = await run(() => snap({ listChrome: true }));
    expect(v.loaded).toBe(true);
    if (v.loaded) {
      expect(v.emails).toEqual([]);
      expect(v.waitedMs).toBeGreaterThanOrEqual(EMPTY_CONFIRM_MS);
    }
  });

  it("rỗng mà chưa thấy khung danh sách thì phải soi lâu hơn nữa", async () => {
    const v = await run(() => snap({ listChrome: false }));
    expect(v.loaded).toBe(true);
    if (v.loaded) expect(v.waitedMs).toBeGreaterThanOrEqual(EMPTY_HARD_MS);
  });

  it("còn thấy danh sách tab 'Người dùng' thì KHÔNG chốt", async () => {
    // Ca đếm thừa: URL đã sang ?tab=invites nhưng React chưa gỡ dòng cũ.
    const members = ["m1@x.com", "m2@x.com", "m3@x.com"];
    const v = await run(() => snap({ emails: members, rows: 3 }), members);
    expect(v.loaded).toBe(false);
    if (!v.loaded) expect(v.reason).toContain("tab 'Người dùng'");
  });

  it("DOM còn dòng mà không dòng nào đang hiện thì KHÔNG chốt là rỗng", async () => {
    // Van an toàn của phép đo hiển thị (30/8/2026): nếu vì lý do gì đó mọi dòng
    // đều bị chấm là ẩn thì "0 email" KHÔNG phải "workspace sạch lời mời" —
    // chốt nhầm là đếm THIẾU nợ suất, tức mời vào chỗ không có.
    const v = await run(() => snap({ emails: [], rows: 0, hiddenOnly: true }));
    expect(v.loaded).toBe(false);
    if (!v.loaded) expect(v.reason).toContain("không dòng nào đang hiện");
  });

  it("một email trùng danh sách cũ vẫn chốt (rác ngoài danh sách)", async () => {
    const v = await run(
      () => snap({ emails: ["admin@x.com", "b@x.com"], rows: 2 }),
      ["admin@x.com", "m2@x.com", "m3@x.com"],
    );
    expect(v.loaded).toBe(true);
  });

  it("danh sách đang đổ dần thì chờ tới lúc đứng yên", async () => {
    const grown = 5 * POLL_INTERVAL_MS;
    const v = await run((t) => {
      const n = t < grown ? 1 + Math.floor(t / POLL_INTERVAL_MS) : 9;
      const emails = Array.from({ length: n }, (_, i) => `u${i}@x.com`);
      return snap({ emails, rows: n });
    });
    expect(v.loaded).toBe(true);
    if (v.loaded) {
      expect(v.emails).toHaveLength(9);
      expect(v.waitedMs).toBeGreaterThanOrEqual(grown + (STABLE_TICKS - 1) * POLL_INTERVAL_MS);
    }
  });

  it("trang rời tab thì dừng ngay, không đọc tiếp", async () => {
    const v = await run((t) =>
      t < 2_000
        ? snap({ emails: LIST3, rows: 3 })
        : snap({ onTab: false, emails: LIST3, rows: 3 }),
    );
    expect(v.loaded).toBe(false);
    if (!v.loaded) {
      expect(v.reason).toContain("không còn ở tab");
      expect(v.waitedMs).toBeLessThan(MIN_WAIT_MS + POLL_INTERVAL_MS);
    }
  });

  it("vòng xoay nằm lì không được khoá cứng lượt đọc", async () => {
    const v = await run(() => snap({ loading: true, emails: LIST3, rows: 3 }));
    expect(v.loaded).toBe(true);
    if (v.loaded) expect(v.waitedMs).toBeGreaterThanOrEqual(LOADING_IGNORE_MS);
  });

  it("hết ngân sách mà danh sách vẫn nhảy → trả lý do, không chốt bừa", async () => {
    let n = 0;
    const v = await run(() => {
      n += 1;
      const emails = Array.from({ length: n }, (_, i) => `u${i}@x.com`);
      return snap({ emails, rows: n });
    }, [], 10_000);
    expect(v.loaded).toBe(false);
    if (!v.loaded) {
      expect(v.reason).toContain("chưa đứng yên");
      expect(v.waitedMs).toBeLessThanOrEqual(10_000);
    }
  });
});

/* ────────────────────────── LẬT HẾT CÁC TRANG ──────────────────────────── */

/** Bộ giả lập tab "Lời mời" nhiều trang. */
function fakePages(pages: string[][]) {
  let idx = 0;
  const seenBaselines: Array<string[]> = [];
  let clock = 0;
  return {
    seenBaselines,
    deps: {
      loadPage: async (baseline: ReadonlySet<string>) => {
        seenBaselines.push([...baseline].sort());
        clock += 1_000;
        return {
          loaded: true as const,
          emails: pages[idx],
          waitedMs: 1_000,
          ticks: 3,
        };
      },
      cursor: (): PageCursor | null => ({
        current: idx + 1,
        total: pages.length,
        canNext: idx + 1 < pages.length,
      }),
      goNext: async () => {
        idx += 1;
        return true;
      },
      now: () => clock,
    },
  };
}

describe("walkPendingPages", () => {
  it("lật hết 3 trang rồi cộng lại", async () => {
    const f = fakePages([
      ["a@x.com", "b@x.com"],
      ["c@x.com", "d@x.com"],
      ["e@x.com"],
    ]);
    const r = await walkPendingPages(new Set(["m@x.com"]), 90_000, f.deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pagesRead).toBe(3);
      expect([...r.emails].sort()).toEqual([
        "a@x.com",
        "b@x.com",
        "c@x.com",
        "d@x.com",
        "e@x.com",
      ]);
    }
    // Trang đầu so với danh sách tab "Người dùng"; trang sau so với trang trước.
    expect(f.seenBaselines).toEqual([
      ["m@x.com"],
      ["a@x.com", "b@x.com"],
      ["c@x.com", "d@x.com"],
    ]);
  });

  it("email trùng giữa hai trang chỉ tính một lần", async () => {
    const f = fakePages([
      ["a@x.com", "b@x.com"],
      ["b@x.com", "c@x.com"],
    ]);
    const r = await walkPendingPages(new Set(), 90_000, f.deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.emails).toHaveLength(3);
  });

  it("một trang giữa chừng không nạp xong → BỎ, không trả tổng thiếu", async () => {
    let n = 0;
    const r = await walkPendingPages(new Set(), 90_000, {
      loadPage: async () => {
        n += 1;
        return n === 1
          ? { loaded: true as const, emails: ["a@x.com"], waitedMs: 1, ticks: 1 }
          : {
              loaded: false as const,
              reason: "danh sách chưa đứng yên",
              waitedMs: 15_000,
              ticks: 30,
            };
      },
      cursor: () => ({ current: n, total: 3, canNext: true }),
      goNext: async () => true,
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("trang 2");
      expect(r.pagesRead).toBe(1);
    }
  });

  it("bấm next không ăn → BỎ", async () => {
    const r = await walkPendingPages(new Set(), 90_000, {
      loadPage: async () => ({
        loaded: true as const,
        emails: ["a@x.com"],
        waitedMs: 1,
        ticks: 1,
      }),
      cursor: () => ({ current: 1, total: 2, canNext: true }),
      goNext: async () => false,
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("không ăn");
  });

  it("thanh phân trang biến mất giữa chừng → BỎ", async () => {
    const r = await walkPendingPages(new Set(), 90_000, {
      loadPage: async () => ({
        loaded: true as const,
        emails: ["a@x.com"],
        waitedMs: 1,
        ticks: 1,
      }),
      cursor: () => null,
      goNext: async () => true,
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("biến mất");
  });

  it("hết ngân sách giữa chừng → BỎ chứ không cộng nửa vời", async () => {
    let clock = 0;
    const r = await walkPendingPages(new Set(), 10_000, {
      loadPage: async () => {
        clock += 6_000;
        return { loaded: true as const, emails: ["a@x.com"], waitedMs: 1, ticks: 1 };
      },
      cursor: () => ({ current: 1, total: 5, canNext: true }),
      goNext: async () => true,
      now: () => clock,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("quá 10s");
  });
});
