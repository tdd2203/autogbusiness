/**
 * Bể ô tab: 2 ô ⇒ nhiều nhất 2 lệnh chạy cùng lúc, lệnh thứ 3 phải xếp hàng.
 * Chỉ test phần giữ/trả ô (thuần logic) — phần sổ tab cần chrome.storage.
 */
import { describe, expect, it } from "vitest";
import { acquireSlot, anySlotLeased, releaseSlot, TAB_SLOTS } from "./tab-pool";

describe("bể ô tab", () => {
  it("CHỈ MỘT ô — lệnh thứ hai phải xếp hàng", async () => {
    // Một ô là chốt cố ý, không phải cấu hình tạm: tab admin phải là tab ĐANG
    // HIỆN mới được trình duyệt vẽ, mà mỗi cửa sổ chỉ có một tab đang hiện.
    // Chạy song song = tự đẩy lệnh kia xuống nền cho nó đứng hình. Xem chú thích
    // của `TAB_SLOTS`.
    expect(TAB_SLOTS).toHaveLength(1);

    const a = await acquireSlot();
    expect(TAB_SLOTS).toContain(a);
    expect(anySlotLeased()).toBe(true);

    let second: number | null = null;
    const pending = acquireSlot().then((s) => (second = s));
    // Chưa ai trả ô → lệnh thứ hai vẫn treo, KHÔNG được cấp ô song song.
    await Promise.resolve();
    expect(second).toBeNull();

    releaseSlot(a);
    await pending;
    // Nhận đúng ô vừa được trả, không phải một ô thứ hai.
    expect(second).toBe(a);

    releaseSlot(a);
    expect(anySlotLeased()).toBe(false);
  });
});
