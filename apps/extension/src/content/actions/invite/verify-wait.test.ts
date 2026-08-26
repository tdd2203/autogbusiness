import { describe, expect, it } from "vitest";

import {
  VERIFY_WAIT_MAX_MS,
  inviteVerifyTimeoutMs,
} from "./verify-wait";

describe("inviteVerifyTimeoutMs", () => {
  it("ca thật 26/8/2026 (mẻ 5 email karol*): trần phải > 15s cũ", () => {
    // 15s cố định là lý do mẻ này báo VERIFY_FAILED dù ChatGPT đã nhận đủ 5 lời
    // mời — backend suýt hoàn 1.650.000đ oan.
    expect(inviteVerifyTimeoutMs(5)).toBeGreaterThan(15_000);
    expect(inviteVerifyTimeoutMs(5)).toBe(49_000);
  });

  it("mẻ càng nhiều email càng được chờ lâu hơn", () => {
    expect(inviteVerifyTimeoutMs(2)).toBeGreaterThan(inviteVerifyTimeoutMs(1));
    expect(inviteVerifyTimeoutMs(10)).toBeGreaterThan(inviteVerifyTimeoutMs(5));
  });

  it("mời 1 email vẫn được nới so với 15s cũ", () => {
    expect(inviteVerifyTimeoutMs(1)).toBe(25_000);
  });

  it("có TRẦN — mẻ lớn không được ngốn hết hạn Phase 1 của background", () => {
    expect(inviteVerifyTimeoutMs(50)).toBe(VERIFY_WAIT_MAX_MS);
    expect(inviteVerifyTimeoutMs(1_000)).toBe(VERIFY_WAIT_MAX_MS);
  });

  it("trần luôn NHỎ HƠN NHIỀU hạn Phase 1 (450s) — còn chỗ cho quét + F5 verify", () => {
    expect(VERIFY_WAIT_MAX_MS).toBeLessThan(150_000);
  });

  it("số email vô nghĩa → coi như 1 email, KHÔNG cắt xuống 0", () => {
    expect(inviteVerifyTimeoutMs(0)).toBe(25_000);
    expect(inviteVerifyTimeoutMs(-3)).toBe(25_000);
    expect(inviteVerifyTimeoutMs(Number.NaN)).toBe(25_000);
  });
});
