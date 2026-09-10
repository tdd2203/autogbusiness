import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_CLOSE_MS, createHoverMenu, hoverMenuWrap } from "./hoverMenu";

describe("hình học menu rê chuột", () => {
  it("khe hở nằm TRONG vùng chuột, không phải khe thật", () => {
    // Lỗi user báo 10/9/2026: `marginTop` tạo khe hở, chuột đi qua là menu tắt.
    expect(hoverMenuWrap.top).toBe("100%");
    expect(hoverMenuWrap.paddingTop).toBeGreaterThan(0);
    expect(hoverMenuWrap).not.toHaveProperty("marginTop");
  });
});

describe("menu rê chuột", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rê vào là mở ngay, không chờ", () => {
    const seen: boolean[] = [];
    createHoverMenu((v) => seen.push(v)).enter();
    expect(seen).toEqual([true]);
  });

  it("rời ra thì CHƯA đóng ngay — đi chéo xuống mục cuối vẫn kịp", () => {
    const seen: boolean[] = [];
    const m = createHoverMenu((v) => seen.push(v));
    m.enter();
    m.leave();
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 1);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
  });

  it("quay lại trong lúc chờ thì huỷ hẹn, menu ở nguyên", () => {
    const seen: boolean[] = [];
    const m = createHoverMenu((v) => seen.push(v));
    m.enter();
    m.leave();
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 20);
    m.enter();
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 3);
    // Không được có `false` nào lọt ra: đó chính là lỗi menu tắt giữa chừng.
    expect(seen).not.toContain(false);
  });

  it("bấm một mục thì đóng NGAY, không đợi hết trễ", () => {
    const seen: boolean[] = [];
    const m = createHoverMenu((v) => seen.push(v));
    m.enter();
    m.closeNow();
    expect(seen).toEqual([true, false]);
  });

  it("gỡ bỏ khi đang treo hẹn thì không đóng muộn sau đó", () => {
    const seen: boolean[] = [];
    const m = createHoverMenu((v) => seen.push(v));
    m.enter();
    m.leave();
    m.dispose();
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 3);
    expect(seen).toEqual([true]);
  });
});
