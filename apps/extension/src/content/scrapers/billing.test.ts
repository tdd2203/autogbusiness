import { describe, expect, it } from "vitest";
import { __internal } from "./billing";

const { parseSeatRatio } = __internal;

describe("parseSeatRatio (UI tiếng Việt)", () => {
  it("'164/148 người dùng đang sử dụng' → used 164 / total 148 (over-limit hợp lệ)", () => {
    expect(parseSeatRatio("164/148 người dùng đang sử dụng")).toEqual({
      used: 164,
      total: 148,
    });
  });

  it("'Đang dùng 6/8 giấy phép' vẫn hoạt động", () => {
    expect(parseSeatRatio("Đang dùng 6/8 giấy phép")).toEqual({
      used: 6,
      total: 8,
    });
  });

  it("'Using 30/35 seats'", () => {
    expect(parseSeatRatio("Using 30/35 seats")).toEqual({ used: 30, total: 35 });
  });

  it("'正在使用 6/8'", () => {
    expect(parseSeatRatio("正在使用 6/8")).toEqual({ used: 6, total: 8 });
  });

  it("KHÔNG match ngày '5/16/2026'", () => {
    expect(parseSeatRatio("Ngày 5/16/2026")).toBeNull();
  });
});
