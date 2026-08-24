/**
 * Bể ô tab: 2 ô ⇒ nhiều nhất 2 lệnh chạy cùng lúc, lệnh thứ 3 phải xếp hàng.
 * Chỉ test phần giữ/trả ô (thuần logic) — phần sổ tab cần chrome.storage.
 */
import { describe, expect, it } from "vitest";
import { acquireSlot, anySlotLeased, releaseSlot, TAB_SLOTS } from "./tab-pool";

describe("bể ô tab", () => {
  it("cấp đủ 2 ô khác nhau, ô thứ 3 phải đợi", async () => {
    const a = await acquireSlot();
    const b = await acquireSlot();
    expect(a).not.toBe(b);
    expect(TAB_SLOTS).toContain(a);
    expect(TAB_SLOTS).toContain(b);
    expect(anySlotLeased()).toBe(true);

    let third: number | null = null;
    const pending = acquireSlot().then((s) => (third = s));
    // Chưa ai trả ô → vẫn treo.
    await Promise.resolve();
    expect(third).toBeNull();

    releaseSlot(a);
    await pending;
    expect(third).toBe(a);

    releaseSlot(a);
    releaseSlot(b);
    expect(anySlotLeased()).toBe(false);
  });
});
