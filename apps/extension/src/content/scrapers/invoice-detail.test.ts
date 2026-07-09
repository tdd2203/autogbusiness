import { describe, expect, it } from "vitest";
import { __internal } from "./invoice-detail";

const {
  parseUnitPrice,
  parseQuantity,
  parseSubtotal,
  parseTotal,
  parsePeriod,
  parseInvoiceNumber,
} = __internal;

// Chuỗi TÁI HIỆN đúng lỗi thực tế (2026-07-06): textContent nối "Số lượng 35"
// với line-total "9.117.500" → "Số lượng 359.117.500"; có "(per seat)" và
// "Tổng không bao gồm thuế"; "Số MSNS6RGC-0024" dính "Ngày".
const REAL_TEXT =
  "Đã thanh toán vào ngày 25 thg 6, 2026 ChatGPT Business Subscription " +
  "(per seat) Số lượng 359.117.500 đ Mỗi 260.500 đ Tổng phụ 9.117.500 đ " +
  "Tổng không bao gồm thuế 9.117.500 đ VAT – Vietnam (10%) 911.750 đ " +
  "Số tiền đến hạn 10.029.250 đ Số tiền đã thanh toán 10.029.250 đ Số tiền còn lại 0 đ " +
  "Số MSNS6RGC-0024 Ngày thanh toán 25 tháng 6, 2026 25 THÁNG 6 - 25 THÁNG 7, 2026";

describe("invoice-detail scraper (regression 2026-07-06)", () => {
  it("đơn giá lấy từ 'Mỗi', KHÔNG dính '(per seat)'", () => {
    expect(parseUnitPrice(REAL_TEXT)).toBe(260500);
  });

  it("subtotal = Tổng phụ (không nhầm 'không bao gồm thuế')", () => {
    expect(parseSubtotal(REAL_TEXT)).toBe(9117500);
  });

  it("total = Số tiền đến hạn", () => {
    expect(parseTotal(REAL_TEXT)).toBe(10029250);
  });

  it("số lượng SUY từ subtotal ÷ unit = 35 (không phải 359 do nối số)", () => {
    expect(parseQuantity(REAL_TEXT, 9117500, 260500)).toBe(35);
  });

  it("số hoá đơn không nuốt 'Ng' của 'Ngày'", () => {
    expect(parseInvoiceNumber(REAL_TEXT)).toBe("MSNS6RGC-0024");
  });

  it("chu kỳ dịch vụ 25/6 → 25/7/2026", () => {
    const p = parsePeriod(REAL_TEXT);
    expect(p.start).toContain("2026-06-25");
    expect(p.end).toContain("2026-07-25");
  });

  it("hoá đơn TRUE-UP: số seat = 'Remaining time on N ×' lớn nhất (148), không có 'Mỗi'", () => {
    // Text tái hiện hoá đơn true-up 0003 (proration, nhiều dòng +/−).
    const trueUp =
      "Đã thanh toán vào ngày 22 thg 6, 2026 Số M96E9GXY-0003 Ghi nhớ Automatically triggered true-up " +
      "21 THÁNG 6 - 11 THÁNG 7, 2026 " +
      "Remaining time on 106 × ChatGPT Business Subscription after 21 Jun 2026 19.015.279 đ Số lượng 106 " +
      "Unused time on 102 × ChatGPT Business Subscription after 21 Jun 2026 -18.297.721 đ Số lượng 102 " +
      "22 THÁNG 6 - 11 THÁNG 7, 2026 " +
      "Remaining time on 148 × ChatGPT Business Subscription after 22 Jun 2026 25.264.502 đ Số lượng 148 " +
      "Unused time on 106 × ChatGPT Business Subscription after 22 Jun 2026 -18.094.846 đ Số lượng 106 " +
      "Tổng phụ 7.887.214 đ Tổng không bao gồm thuế 7.887.214 đ VAT – Vietnam (10%) 788.721 đ " +
      "Số tiền đến hạn 8.675.935 đ Số tiền đã thanh toán 8.675.935 đ";
    // unit_price null (không có 'Mỗi') → quantity suy từ 'Remaining time on N'.
    expect(parseUnitPrice(trueUp)).toBeNull();
    expect(parseQuantity(trueUp, parseSubtotal(trueUp), parseUnitPrice(trueUp))).toBe(148);
    expect(parseSubtotal(trueUp)).toBe(7887214);
    expect(parseTotal(trueUp)).toBe(8675935);
    expect(parseInvoiceNumber(trueUp)).toBe("M96E9GXY-0003");
  });

  it("đơn giá EN 'each' và số lượng suy vẫn hoạt động", () => {
    const en =
      "ChatGPT Business Subscription (per seat) 260,500 đ each Subtotal 1.302.500 đ Amount due 1.432.750 đ";
    expect(parseUnitPrice(en)).toBe(260500);
    expect(parseQuantity(en, 1302500, 260500)).toBe(5);
  });
});
