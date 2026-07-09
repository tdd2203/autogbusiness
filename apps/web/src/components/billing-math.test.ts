import { describe, expect, it } from "vitest";
import { computeBillingCycle } from "./billing-math";
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
});
