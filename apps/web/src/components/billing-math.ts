/**
 * Tính giá/seat + chu kỳ billing từ dữ liệu CHÍNH XÁC đọc ở chi tiết hoá đơn
 * (quantity, unit_price_vnd, period_start/period_end) — thay cho logic ĐOÁN cũ
 * (chia tổng tiền cho dải slot 1..10, chặn giá 200–400k) vốn fail với workspace
 * >10 seat / giá cao.
 *
 * Quy tắc (2026-07-06, cập nhật 2026-07-25):
 *   - Chỉ tính trên hoá đơn ĐÃ THANH TOÁN (status="paid"). Void/unpaid bị loại.
 *   - CHU KỲ CHUẨN = "Current cycle" tab Kế hoạch (workspaceRenewalIso = ngày kết
 *     thúc). ƯU TIÊN nguồn này; period hoá đơn chỉ TINH CHỈNH cycle_start (hoá đơn
 *     add-seat cùng renewal) hoặc DỰ PHÒNG khi tab Kế hoạch không cho renewal.
 *     cycle_start = renewal − 1 tháng lịch.
 *   - Chu kỳ mới CHƯA có hoá đơn (đúng ngày renew) → ƯỚC TÍNH (note="estimated")
 *     theo giá/seat hoá đơn gốc chu kỳ TRƯỚC × số seat hiện tại (seatCount).
 *   - fullMonthPerSlot = unit_price_vnd của hoá đơn gốc chu kỳ (KHÔNG chia tổng).
 *   - fullMonthPerSlotWithVat = unit_price × (1+VAT) — KHÔNG lấy total÷qty (total
 *     hoá đơn gia hạn gồm proration nên bị đội lên).
 *   - todayPrice = round(fullMonthPerSlot × ngày_còn_lại / ĐỘ_DÀI_CHU_KỲ_THẬT),
 *     độ dài = renewal − cycle_start (28/30/31, KHÔNG hard-code 30); kẹp ≤ trọn tháng.
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
    // Chu kỳ mới CHƯA có hoá đơn nào (đúng ngày renew, hoá đơn mới chưa lên) →
    // ước tính giá/dự kiến từ giá/seat chu kỳ TRƯỚC × số seat hiện tại.
    | "estimated"
    | "no_invoices"
    | "no_detail"
    | "no_renewal_date"
    | "cycle_ended";
  /** true khi giá/dự kiến là ƯỚC TÍNH từ chu kỳ trước (note="estimated"). */
  estimated: boolean;
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
  /** Phí ngân hàng phân bổ trên 1 seat (= tổng phí chu kỳ ÷ số seat ĐÃ TRẢ PHÍ). */
  feePerSeat: number | null;
  /** Số seat ĐÃ TRẢ PHÍ = Σ quantity của hoá đơn có phí NH (mẫu số của feePerSeat).
   * Khác totalSeats (seat đang dùng): phí NH tính trên số seat trên hoá đơn. */
  feeSeats: number | null;
  /** Giá/seat 1 tháng GỒM VAT + phí ngân hàng phân bổ (chi phí thật/seat). */
  fullMonthPerSlotWithFee: number | null;
  /** Thuế suất VAT suy từ hoá đơn gốc (vd 0.1). */
  vatRate: number | null;
  /** Giá/seat hôm nay CHƯA VAT (prorate theo ngày còn lại, mẫu số 30). */
  todayPrice: number | null;
  /** Giá/seat hôm nay GỒM VAT. */
  todayPriceWithVat: number | null;
  /** Giá/seat hôm nay GỒM VAT + phí NH (prorate ngày còn lại ÷ 30, kẹp ≤ giá tháng). */
  todayPriceWithFee: number | null;
  /** Số seat hiện tại (quantity hoá đơn mới nhất trong chu kỳ). */
  totalSeats: number | null;
  /** Tổng ĐÃ CHI trong chu kỳ (gồm VAT) = Σ total của hoá đơn Paid trong chu kỳ. */
  totalCyclePaidWithVat: number | null;
  /** Tổng PHÍ ngân hàng (nhập tay) của hoá đơn trong chu kỳ. */
  totalCycleFees: number | null;
  /** Tổng THỰC TRẢ chu kỳ = totalCyclePaidWithVat + tổng phí ngân hàng. */
  totalCyclePaidWithFees: number | null;
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
 * Hoá đơn GỐC chu kỳ TRƯỚC — dùng làm giá/seat ước tính khi chu kỳ hiện tại chưa
 * có hoá đơn. Ưu tiên hoá đơn có đơn giá + period_end ≤ cycle_start (kết thúc
 * trước/đúng đầu chu kỳ hiện tại = thuộc kỳ trước), chọn period_end MUỘN NHẤT
 * (kỳ liền trước). Fallback: hoá đơn có đơn giá, NGÀY < cycle_start, mới nhất.
 */
function findPreviousCycleBase(
  paid: BillingInvoice[],
  cycleStart: Date,
): BillingInvoice | null {
  const cs = cycleStart.getTime();
  const withEnd = paid.filter(
    (inv) =>
      hasUnitPrice(inv) &&
      inv.period_end &&
      atUtcMidnight(inv.period_end).getTime() <= cs,
  );
  if (withEnd.length > 0) {
    return withEnd.reduce((a, b) =>
      atUtcMidnight(b.period_end as string).getTime() >
      atUtcMidnight(a.period_end as string).getTime()
        ? b
        : a,
    );
  }
  const before = paid.filter((inv) => hasUnitPrice(inv) && invDateMs(inv) < cs);
  if (before.length === 0) return null;
  return before.reduce((a, b) => (invDateMs(b) > invDateMs(a) ? b : a));
}

/** Số seat của hoá đơn có chi tiết MỚI NHẤT trong danh sách (quantity != null).
 * Dùng khi cần seat từ hoá đơn nhưng không lấy được giá base. null nếu rỗng. */
function latestCycleSeat(detailInCycle: BillingInvoice[]): number | null {
  const withQty = detailInCycle.filter((inv) => inv.quantity != null);
  if (withQty.length === 0) return null;
  const latest = withQty.reduce((a, b) => {
    const da = invDateMs(a);
    const db = invDateMs(b);
    if (db > da) return b;
    if (db === da && (b.quantity ?? 0) > (a.quantity ?? 0)) return b;
    return a;
  });
  return latest.quantity ?? null;
}

/**
 * Tính chu kỳ billing từ list hoá đơn + renewal_date của workspace (fallback).
 * `today` cho phép inject để test (mặc định = bây giờ).
 */
export function computeBillingCycle(
  invoices: BillingInvoice[] | null | undefined,
  workspaceRenewalIso: string | null,
  today: Date = new Date(),
  /** Số seat HIỆN TẠI (từ tab Kế hoạch) — dùng cho dự kiến/ước tính khi chu kỳ
   * mới chưa có hoá đơn. Bỏ trống → suy từ quantity hoá đơn. */
  seatCount: number | null = null,
): BillingCycle {
  const base: BillingCycle = {
    note: "no_invoices",
    estimated: false,
    renewalDate: null,
    cycleStart: null,
    daysRemaining: null,
    cycleInvoices: [],
    baseInvoice: null,
    fullMonthPerSlot: null,
    fullMonthPerSlotWithVat: null,
    feePerSeat: null,
    feeSeats: null,
    fullMonthPerSlotWithFee: null,
    vatRate: null,
    todayPrice: null,
    todayPriceWithVat: null,
    todayPriceWithFee: null,
    totalSeats: null,
    totalCyclePaidWithVat: null,
    totalCycleFees: null,
    totalCyclePaidWithFees: null,
    projectedNextCycleWithVat: null,
    detailedCount: 0,
  };

  const paid = (invoices ?? []).filter(isPaid);
  if ((invoices ?? []).length === 0) return base;
  if (paid.length === 0) return { ...base, note: "no_detail" };

  const todayMid = new Date(today);
  todayMid.setUTCHours(0, 0, 0, 0);

  // 1) Xác định renewal / cycle_start.
  //
  // CHU KỲ CHUẨN = "Current cycle" tab Kế hoạch (workspaceRenewalIso = ngày kết
  // thúc). Đây là NGUỒN ƯU TIÊN — extension đã neo renewal_date theo tab Kế hoạch.
  // period hoá đơn chỉ dùng để TINH CHỈNH cycle_start (hoá đơn add-seat giữa kỳ)
  // hoặc làm dự phòng khi tab Kế hoạch không cho renewal.
  const detailWithPeriod = paid.filter(
    (inv) => hasDetail(inv) && inv.period_start && inv.period_end,
  );
  let renewalDate: Date | null = null;
  let cycleStart: Date | null = null;
  if (workspaceRenewalIso) {
    renewalDate = atUtcMidnight(workspaceRenewalIso);
    cycleStart = cycleStartFromRenewal(renewalDate);
    // Tinh chỉnh cycle_start = period_start SỚM NHẤT của hoá đơn cùng ngày kết
    // thúc chu kỳ (hoá đơn gia hạn đầu kỳ / add-seat giữa kỳ cùng renewal).
    const renewalMs = renewalDate.getTime();
    const sameEnd = detailWithPeriod.filter(
      (inv) => atUtcMidnight(inv.period_end as string).getTime() === renewalMs,
    );
    if (sameEnd.length > 0) {
      cycleStart = new Date(
        Math.min(
          ...sameEnd.map((inv) =>
            atUtcMidnight(inv.period_start as string).getTime(),
          ),
        ),
      );
    }
  } else if (detailWithPeriod.length > 0) {
    // Dự phòng: tab Kế hoạch không cho renewal → suy từ period hoá đơn.
    // renewal = period_end gần nhất TRONG TƯƠNG LAI (chu kỳ hiện tại); nếu mọi
    // period_end đã qua → lấy period_end lớn nhất (sẽ rơi vào nhánh cycle_ended).
    const ends = detailWithPeriod.map((inv) =>
      atUtcMidnight(inv.period_end as string).getTime(),
    );
    const future = ends.filter((t) => t > todayMid.getTime());
    const renewalMs =
      future.length > 0 ? Math.min(...future) : Math.max(...ends);
    renewalDate = new Date(renewalMs);
    const sameEnd = detailWithPeriod.filter(
      (inv) => atUtcMidnight(inv.period_end as string).getTime() === renewalMs,
    );
    cycleStart = new Date(
      Math.min(
        ...sameEnd.map((inv) => atUtcMidnight(inv.period_start as string).getTime()),
      ),
    );
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
    // KHÔNG có hoá đơn gốc chu kỳ đọc được ĐƠN GIÁ (chi tiết Stripe fail, hoặc
    // đúng ngày renew hoá đơn mới chưa lên). Ta VẪN hiển thị mọi thứ KHÔNG cần
    // chi tiết hoá đơn:
    //   - Tổng seat: lấy từ tab Kế hoạch (seatCount), fallback quantity hoá đơn.
    //   - Tổng chi chu kỳ: Σ số tiền hoá đơn trong kỳ (list, không cần chi tiết).
    // Giá/seat + dự kiến CHỈ điền khi có đơn giá — ưu tiên hoá đơn kỳ TRƯỚC còn
    // đơn giá (ƯỚC TÍNH, note="estimated"); nếu không → giá "—" (note="no_detail")
    // nhưng seats + tổng chi vẫn hiện.
    const seatFromInvoice = latestCycleSeat(detailInCycle);
    const totalSeats =
      seatFromInvoice ?? (seatCount != null && seatCount > 0 ? seatCount : null);
    const totalCyclePaidWithVat = cycleInvoices.reduce(
      (sum, inv) => sum + (inv.total_vnd ?? inv.amount_vnd ?? 0),
      0,
    );
    const totalCycleFees = cycleInvoices.reduce(
      (sum, inv) => sum + (inv.service_fee_vnd ?? 0),
      0,
    );
    const commonPartial = {
      renewalDate,
      cycleStart,
      daysRemaining,
      cycleInvoices,
      totalSeats,
      totalCyclePaidWithVat,
      totalCycleFees,
      totalCyclePaidWithFees: totalCyclePaidWithVat + totalCycleFees,
    };

    const prevBase = workspaceRenewalIso
      ? findPreviousCycleBase(paid, cycleStart as Date)
      : null;
    if (prevBase && prevBase.unit_price_vnd != null) {
      const fullMonthPerSlot = prevBase.unit_price_vnd;
      const vatRate =
        prevBase.vat_vnd != null && prevBase.subtotal_vnd
          ? prevBase.vat_vnd / prevBase.subtotal_vnd
          : 0.1;
      const fullMonthPerSlotWithVat = Math.round(
        fullMonthPerSlot * (1 + vatRate),
      );
      const proRataDays = Math.min(daysRemaining, CYCLE_DAYS);
      const todayPrice = Math.round((fullMonthPerSlot * proRataDays) / CYCLE_DAYS);
      const todayPriceWithVat = Math.round(
        (fullMonthPerSlotWithVat * proRataDays) / CYCLE_DAYS,
      );
      // Số seat dự kiến ưu tiên seat kỳ trước nếu list không cho seat hiện tại.
      const seats = totalSeats ?? prevBase.quantity ?? null;
      const projectedNextCycleWithVat =
        seats != null ? seats * fullMonthPerSlotWithVat : null;
      return {
        ...base,
        ...commonPartial,
        note: "estimated",
        estimated: true,
        totalSeats: seats,
        baseInvoice: prevBase,
        fullMonthPerSlot,
        fullMonthPerSlotWithVat,
        fullMonthPerSlotWithFee: fullMonthPerSlotWithVat,
        feePerSeat: null,
        vatRate,
        todayPrice,
        todayPriceWithVat,
        todayPriceWithFee: todayPriceWithVat,
        projectedNextCycleWithVat,
        detailedCount: 0,
      };
    }
    // Không có đơn giá kỳ trước → giá/seat "—", nhưng seats + tổng chi vẫn hiện.
    return {
      ...base,
      ...commonPartial,
      note: "no_detail",
    };
  }

  const fullMonthPerSlot = baseInvoice.unit_price_vnd;
  // Thuế suất suy từ hoá đơn gốc (vat ÷ subtotal); mặc định 10%.
  const vatRate =
    baseInvoice.vat_vnd != null && baseInvoice.subtotal_vnd
      ? baseInvoice.vat_vnd / baseInvoice.subtotal_vnd
      : 0.1;
  // Giá/seat 1 tháng GỒM VAT = đơn giá SẠCH × (1+VAT). KHÔNG dùng total ÷ quantity:
  // hoá đơn gia hạn kèm điều chỉnh seat (proration) có `total` gồm phần cộng/trừ
  // giữa kỳ (vd +100.843đ) → total÷qty bị đội lên (287.156 thay vì 286.550).
  const fullMonthPerSlotWithVat = Math.round(fullMonthPerSlot * (1 + vatRate));
  // Prorate cho NGÀY CÒN LẠI với mẫu số CỐ ĐỊNH 30 ngày (chốt với người dùng):
  // giá/ngày = giá tháng ÷ 30. Kẹp số ngày ≤ 30 để không vượt giá trọn tháng khi
  // chu kỳ dài 31 ngày (mua trọn kỳ = đúng giá tháng, không hơn).
  const proRataDays = Math.min(daysRemaining, CYCLE_DAYS);
  const todayPrice = Math.round((fullMonthPerSlot * proRataDays) / CYCLE_DAYS);
  const todayPriceWithVat = Math.round(
    (fullMonthPerSlotWithVat * proRataDays) / CYCLE_DAYS,
  );
  // Tổng seat chu kỳ = SỐ SEAT HIỆN TẠI. Ưu tiên số seat tab Kế hoạch (seatCount,
  // "46/46" — chuẩn nhất, KHÔNG lệch bởi proration), fallback quantity hoá đơn mới
  // nhất trong chu kỳ. KHÔNG cộng dồn (proration ghi tổng mới, không phải delta).
  const totalSeats =
    (seatCount != null && seatCount > 0 ? seatCount : null) ??
    latestCycleSeat(detailInCycle);

  // Tổng ĐÃ CHI trong chu kỳ (gồm VAT) = Σ total (ưu tiên total_vnd, fallback
  // amount_vnd) của mọi hoá đơn Paid thuộc chu kỳ.
  const totalCyclePaidWithVat = cycleInvoices.reduce(
    (sum, inv) => sum + (inv.total_vnd ?? inv.amount_vnd ?? 0),
    0,
  );
  // Phí ngân hàng nhập tay (ngoài Stripe) → cộng vào tổng thực trả chu kỳ.
  const totalCycleFees = cycleInvoices.reduce(
    (sum, inv) => sum + (inv.service_fee_vnd ?? 0),
    0,
  );
  const totalCyclePaidWithFees = totalCyclePaidWithVat + totalCycleFees;
  // Phí ngân hàng phân bổ trên 1 seat = tổng phí chu kỳ ÷ số seat ĐÃ TRẢ PHÍ
  // (Σ quantity của hoá đơn có phí NH), KHÔNG chia cho seat hiện tại (totalSeats):
  // phí NH phát sinh khi thanh toán cho số seat GHI TRÊN HOÁ ĐƠN (vd 183), không
  // phải số seat đang dùng (vd 163). Chia cho 163 làm phí/seat bị đội lên sai.
  // Khớp invoiceSeatPricing (mỗi hoá đơn chia phí cho quantity của chính nó). Numerator
  // chỉ cộng phí của hoá đơn CÓ quantity để tỉ lệ tử/mẫu nhất quán. Giá thật/seat =
  // giá gồm VAT + phần phí này (khi chưa nhập phí → = giá gồm VAT).
  let feeSum = 0;
  let feeSeats = 0;
  for (const inv of cycleInvoices) {
    const fee = inv.service_fee_vnd ?? 0;
    if (fee > 0 && inv.quantity != null && inv.quantity > 0) {
      feeSum += fee;
      feeSeats += inv.quantity;
    }
  }
  const feePerSeat =
    feeSeats > 0
      ? Math.round(feeSum / feeSeats)
      : totalCycleFees === 0
        ? 0 // không có phí NH → phí/seat = 0 (giá thật = giá gồm VAT)
        : null; // có phí nhưng thiếu quantity để phân bổ → chưa xác định
  const fullMonthPerSlotWithFee =
    feePerSeat != null
      ? fullMonthPerSlotWithVat + feePerSeat
      : fullMonthPerSlotWithVat;
  // Giá/seat ngày còn lại GỒM cả phí NH = giá tháng (gồm VAT + phí) ÷ 30 × ngày còn lại.
  const todayPriceWithFee = Math.round(
    (fullMonthPerSlotWithFee * proRataDays) / CYCLE_DAYS,
  );
  // Dự kiến kỳ sau (gồm VAT) nếu giữ nguyên seat hiện tại.
  const projectedNextCycleWithVat =
    totalSeats != null ? totalSeats * fullMonthPerSlotWithVat : null;

  return {
    note: "ok",
    estimated: false,
    renewalDate,
    cycleStart,
    daysRemaining,
    cycleInvoices,
    baseInvoice,
    fullMonthPerSlot,
    fullMonthPerSlotWithVat,
    feePerSeat,
    feeSeats: feeSeats > 0 ? feeSeats : null,
    fullMonthPerSlotWithFee,
    vatRate,
    todayPrice,
    todayPriceWithVat,
    todayPriceWithFee,
    totalSeats,
    totalCyclePaidWithVat,
    totalCycleFees,
    totalCyclePaidWithFees,
    projectedNextCycleWithVat,
    detailedCount: detailInCycle.length,
  };
}

export type InvoiceSeatPricing = {
  /** Giá/seat 1 tháng của hoá đơn = đơn giá × (1+VAT) + phí NH/seat. null nếu thiếu đơn giá/seat. */
  monthlyPerSeat: number | null;
  /** Giá/seat cho ngày còn lại = giá tháng ÷ 30 × ngày còn lại (kẹp ≤ giá tháng). null nếu hết hạn/thiếu period. */
  remainingPerSeat: number | null;
  /** Số ngày còn lại từ hôm nay tới period_end (renew). null nếu không có period_end. */
  daysRemaining: number | null;
};

/**
 * Tính giá/seat cho 1 hoá đơn RIÊNG LẺ — mỗi hoá đơn tự tính theo đơn giá & VAT
 * & phí của chính nó (tỉ giá VND đã nằm trong đơn giá scrape), KHÔNG dùng chung
 * base của chu kỳ. Giá tháng = đơn giá×(1+VAT)+phí/seat (loại proration, khác
 * total÷qty). Ngày còn lại prorate mẫu số cố định 30, kẹp ≤ giá tháng.
 */
export function invoiceSeatPricing(
  inv: BillingInvoice,
  today: Date = new Date(),
): InvoiceSeatPricing {
  const qty = inv.quantity;
  const unit = inv.unit_price_vnd;
  if (qty == null || qty <= 0 || unit == null) {
    return { monthlyPerSeat: null, remainingPerSeat: null, daysRemaining: null };
  }
  const vatRate =
    inv.vat_vnd != null && inv.subtotal_vnd
      ? inv.vat_vnd / inv.subtotal_vnd
      : 0.1;
  const feePerSeat =
    inv.service_fee_vnd != null ? Math.round(inv.service_fee_vnd / qty) : 0;
  const monthlyPerSeat = Math.round(unit * (1 + vatRate)) + feePerSeat;

  let remainingPerSeat: number | null = null;
  let daysRemaining: number | null = null;
  if (inv.period_end) {
    const end = atUtcMidnight(inv.period_end);
    const t = new Date(today);
    t.setUTCHours(0, 0, 0, 0);
    daysRemaining = daysBetween(t, end);
    if (daysRemaining > 0) {
      const proRataDays = Math.min(daysRemaining, CYCLE_DAYS);
      remainingPerSeat = Math.round((monthlyPerSeat * proRataDays) / CYCLE_DAYS);
    }
  }
  return { monthlyPerSeat, remainingPerSeat, daysRemaining };
}
