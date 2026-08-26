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

  // ── NĂM IN SẴN LUÔN THẮNG PHÉP SUY NĂM ────────────────────────────────────
  // Suy năm ("đã qua → +1 năm") chỉ dành cho trang KHÔNG in năm. Trang có in mà
  // vẫn suy thì đúng NGÀY GIA HẠN (chu kỳ vừa kết thúc hôm qua) ngày renew bị
  // đẩy vọt sang năm sau — dashboard tính giá/kỳ theo con số đó. Dùng năm quá
  // khứ để test KHÔNG phụ thuộc hôm nay là ngày nào.
  it("VI có năm in sẵn (kể cả đã qua) → giữ nguyên năm đó, KHÔNG suy sang năm sau", () => {
    expect(parseRenewalDateVi("Chu kỳ hiện tại: 25 thg 7 - 25 thg 8, 2024")).toContain(
      "2024-08-25",
    );
    expect(parseRenewalDateVi("Chu kỳ hiện tại: 25 thg 7 - 25 thg 8 năm 2024")).toContain(
      "2024-08-25",
    );
  });

  it("ZH có năm in sẵn (kể cả đã qua) → giữ nguyên năm đó", () => {
    expect(parseRenewalDateVi("当前周期：2024年7月25日 - 2024年8月25日")).toContain(
      "2024-08-25",
    );
  });

  it("ZH KHÔNG in năm → vẫn suy năm tương lai như cũ", () => {
    const iso = parseRenewalDateVi("当前周期：7月25日 - 8月25日");
    expect(iso).toMatch(/-08-25T/);
    expect(new Date(iso!).getTime()).toBeGreaterThanOrEqual(
      new Date(new Date().toISOString().slice(0, 10)).getTime(),
    );
  });

  it("ZH năm chỉ in ở vế ĐẦU, chu kỳ vắt qua giao thừa → KHÔNG mượn năm vế đầu", () => {
    // Mượn 2026 cho ngày 25/1 là lùi 11 tháng. Thiếu năm ở vế sau ⇒ suy tương lai.
    const iso = parseRenewalDateVi("当前周期：2026年12月25日 - 1月25日");
    expect(iso).toMatch(/-01-25T/);
    expect(iso).not.toContain("2026-01-25");
  });
});
