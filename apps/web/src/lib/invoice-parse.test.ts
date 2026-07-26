import { describe, expect, it } from "vitest";
import { parseInvoiceText, isParsedInvoiceUsable } from "./invoice-parse";

// Text DÁN thực tế người dùng copy từ panel chi tiết hoá đơn Stripe (có xuống
// dòng → số TÁCH nhau, khác DOM dính liền). Rút gọn còn vài dòng proration + dòng
// chính "(per seat)" + phần tổng — đủ tái hiện định dạng.
const PASTED = `Đã thanh toán vào ngày 25 thg 7, 2026
Số hóa đơn MSNS6RGC-0025
1 tháng 7 - 25 tháng 7, 2026
Remaining time on 39 × ChatGPT Business Subscription after 01 Jul 2026
Số lượng 39
8.157.730 ₫
Unused time on 35 × ChatGPT Business Subscription after 01 Jul 2026
Số lượng 35
-7.321.039 ₫
13 tháng 7 - 25 tháng 7, 2026
Remaining time on 52 × ChatGPT Business Subscription after 13 Jul 2026
Số lượng 52
5.458.573 ₫
Unused time on 51 × ChatGPT Business Subscription after 13 Jul 2026
Số lượng 51
-5.353.600 ₫
25 tháng 7 - 25 tháng 8, 2026
ChatGPT Business Subscription (per seat)
Số lượng 46
11.983.000 ₫
Mỗi 260.500 ₫
Tổng phụ
14.188.380 ₫
Tổng không bao gồm thuế
14.188.380 ₫
VAT – Vietnam (10%)
1.418.838 ₫
Số tiền đến hạn
15.607.218 ₫
Số tiền đã thanh toán
15.607.218 ₫`;

describe("parseInvoiceText (text DÁN có khoảng trắng)", () => {
  const p = parseInvoiceText(PASTED);

  it("số seat = 46 (dòng '(per seat)'), KHÔNG phải 54 (subtotal÷đơn giá)", () => {
    expect(p.quantity).toBe(46);
  });
  it("đơn giá = 260.500", () => {
    expect(p.unit_price_vnd).toBe(260500);
  });
  it("subtotal = 14.188.380, tổng = 15.607.218, VAT = 1.418.838", () => {
    expect(p.subtotal_vnd).toBe(14188380);
    expect(p.total_vnd).toBe(15607218);
    expect(p.vat_vnd).toBe(1418838);
  });
  it("chu kỳ 25/7 → 25/8/2026", () => {
    expect(p.period_start).toContain("2026-07-25");
    expect(p.period_end).toContain("2026-08-25");
  });
  it("ngày thanh toán 25/7, số hoá đơn, amount = total, usable", () => {
    expect(p.date).toContain("2026-07-25");
    expect(p.invoice_number).toBe("MSNS6RGC-0025");
    expect(p.amount_vnd).toBe(15607218);
    expect(p.status).toBe("paid");
    expect(isParsedInvoiceUsable(p)).toBe(true);
  });
});
