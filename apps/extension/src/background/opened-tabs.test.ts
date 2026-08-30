/**
 * TRẦN 3 TAB — phần quyết định "đóng tab nào".
 *
 * Hai kiểu sai đều đắt, nên mỗi kiểu một bộ ca:
 *   - đóng nhầm tab đang có lệnh chạy / user đang xem ⇒ cắt ngang việc thật,
 *     nặng nhất là cắt giữa một giao dịch đã tiêu tiền;
 *   - không đóng gì ⇒ tab chồng chất, đúng thứ user bảo phải hết.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_OPEN_TABS,
  NEW_TAB_GRACE_MS,
  PAYMENT_COOLDOWN_MS,
  USER_LOOK_MS,
  chooseTabsToClose,
  type OpenedTabKind,
  type SweepTab,
} from "./opened-tabs";

const NOW = 10_000_000;
const OLD = NOW - 60 * 60 * 1000;

function tab(id: number, over: Partial<SweepTab> = {}): SweepTab {
  return {
    tabId: id,
    kind: "admin" as OpenedTabKind,
    at: OLD,
    busyUntil: 0,
    inPool: false,
    leased: false,
    active: false,
    lastAccessed: OLD,
    ...over,
  };
}

function close(tabs: SweepTab[]) {
  return chooseTabsToClose(tabs, NOW);
}

describe("chooseTabsToClose", () => {
  it("đúng 3 tab đang dùng thì không đóng gì", () => {
    const r = close([
      tab(1, { inPool: true, leased: true }),
      tab(2, { inPool: true, leased: true }),
      tab(3, { kind: "payment", busyUntil: NOW + 60_000 }),
    ]);
    expect(r.closeIds).toEqual([]);
    expect(r.stillOver).toBe(false);
  });

  it("tab admin MỒ CÔI bị đóng kể cả khi chưa chạm trần", () => {
    const r = close([
      tab(1, { inPool: true, leased: true }),
      tab(9, { inPool: false, at: OLD }), // tab nuclear bỏ lại
    ]);
    expect(r.closeIds).toEqual([9]);
  });

  it("tab thanh toán đã nguội thì dọn, còn nóng thì KHÔNG", () => {
    const coldEnough = NOW - PAYMENT_COOLDOWN_MS - 1;
    const justDone = NOW - 1_000;
    const r = close([
      tab(1, { kind: "payment", busyUntil: coldEnough }),
      tab(2, { kind: "payment", busyUntil: justDone }),
    ]);
    expect(r.closeIds).toEqual([1]);
  });

  it("quá trần mà chỉ còn tab thanh toán đang nóng → hy sinh tab admin rảnh", () => {
    // Đúng ca thật: 2 tab admin của bể + tab Stripe + tab Link = 4.
    const r = close([
      tab(1, { inPool: true, leased: true, at: OLD }),
      tab(2, { inPool: true, leased: false, at: OLD + 1_000 }),
      tab(3, { kind: "payment", busyUntil: NOW + 60_000, at: OLD + 2_000 }),
      tab(4, { kind: "payment", busyUntil: NOW + 60_000, at: OLD + 3_000 }),
    ]);
    expect(r.closeIds).toEqual([2]);
    expect(r.stillOver).toBe(false);
  });

  it("KHÔNG đóng tab đang có lệnh giữ, dù quá trần", () => {
    const r = close([
      tab(1, { inPool: true, leased: true }),
      tab(2, { inPool: true, leased: true }),
      tab(3, { kind: "payment", busyUntil: NOW + 60_000 }),
      tab(4, { kind: "payment", busyUntil: NOW + 60_000 }),
    ]);
    expect(r.closeIds).toEqual([]);
    expect(r.stillOver).toBe(true);
  });

  it("KHÔNG đóng tab user đang xem hoặc vừa xem", () => {
    const r = close([
      tab(1, { inPool: false, active: true }),
      tab(2, { inPool: false, lastAccessed: NOW - USER_LOOK_MS + 1_000 }),
      tab(3, { inPool: false }),
    ]);
    expect(r.closeIds).toEqual([3]);
  });

  it("KHÔNG đóng tab vừa mở (đang bàn giao cho lệnh)", () => {
    const r = close([
      tab(1, { inPool: true, leased: true }),
      tab(2, { inPool: true, leased: true }),
      tab(3, { inPool: true, leased: true }),
      // vừa `tabs.create` xong, chưa kịp ghi vào sổ ô nên inPool=false
      tab(4, { inPool: false, at: NOW - NEW_TAB_GRACE_MS + 1_000, lastAccessed: 0 }),
    ]);
    expect(r.closeIds).toEqual([]);
    expect(r.stillOver).toBe(true);
  });

  it("nhiều tab thừa: đóng đủ để về đúng trần, cũ nhất trước", () => {
    const r = close([
      tab(1, { inPool: true, at: OLD + 5_000 }),
      tab(2, { inPool: true, at: OLD + 4_000 }),
      tab(3, { inPool: true, at: OLD + 3_000 }),
      tab(4, { inPool: true, at: OLD + 2_000 }),
      tab(5, { inPool: true, at: OLD + 1_000 }),
    ]);
    expect(r.closeIds).toEqual([5, 4]);
    expect(r.closeIds).toHaveLength(5 - MAX_OPEN_TABS);
  });
});
