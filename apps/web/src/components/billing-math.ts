/**
 * Tính giá/seat + chu kỳ billing từ dữ liệu CHÍNH XÁC đọc ở chi tiết hoá đơn
 * (quantity, unit_price_vnd, period_start/period_end) — thay cho logic ĐOÁN cũ
 * (chia tổng tiền cho dải slot 1..10, chặn giá 200–400k) vốn fail với workspace
 * >10 seat / giá cao.
 *
 * Quy tắc (2026-07-06):
 *   - Chỉ tính trên hoá đơn ĐÃ THANH TOÁN (status="paid"). Void/unpaid bị loại.
 *   - renewal_date / cycle_start ưu tiên lấy từ period_end / period_start của hoá
 *     đơn gốc chu kỳ (hoá đơn có period_start MỚI NHẤT). Fallback: renewal_date
 *     của workspace (đoán từ tab Kế hoạch) + cycle_start = renewal − 30 ngày.
 *   - fullMonthPerSlot = unit_price_vnd của hoá đơn gốc chu kỳ (KHÔNG chia tổng).
 *   - todayPrice = round(fullMonthPerSlot × daysRemaining / 30).
 *   - totalSeats = TỔNG cộng dồn quantity của mọi hoá đơn Paid có chi tiết trong
 *     chu kỳ (chốt với người dùng).
 */

import type { BillingInvoice } from "../types";

const CYCLE_DAYS = 30;

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/** cycle_start fallback khi thiếu period: cùng ngày trong tháng, lùi 1 tháng. */
export function cycleStartFromRenewal(renewal: Date): Date {
  const start = new Date(
    Date.UTC(
      renewal.getUTCFullYear(),
      renewal.getUTCMonth() - 1,
      renewal.getUTCDate(),
    ),
  );
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function atUtcMidnight(iso: string): Date {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export type BillingCycle = {
  /** ok = tính được giá; các note khác → hiển thị hint tương ứng. */
  note:
    | "ok"
    | "no_invoices"
    | "no_detail"
    | "no_renewal_date"
    | "cycle_ended";
  renewalDate: Date | null;
  cycleStart: Date | null;
  daysRemaining: number | null;
  /** Hoá đơn Paid thuộc chu kỳ hiện tại (theo period hoặc ngày). */
  cycleInvoices: BillingInvoice[];
  /** Hoá đơn gốc chu kỳ (base cho fullMonthPerSlot). */
  baseInvoice: BillingInvoice | null;
  /** Giá/seat 1 tháng CHƯA VAT (= unit_price_vnd hoá đơn gốc). */
  fullMonthPerSlot: number | null;
  /** Giá/seat 1 tháng GỒM VAT (= total ÷ quantity, chi phí thực trả). */
  fullMonthPerSlotWithVat: number | null;
  /** Thuế suất VAT suy từ hoá đơn gốc (vd 0.1). */
  vatRate: number | null;
  /** Giá/seat hôm nay CHƯA VAT (prorate theo ngày còn lại). */
  todayPrice: number | null;
  /** Giá/seat hôm nay GỒM VAT. */
  todayPriceWithVat: number | null;
  /** Số seat hiện tại (quantity hoá đơn mới nhất trong chu kỳ). */
  totalSeats: number | null;
  /** Tổng ĐÃ CHI trong chu kỳ (gồm VAT) = Σ total của hoá đơn Paid trong chu kỳ. */
  totalCyclePaidWithVat: number | null;
  /** Dự kiến chi phí kỳ sau (gồm VAT) nếu giữ nguyên seat = seats × giá/seat gồm VAT. */
  projectedNextCycleWithVat: number | null;
  /** Số hoá đơn Paid trong chu kỳ đã đọc được chi tiết. */
  detailedCount: number;
};

function isPaid(inv: BillingInvoice): boolean {
  return inv.status === "paid";
}

/** Đọc được chi tiết (có SỐ SEAT). Hoá đơn true-up có quantity nhưng unit=null. */
function hasDetail(inv: BillingInvoice): boolean {
  return inv.detail_scraped === true && inv.quantity != null;
}

/** Hoá đơn có đơn giá/seat rõ ràng (hoá đơn gia hạn/mua đơn giản, không true-up). */
function hasUnitPrice(inv: BillingInvoice): boolean {
  return hasDetail(inv) && inv.unit_price_vnd != null;
}

function invDateMs(inv: BillingInvoice): number {
  const d = new Date(inv.date);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Tính chu kỳ billing từ list hoá đơn + renewal_date của workspace (fallback).
 * `today` cho phép inject để test (mặc định = bây giờ).
 */
export function computeBillingCycle(
  invoices: BillingInvoice[] | null | undefined,
  workspaceRenewalIso: string | null,
  today: Date = new Date(),
): BillingCycle {
  const base: BillingCycle = {
    note: "no_invoices",
    renewalDate: null,
    cycleStart: null,
    daysRemaining: null,
    cycleInvoices: [],
    baseInvoice: null,
    fullMonthPerSlot: null,
    fullMonthPerSlotWithVat: null,
    vatRate: null,
    todayPrice: null,
    todayPriceWithVat: null,
    totalSeats: null,
    totalCyclePaidWithVat: null,
    projectedNextCycleWithVat: null,
    detailedCount: 0,
  };

  const paid = (invoices ?? []).filter(isPaid);
  if ((invoices ?? []).length === 0) return base;
  if (paid.length === 0) return { ...base, note: "no_detail" };

  const todayMid = new Date(today);
  todayMid.setUTCHours(0, 0, 0, 0);

  // 1) Xác định renewal / cycle_start.
  const detailWithPeriod = paid.filter(
    (inv) => hasDetail(inv) && inv.period_start && inv.period_end,
  );
  let renewalDate: Date | null = null;
  let cycleStart: Date | null = null;
  if (detailWithPeriod.length > 0) {
    // renewal = period_end gần nhất TRONG TƯƠNG LAI (chu kỳ hiện tại); nếu mọi
    // period_end đã qua → lấy period_end lớn nhất (sẽ rơi vào nhánh cycle_ended).
    const ends = detailWithPeriod.map((inv) =>
      atUtcMidnight(inv.period_end as string).getTime(),
    );
    const future = ends.filter((t) => t > todayMid.getTime());
    const renewalMs =
      future.length > 0 ? Math.min(...future) : Math.max(...ends);
    renewalDate = new Date(renewalMs);
    // cycle_start = period_start SỚM NHẤT trong các hoá đơn cùng period_end (hoá
    // đơn add-seat giữa kỳ có period_start muộn hơn nhưng cùng chu kỳ).
    const sameEnd = detailWithPeriod.filter(
      (inv) => atUtcMidnight(inv.period_end as string).getTime() === renewalMs,
    );
    cycleStart = new Date(
      Math.min(
        ...sameEnd.map((inv) => atUtcMidnight(inv.period_start as string).getTime()),
      ),
    );
  } else if (workspaceRenewalIso) {
    renewalDate = atUtcMidnight(workspaceRenewalIso);
    cycleStart = cycleStartFromRenewal(renewalDate);
  } else {
    return { ...base, note: "no_renewal_date" };
  }

  const daysRemaining = daysBetween(todayMid, renewalDate);
  if (daysRemaining <= 0) {
    return {
      ...base,
      note: "cycle_ended",
      renewalDate,
      cycleStart,
      daysRemaining,
    };
  }

  // 2) Hoá đơn thuộc chu kỳ: cycle_start ≤ ngày HĐ < renewal.
  const cycleInvoices = paid.filter((inv) => {
    const d = atUtcMidnight(inv.date);
    return (
      d.getTime() >= (cycleStart as Date).getTime() &&
      d.getTime() < renewalDate.getTime()
    );
  });

  // 3) Base invoice cho giá full-month: hoá đơn có chi tiết, period_start ==
  //    cycle_start; nếu không có, hoá đơn có chi tiết period_start sớm nhất.
  const detailInCycle = cycleInvoices.filter(hasDetail);
  let baseInvoice: BillingInvoice | null = null;
  // Base cho GIÁ/seat = hoá đơn gia hạn gốc kỳ: chỉ xét hoá đơn CÓ đơn giá
  // (loại true-up unit=null); ưu tiên period_start == cycle_start, không thì
  // period_start sớm nhất.
  const withUnit = detailInCycle.filter(hasUnitPrice);
  if (withUnit.length > 0) {
    const onStart = withUnit.filter(
      (inv) =>
        inv.period_start &&
        atUtcMidnight(inv.period_start).getTime() ===
          (cycleStart as Date).getTime(),
    );
    const pool = onStart.length > 0 ? onStart : withUnit;
    baseInvoice = pool.reduce((a, b) => {
      const da = a.period_start
        ? atUtcMidnight(a.period_start).getTime()
        : atUtcMidnight(a.date).getTime();
      const db = b.period_start
        ? atUtcMidnight(b.period_start).getTime()
        : atUtcMidnight(b.date).getTime();
      return db < da ? b : a;
    });
  }

  if (!baseInvoice || baseInvoice.unit_price_vnd == null) {
    // Có hoá đơn Paid trong chu kỳ nhưng chưa đọc được đơn giá → không đoán.
    return {
      ...base,
      note: "no_detail",
      renewalDate,
      cycleStart,
      daysRemaining,
      cycleInvoices,
    };
  }

  const fullMonthPerSlot = baseInvoice.unit_price_vnd;
  // Giá/seat GỒM VAT = chi phí thực trả 1 seat. Ưu tiên total ÷ quantity (chính
  // xác nhất); nếu thiếu, nhân thuế suất suy từ vat ÷ subtotal (mặc định 10%).
  const vatRate =
    baseInvoice.vat_vnd != null && baseInvoice.subtotal_vnd
      ? baseInvoice.vat_vnd / baseInvoice.subtotal_vnd
      : 0.1;
  let fullMonthPerSlotWithVat: number;
  if (baseInvoice.total_vnd != null && baseInvoice.quantity) {
    fullMonthPerSlotWithVat = Math.round(
      baseInvoice.total_vnd / baseInvoice.quantity,
    );
  } else {
    fullMonthPerSlotWithVat = Math.round(fullMonthPerSlot * (1 + vatRate));
  }
  const todayPrice = Math.round((fullMonthPerSlot * daysRemaining) / CYCLE_DAYS);
  const todayPriceWithVat = Math.round(
    (fullMonthPerSlotWithVat * daysRemaining) / CYCLE_DAYS,
  );
  // Tổng seat chu kỳ = SỐ SEAT HIỆN TẠI = quantity của hoá đơn MỚI NHẤT trong
  // chu kỳ (true-up ghi số seat mới nhất). KHÔNG cộng dồn (proration ghi tổng
  // mới, không phải delta). Khớp số seat ở tab Kế hoạch.
  const seatInvoices = detailInCycle.filter((inv) => inv.quantity != null);
  const latestSeatInv = seatInvoices.reduce<BillingInvoice | null>((a, b) => {
    if (!a) return b;
    const da = invDateMs(a);
    const db = invDateMs(b);
    if (db > da) return b;
    if (db === da && (b.quantity ?? 0) > (a.quantity ?? 0)) return b;
    return a;
  }, null);
  const totalSeats = latestSeatInv?.quantity ?? null;

  // Tổng ĐÃ CHI trong chu kỳ (gồm VAT) = Σ total (ưu tiên total_vnd, fallback
  // amount_vnd) của mọi hoá đơn Paid thuộc chu kỳ.
  const totalCyclePaidWithVat = cycleInvoices.reduce(
    (sum, inv) => sum + (inv.total_vnd ?? inv.amount_vnd ?? 0),
    0,
  );
  // Dự kiến kỳ sau (gồm VAT) nếu giữ nguyên seat hiện tại.
  const projectedNextCycleWithVat =
    totalSeats != null ? totalSeats * fullMonthPerSlotWithVat : null;

  return {
    note: "ok",
    renewalDate,
    cycleStart,
    daysRemaining,
    cycleInvoices,
    baseInvoice,
    fullMonthPerSlot,
    fullMonthPerSlotWithVat,
    vatRate,
    todayPrice,
    todayPriceWithVat,
    totalSeats,
    totalCyclePaidWithVat,
    projectedNextCycleWithVat,
    detailedCount: detailInCycle.length,
  };
}
