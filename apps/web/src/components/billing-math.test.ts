import { describe, expect, it } from "vitest";
import { computeBillingCycle, invoiceSeatPricing } from "./billing-math";
import type { BillingInvoice } from "../types";

// "Hôm nay" cố định để test ổn định: 2026-07-05 (còn 20 ngày tới 25/7).
const TODAY = new Date("2026-07-05T00:00:00Z");

function baseInvoice(over: Partial<BillingInvoice> = {}): BillingInvoice {
  return {
    date: "2026-06-25T00:00:00Z",
    amount_vnd: 10029250,
    status: "paid",
    detail_scraped: true,
    quantity: 35,
    unit_price_vnd: 260500,
    subtotal_vnd: 9117500,
    vat_vnd: 911750,
    total_vnd: 10029250,
    period_start: "2026-06-25T00:00:00Z",
    period_end: "2026-07-25T00:00:00Z",
    invoice_number: "MSNS6RGC-0024",
    ...over,
  };
}

describe("computeBillingCycle", () => {
  it("workspace 35 seat: giá & renew đọc thẳng từ chi tiết (không đoán, không chặn range)", () => {
    const c = computeBillingCycle([baseInvoice()], null, TODAY);
    expect(c.note).toBe("ok");
    expect(c.fullMonthPerSlot).toBe(260500); // > 400k range cũ vẫn OK? 260500 < 400k nhưng seat 35 > cap 10
    expect(c.totalSeats).toBe(35);
    expect(c.renewalDate?.toISOString()).toContain("2026-07-25");
    expect(c.cycleStart?.toISOString()).toContain("2026-06-25");
    expect(c.daysRemaining).toBe(20);
    // today price (chưa VAT) = 260500 * 20/30 ≈ 173667
    expect(c.todayPrice).toBe(Math.round((260500 * 20) / 30));
    // GỒM VAT: 10029250 / 35 = 286550/seat; VAT 10%
    expect(c.fullMonthPerSlotWithVat).toBe(286550);
    expect(c.vatRate).toBeCloseTo(0.1, 5);
    expect(c.todayPriceWithVat).toBe(Math.round((286550 * 20) / 30));
  });

  it("giá/seat cao ngoài range cũ (500k) vẫn hiển thị đúng", () => {
    const c = computeBillingCycle(
      [baseInvoice({ unit_price_vnd: 500000, quantity: 100 })],
      null,
      TODAY,
    );
    expect(c.note).toBe("ok");
    expect(c.fullMonthPerSlot).toBe(500000);
    expect(c.totalSeats).toBe(100);
  });

  it("hoá đơn true-up ghi tổng seat mới → totalSeats = seat mới nhất (KHÔNG cộng dồn)", () => {
    // True-up: quantity = 'Remaining time on 40 ×' (tổng seat mới), unit=null.
    const trueUp: BillingInvoice = {
      date: "2026-07-01T00:00:00Z",
      amount_vnd: 1200000,
      status: "paid",
      detail_scraped: true,
      quantity: 40,
      unit_price_vnd: null,
      subtotal_vnd: 1090909,
      vat_vnd: 109091,
      total_vnd: 1200000,
      period_start: "2026-07-01T00:00:00Z",
      period_end: "2026-07-25T00:00:00Z",
      invoice_number: "TRUEUP-1",
    };
    const c = computeBillingCycle([baseInvoice(), trueUp], null, TODAY);
    expect(c.note).toBe("ok");
    expect(c.totalSeats).toBe(40); // seat hiện tại (mới nhất), KHÔNG phải 35+40
    // giá base vẫn lấy từ hoá đơn gốc kỳ (25/6) có đơn giá
    expect(c.fullMonthPerSlot).toBe(260500);
    expect(c.fullMonthPerSlotWithVat).toBe(286550);
    // Tổng đã chi = Σ total 2 hoá đơn (gồm VAT).
    expect(c.totalCyclePaidWithVat).toBe(10029250 + 1200000);
    // Dự kiến kỳ sau = seat hiện tại × giá/seat gồm VAT.
    expect(c.projectedNextCycleWithVat).toBe(40 * 286550);
  });

  it("hoá đơn void bị loại khỏi tính giá/seat", () => {
    const voided = baseInvoice({
      status: "void",
      amount_vnd: 88070400,
      quantity: 300,
      unit_price_vnd: 260500,
    });
    const c = computeBillingCycle([baseInvoice(), voided], null, TODAY);
    expect(c.note).toBe("ok");
    expect(c.totalSeats).toBe(35); // void không cộng
  });

  it("hoá đơn chưa đọc chi tiết → note no_detail, không đoán", () => {
    const noDetail: BillingInvoice = {
      date: "2026-06-25T00:00:00Z",
      amount_vnd: 10029250,
      status: "paid",
      detail_scraped: false,
    };
    const c = computeBillingCycle([noDetail], "2026-07-25T00:00:00Z", TODAY);
    expect(c.note).toBe("no_detail");
    expect(c.fullMonthPerSlot).toBeNull();
    expect(c.todayPrice).toBeNull();
  });

  it("mix có/không chi tiết: chỉ tính hoá đơn có chi tiết", () => {
    const noDetail: BillingInvoice = {
      date: "2026-07-02T00:00:00Z",
      amount_vnd: 500000,
      status: "paid",
      detail_scraped: false,
    };
    const c = computeBillingCycle([baseInvoice(), noDetail], null, TODAY);
    expect(c.note).toBe("ok");
    expect(c.totalSeats).toBe(35); // hoá đơn thiếu chi tiết không cộng
    expect(c.fullMonthPerSlot).toBe(260500);
  });

  it("gia hạn kèm proration + chu kỳ 31 ngày: giá/seat gồm VAT = đơn giá×1.1, 'thêm 1 seat' ≤ trọn tháng", () => {
    // Hoá đơn 0005: total gồm proration (+100.843đ) → total÷qty = 287.157 (SAI).
    // Đúng: 260.500×1.1 = 286.550. Chu kỳ 11/7→11/8 = 31 ngày (không phải 30).
    const renew = baseInvoice({
      date: "2026-07-11T00:00:00Z",
      amount_vnd: 52549578,
      quantity: 183,
      unit_price_vnd: 260500,
      subtotal_vnd: 47772343,
      vat_vnd: 4777235,
      total_vnd: 52549578,
      period_start: "2026-07-11T00:00:00Z",
      period_end: "2026-08-11T00:00:00Z",
      invoice_number: "M96E9GXY-0005",
    });
    // Hôm nay = ngày đầu chu kỳ 11/7 → còn đúng 31 ngày.
    const c = computeBillingCycle([renew], null, new Date("2026-07-11T00:00:00Z"));
    expect(c.note).toBe("ok");
    expect(c.fullMonthPerSlot).toBe(260500);
    expect(c.fullMonthPerSlotWithVat).toBe(286550); // KHÔNG phải 287157
    // Thêm 1 seat với 31/31 ngày = đúng trọn tháng, KHÔNG vượt (296728 cũ là sai).
    expect(c.todayPrice).toBe(260500);
    expect(c.todayPriceWithVat).toBe(286550);
    // Tổng đã chi giữ nguyên số tiền THỰC của hoá đơn (gồm proration).
    expect(c.totalCyclePaidWithVat).toBe(52549578);
  });

  it("phí ngân hàng nhập tay cộng vào tổng thực trả (gồm phí)", () => {
    const withFee = baseInvoice({ service_fee_vnd: 578045 });
    const c = computeBillingCycle([withFee], null, TODAY);
    expect(c.note).toBe("ok");
    expect(c.totalCyclePaidWithVat).toBe(10029250);
    expect(c.totalCycleFees).toBe(578045);
    expect(c.totalCyclePaidWithFees).toBe(10029250 + 578045);
  });

  it("không có phí → totalCycleFees = 0, thực trả = tổng gồm VAT", () => {
    const c = computeBillingCycle([baseInvoice()], null, TODAY);
    expect(c.totalCycleFees).toBe(0);
    expect(c.totalCyclePaidWithFees).toBe(c.totalCyclePaidWithVat);
  });

  it("giá/seat gồm phí = giá gồm VAT + phí NH ÷ số seat", () => {
    // 35 seat, phí NH 578.045 → phí/seat = round(578045/35) = 16516.
    const c = computeBillingCycle(
      [baseInvoice({ service_fee_vnd: 578045 })],
      null,
      TODAY,
    );
    expect(c.feePerSeat).toBe(Math.round(578045 / 35));
    expect(c.fullMonthPerSlotWithFee).toBe(286550 + Math.round(578045 / 35));
  });

  it("không có phí → feePerSeat = 0, giá gồm phí = giá gồm VAT", () => {
    const c = computeBillingCycle([baseInvoice()], null, TODAY);
    expect(c.feePerSeat).toBe(0);
    expect(c.fullMonthPerSlotWithFee).toBe(c.fullMonthPerSlotWithVat);
  });

  it("todayPriceWithFee = giá tháng (gồm VAT + phí) ÷ 30 × ngày còn lại", () => {
    const c = computeBillingCycle(
      [baseInvoice({ service_fee_vnd: 578045 })],
      null,
      TODAY, // còn 20 ngày
    );
    const monthly = 286550 + Math.round(578045 / 35);
    expect(c.fullMonthPerSlotWithFee).toBe(monthly);
    expect(c.todayPriceWithFee).toBe(Math.round((monthly * 20) / 30));
  });

  it("todayPrice prorate mẫu số 30 + kẹp 30 ngày (chu kỳ 31 ngày không vượt giá tháng)", () => {
    const renew = baseInvoice({
      date: "2026-07-11T00:00:00Z",
      period_start: "2026-07-11T00:00:00Z",
      period_end: "2026-08-11T00:00:00Z",
    });
    const c = computeBillingCycle([renew], null, new Date("2026-07-11T00:00:00Z"));
    expect(c.daysRemaining).toBe(31);
    expect(c.todayPrice).toBe(260500); // min(31,30)/30 = 1 → đúng giá tháng
    expect(c.todayPriceWithVat).toBe(286550);
    expect(c.todayPriceWithFee).toBe(286550);
  });

  describe("invoiceSeatPricing (mỗi hoá đơn tính riêng)", () => {
    it("giá tháng = đơn giá×VAT + phí/seat; ngày còn lại ÷30 (từ hôm nay → renew)", () => {
      const p = invoiceSeatPricing(
        baseInvoice({ service_fee_vnd: 578045 }),
        TODAY,
      );
      const monthly = 286550 + Math.round(578045 / 35);
      expect(p.monthlyPerSeat).toBe(monthly);
      expect(p.daysRemaining).toBe(20);
      expect(p.remainingPerSeat).toBe(Math.round((monthly * 20) / 30));
    });

    it("chu kỳ 31 ngày: ngày còn lại kẹp ≤ giá tháng (không vượt)", () => {
      const p = invoiceSeatPricing(
        baseInvoice({
          period_start: "2026-07-11T00:00:00Z",
          period_end: "2026-08-11T00:00:00Z",
        }),
        new Date("2026-07-11T00:00:00Z"),
      );
      expect(p.daysRemaining).toBe(31);
      expect(p.remainingPerSeat).toBe(p.monthlyPerSeat);
    });

    it("thiếu đơn giá/seat → null; hoá đơn hết hạn → remaining null", () => {
      expect(invoiceSeatPricing(baseInvoice({ unit_price_vnd: null }), TODAY)
        .monthlyPerSeat).toBeNull();
      // period_end đã qua so với TODAY (2026-07-05)
      const expired = invoiceSeatPricing(
        baseInvoice({ period_end: "2026-06-25T00:00:00Z" }),
        TODAY,
      );
      expect(expired.monthlyPerSeat).toBe(286550);
      expect(expired.remainingPerSeat).toBeNull();
    });

    it("tỉ giá khác nhau → giá tháng khác nhau (đơn giá đã gồm tỉ giá)", () => {
      const cheap = invoiceSeatPricing(baseInvoice({ unit_price_vnd: 255000 }), TODAY);
      const pricey = invoiceSeatPricing(baseInvoice({ unit_price_vnd: 268000 }), TODAY);
      expect(cheap.monthlyPerSeat).toBe(Math.round(255000 * 1.1));
      expect(pricey.monthlyPerSeat).toBe(Math.round(268000 * 1.1));
    });
  });

  it("không hoá đơn nào → no_invoices", () => {
    expect(computeBillingCycle([], null, TODAY).note).toBe("no_invoices");
  });

  it("chu kỳ đã kết thúc (renew đã qua) → cycle_ended", () => {
    const past = baseInvoice({
      period_start: "2026-05-25T00:00:00Z",
      period_end: "2026-06-25T00:00:00Z",
      date: "2026-05-25T00:00:00Z",
    });
    const c = computeBillingCycle([past], null, TODAY);
    expect(c.note).toBe("cycle_ended");
  });

  it("fallback renewal_date của workspace khi hoá đơn thiếu period nhưng có qty/giá", () => {
    const noPeriod = baseInvoice({ period_start: null, period_end: null });
    const c = computeBillingCycle([noPeriod], "2026-07-25T00:00:00Z", TODAY);
    expect(c.note).toBe("ok");
    expect(c.renewalDate?.toISOString()).toContain("2026-07-25");
    expect(c.fullMonthPerSlot).toBe(260500);
  });

  describe("chu kỳ chuẩn = tab Kế hoạch (workspaceRenewalIso ưu tiên)", () => {
    it("renewal tab Kế hoạch (25/8) ĐÈ period hoá đơn kỳ trước (25/7)", () => {
      // Hoá đơn chu kỳ mới 25/7→25/8 đã lên. Plan renewal = 25/8.
      const cur = baseInvoice({
        date: "2026-07-25T00:00:00Z",
        quantity: 46,
        subtotal_vnd: 14188380,
        vat_vnd: 1418838,
        total_vnd: 15607218,
        amount_vnd: 15607218,
        period_start: "2026-07-25T00:00:00Z",
        period_end: "2026-08-25T00:00:00Z",
        invoice_number: "MSNS6RGC-0025",
      });
      const c = computeBillingCycle(
        [baseInvoice(), cur],
        "2026-08-25T00:00:00Z",
        new Date("2026-07-25T00:00:00Z"),
        46,
      );
      expect(c.note).toBe("ok");
      expect(c.estimated).toBe(false);
      expect(c.renewalDate?.toISOString()).toContain("2026-08-25");
      expect(c.cycleStart?.toISOString()).toContain("2026-07-25");
      expect(c.totalSeats).toBe(46);
      expect(c.fullMonthPerSlotWithVat).toBe(286550);
      // Chỉ hoá đơn 25/7 thuộc chu kỳ → tổng chi = total của nó, KHÔNG gồm 25/6.
      expect(c.totalCyclePaidWithVat).toBe(15607218);
      expect(c.projectedNextCycleWithVat).toBe(46 * 286550);
    });

    it("ĐÚNG NGÀY RENEW, chu kỳ mới CHƯA có hoá đơn → ước tính từ giá kỳ trước × seat hiện tại", () => {
      // Chỉ có hoá đơn kỳ trước (25/6→25/7). Plan đã cuộn sang 25/7→25/8. seat=46.
      const c = computeBillingCycle(
        [baseInvoice()], // period 25/6→25/7, unit 260500, qty 35
        "2026-08-25T00:00:00Z",
        new Date("2026-07-25T00:00:00Z"),
        46,
      );
      expect(c.note).toBe("estimated");
      expect(c.estimated).toBe(true);
      expect(c.renewalDate?.toISOString()).toContain("2026-08-25");
      expect(c.cycleStart?.toISOString()).toContain("2026-07-25");
      expect(c.daysRemaining).toBe(31);
      expect(c.fullMonthPerSlot).toBe(260500);
      expect(c.fullMonthPerSlotWithVat).toBe(286550);
      // Số seat cho dự kiến = seat HIỆN TẠI (46), KHÔNG phải qty kỳ trước (35).
      expect(c.totalSeats).toBe(46);
      expect(c.projectedNextCycleWithVat).toBe(46 * 286550);
      // Chu kỳ mới chưa có hoá đơn → chưa chi.
      expect(c.totalCyclePaidWithVat).toBe(0);
    });

    it("ước tính dùng qty kỳ trước khi KHÔNG truyền seatCount", () => {
      const c = computeBillingCycle(
        [baseInvoice()],
        "2026-08-25T00:00:00Z",
        new Date("2026-07-25T00:00:00Z"),
      );
      expect(c.note).toBe("estimated");
      expect(c.totalSeats).toBe(35); // qty hoá đơn kỳ trước
      expect(c.projectedNextCycleWithVat).toBe(35 * 286550);
    });

    it("chu kỳ mới rỗng & KHÔNG có hoá đơn kỳ trước đọc được giá → no_detail (không đoán)", () => {
      const noDetail: BillingInvoice = {
        date: "2026-06-25T00:00:00Z",
        amount_vnd: 10029250,
        status: "paid",
        detail_scraped: false,
      };
      const c = computeBillingCycle(
        [noDetail],
        "2026-08-25T00:00:00Z",
        new Date("2026-07-25T00:00:00Z"),
        46,
      );
      expect(c.note).toBe("no_detail");
      expect(c.estimated).toBe(false);
    });
  });
});
