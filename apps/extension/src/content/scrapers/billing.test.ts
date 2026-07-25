import { describe, expect, it } from "vitest";
import { __internal } from "./billing";

const { parseSeatRatio, parseRenewalDateVi } = __internal;

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

describe("parseRenewalDateVi (chu kỳ = ngày KẾT THÚC 'Current cycle')", () => {
  it("VI 'Chu kỳ hiện tại: 25 thg 7 - 25 thg 8' → renew = 25/8", () => {
    const iso = parseRenewalDateVi("Chu kỳ hiện tại: 25 thg 7 - 25 thg 8, 2026");
    expect(iso).toContain("2026-08-25");
  });

  it("EN 'Current cycle: Jul 25 - Aug 25, 2026' → renew = 25/8 (END của range)", () => {
    const iso = parseRenewalDateVi("Current cycle: Jul 25 - Aug 25, 2026");
    expect(iso).toContain("2026-08-25");
  });

  it("EN dạng gạch ngang dài + không năm vẫn lấy END (May 11 – Jun 11)", () => {
    const iso = parseRenewalDateVi("Current cycle: May 11 – Jun 11");
    // END = 11 tháng 6 (năm suy tương lai) → ngày & tháng đúng.
    expect(iso).toMatch(/-06-11T/);
  });

  it("ZH '2026年7月25日 - 2026年8月25日' → renew = 25/8", () => {
    const iso = parseRenewalDateVi("当前周期：2026年7月25日 - 2026年8月25日");
    expect(iso).toContain("2026-08-25");
  });
});
