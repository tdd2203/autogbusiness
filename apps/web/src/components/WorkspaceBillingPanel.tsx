/**
 * Hiển thị thông tin billing per-workspace:
 *   1. Seat usage (used/total)
 *   2. Chu kỳ hoá đơn (renewal_date)
 *   3. Giá ước tính cho 1 slot HÔM NAY — base từ hoá đơn ĐẦU CHU KỲ
 *   4. Lịch sử hoá đơn từ /admin/billing scrape (kèm số slot suy diễn mỗi invoice)
 *
 * Logic giá (v6 — 2026-05-20):
 *   - ChatGPT: ngày **renewal** = kết thúc chu kỳ hiện tại = bắt đầu chu kỳ kế.
 *   - **cycle_start** = cùng ngày/tháng, lùi 1 tháng (vd renew 11/6 → start 11/5).
 *   - Hoá đơn chu kỳ: cycle_start ≤ ngày HĐ < renewal (HĐ đúng ngày renew thuộc chu kỳ mới).
 *   - Base = hoá đơn **ngày đầu chu kỳ** (ưu tiên đúng cycle_start), không HĐ add-seat sau.
 *   - **fullMonthPerSlot = số tiền thanh toán ÷ số slot mua** (slot = min hợp lệ, có seat_total).
 *     KHÔNG back-calc implied_per_slot = amount/(slots×days/30) — công thức đó
 *     phóng đại giá khi hoá đơn không rơi đúng ngày đầu chu kỳ (vd 228k → 274k).
 *   - **Today's price = fullMonthPerSlot × (days_today / 30)**.
 */

import { useT } from "../i18n";
import type { BillingInvoice, Workspace } from "../types";

const CYCLE_DAYS = 30;
const EXPECTED_PER_SLOT_MIN = 200_000;
const EXPECTED_PER_SLOT_MAX = 400_000;
const MAX_SLOT_GUESS = 10;

const VND = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Ngày bắt đầu chu kỳ hiện tại: cùng ngày trong tháng trước ngày renew.
 * (renewal vừa là cuối chu kỳ này vừa là đầu chu kỳ tiếp theo.)
 */
export function cycleStartFromRenewal(renewal: Date): Date {
  const y = renewal.getUTCFullYear();
  const m = renewal.getUTCMonth();
  const d = renewal.getUTCDate();
  const start = new Date(Date.UTC(y, m - 1, d));
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** Hoá đơn thuộc chu kỳ billing hiện tại (không lấy tháng trước / chu kỳ kế). */
function filterInvoicesInCurrentCycle(
  invoices: BillingInvoice[],
  renewal: Date,
): BillingInvoice[] {
  const cycleStart = cycleStartFromRenewal(renewal);
  return invoices.filter((inv) => {
    const d = new Date(inv.date);
    d.setUTCHours(0, 0, 0, 0);
    return d >= cycleStart && d < renewal;
  });
}

/** Số slot mua trên hoá đơn: amount ÷ n hợp lệ; ưu tiên n nhỏ nhất (vd 1 slot, không chia 2 khi cả hai đều khớp). */
function inferSlotsPurchased(
  amountVnd: number,
  seatTotalHint: number | null,
): number {
  const maxN = Math.min(
    MAX_SLOT_GUESS,
    seatTotalHint && seatTotalHint > 0 ? seatTotalHint : MAX_SLOT_GUESS,
  );
  const valid: number[] = [];
  for (let n = 1; n <= maxN; n++) {
    const perSlot = amountVnd / n;
    if (perSlot >= EXPECTED_PER_SLOT_MIN && perSlot <= EXPECTED_PER_SLOT_MAX) {
      valid.push(n);
    }
  }
  return valid.length > 0 ? Math.min(...valid) : 1;
}

/**
 * Hoá đơn dùng làm base giá full month: ưu tiên đúng ngày bắt đầu chu kỳ,
 * không thì hoá đơn gần cycle_start nhất (trừ kỳ đầu tiên thực tế).
 */
function pickFirstCycleInvoice(
  cycleInvoices: BillingInvoice[],
  cycleStart: Date,
): BillingInvoice | null {
  if (cycleInvoices.length === 0) return null;
  const startMs = cycleStart.getTime();
  const onCycleStart = cycleInvoices.filter((inv) => {
    const d = new Date(inv.date);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime() === startMs;
  });
  if (onCycleStart.length > 0) {
    return [...onCycleStart].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    )[0];
  }
  return [...cycleInvoices].sort((a, b) => {
    const da = new Date(a.date);
    da.setUTCHours(0, 0, 0, 0);
    const db = new Date(b.date);
    db.setUTCHours(0, 0, 0, 0);
    const distA = Math.abs(da.getTime() - startMs);
    const distB = Math.abs(db.getTime() - startMs);
    if (distA !== distB) return distA - distB;
    return da.getTime() - db.getTime();
  })[0];
}

export type InvoiceBreakdown = {
  date: string;
  amount_vnd: number;
  inferred_slots: number | null;
  /** Giá thực trả cho 1 slot trong invoice này = amount / slots. Giảm dần khi
   * gần ngày renew vì ChatGPT prorate theo days_remaining/30. Đây là số hiển
   * thị ở cột "Giá/slot" — user-intuitive (mua hôm nay rẻ hơn mua đầu chu kỳ). */
  amount_per_slot: number | null;
  /** Ước tính nếu coi invoice là prorate (chỉ tooltip). Không dùng cho giá card. */
  implied_per_slot: number | null;
  days_remaining_at_invoice: number;
};

function inferInvoiceBreakdown(
  inv: BillingInvoice,
  renewal: Date,
  seatTotalHint: number | null,
): InvoiceBreakdown {
  const invDate = new Date(inv.date);
  invDate.setUTCHours(0, 0, 0, 0);
  const daysAtInv = daysBetween(invDate, renewal);
  const slots = inferSlotsPurchased(inv.amount_vnd, seatTotalHint);
  const perSlot = Math.round(inv.amount_vnd / slots);
  const inRange =
    perSlot >= EXPECTED_PER_SLOT_MIN && perSlot <= EXPECTED_PER_SLOT_MAX;
  const impliedPerSlot =
    inRange && daysAtInv > 0 && daysAtInv <= CYCLE_DAYS + 5
      ? Math.round(inv.amount_vnd / ((slots * daysAtInv) / CYCLE_DAYS))
      : null;
  return {
    date: inv.date,
    amount_vnd: inv.amount_vnd,
    inferred_slots: inRange ? slots : null,
    amount_per_slot: inRange ? perSlot : null,
    implied_per_slot: impliedPerSlot,
    days_remaining_at_invoice: daysAtInv,
  };
}

function computeTodayPerSlotPrice(
  invoices: BillingInvoice[] | null,
  renewalIso: string | null,
  seatTotalHint: number | null,
): {
  price: number | null;
  fullMonthPerSlot: number | null;
  breakdown: InvoiceBreakdown[];
  matched: number;
  total: number;
  note: string;
  /** Hoá đơn đầu chu kỳ — base cho fullMonthPerSlot. Null nếu chưa match invoice nào. */
  baseInvoice: InvoiceBreakdown | null;
} {
  const empty = {
    price: null,
    fullMonthPerSlot: null,
    breakdown: [],
    matched: 0,
    total: 0,
    baseInvoice: null,
  };
  if (!invoices || invoices.length === 0) {
    return { ...empty, note: "no_invoices" };
  }
  if (!renewalIso) {
    return { ...empty, total: invoices.length, note: "no_renewal_date" };
  }
  const renewal = new Date(renewalIso);
  renewal.setUTCHours(0, 0, 0, 0);
  const cycleStart = cycleStartFromRenewal(renewal);
  const cycleInvoices = filterInvoicesInCurrentCycle(invoices, renewal);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysToday = daysBetween(today, renewal);
  if (daysToday <= 0) {
    return {
      ...empty,
      total: invoices.length,
      note: "cycle_ended",
    };
  }

  const breakdown = cycleInvoices.map((inv) =>
    inferInvoiceBreakdown(inv, renewal, seatTotalHint),
  );

  const firstInv = pickFirstCycleInvoice(cycleInvoices, cycleStart);
  if (!firstInv) {
    return {
      ...empty,
      breakdown,
      total: 0,
      note: "no_cycle_invoices",
    };
  }

  const baseSlots = inferSlotsPurchased(firstInv.amount_vnd, seatTotalHint);
  const fullMonthPerSlot = Math.round(firstInv.amount_vnd / baseSlots);
  if (
    fullMonthPerSlot < EXPECTED_PER_SLOT_MIN ||
    fullMonthPerSlot > EXPECTED_PER_SLOT_MAX
  ) {
    return {
      ...empty,
      breakdown,
      total: cycleInvoices.length,
      note: "inference_failed",
    };
  }

  const baseInvoice: InvoiceBreakdown = {
    date: firstInv.date,
    amount_vnd: firstInv.amount_vnd,
    inferred_slots: baseSlots,
    amount_per_slot: fullMonthPerSlot,
    implied_per_slot: null,
    days_remaining_at_invoice: (() => {
      const d = new Date(firstInv.date);
      d.setUTCHours(0, 0, 0, 0);
      return daysBetween(d, renewal);
    })(),
  };
  const price = Math.round(fullMonthPerSlot * (daysToday / CYCLE_DAYS));
  const matched = breakdown.filter((b) => b.amount_per_slot !== null);

  return {
    price,
    fullMonthPerSlot,
    breakdown,
    matched: matched.length,
    total: cycleInvoices.length,
    note: "ok",
    baseInvoice,
  };
}

export function WorkspaceBillingPanel({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const invoices = workspace.billing_invoices ?? [];
  const renewal = workspace.renewal_date;
  const {
    price: todayPrice,
    fullMonthPerSlot,
    breakdown,
    matched,
    total,
    note,
    baseInvoice,
  } = computeTodayPerSlotPrice(invoices, renewal, workspace.seat_total);
  const breakdownByDateAmt = new Map<string, InvoiceBreakdown>();
  for (const b of breakdown) {
    breakdownByDateAmt.set(`${b.date}|${b.amount_vnd}`, b);
  }

  const renewalDate = renewal ? new Date(renewal) : null;
  if (renewalDate) renewalDate.setUTCHours(0, 0, 0, 0);
  const cycleStartDate = renewalDate
    ? cycleStartFromRenewal(renewalDate)
    : null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysRemaining = renewalDate ? daysBetween(today, renewalDate) : null;

  if (invoices.length === 0 && !workspace.last_billing_synced_at) {
    // Chưa sync lần nào — hiện hint (button sync nằm ở WorkspaceLayout header)
    return (
      <div className="surface-card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 className="display-h3">{t("billing.workspaceTitle")}</h3>
        <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8 }}>
          {t("billing.noInvoicesHint")}
        </p>
      </div>
    );
  }

  return (
    <div
      className="surface-card"
      style={{ padding: 16, marginBottom: 16 }}
    >
      <div className="flex items-baseline" style={{ gap: 12 }}>
        <h3 className="display-h3">{t("billing.workspaceTitle")}</h3>
        {renewalDate && daysRemaining !== null && daysRemaining > 0 && (
          <span
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-3)" }}
          >
            {t("billing.daysRemaining", { n: daysRemaining })}
          </span>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        <Metric
          label={t("billing.todaySlotPrice")}
          value={todayPrice !== null ? VND.format(todayPrice) : "—"}
          hint={
            note === "no_invoices"
              ? t("billing.noInvoicesHint")
              : note === "no_renewal_date"
                ? t("billing.noRenewalHint")
                : note === "cycle_ended"
                  ? t("billing.cycleEndedHint")
                  : note === "no_cycle_invoices"
                    ? t("billing.noCycleInvoicesHint", {
                        total: invoices.length,
                      })
                  : note === "inference_failed"
                    ? t("billing.inferenceFailedHint", { total })
                    : baseInvoice && fullMonthPerSlot !== null && daysRemaining !== null
                      ? t("billing.todayFromBase", {
                          base: VND.format(fullMonthPerSlot),
                          days: daysRemaining,
                        })
                      : t("billing.inferredFromN", { matched, total })
          }
        />
        <Metric
          label={t("billing.fullMonthPerSlot")}
          value={
            fullMonthPerSlot !== null ? VND.format(fullMonthPerSlot) : "—"
          }
          hint={
            baseInvoice
              ? t("billing.fullMonthFromFirstInvoice", {
                  date: new Date(baseInvoice.date).toLocaleDateString("vi-VN"),
                  slots: baseInvoice.inferred_slots ?? "?",
                  amount: VND.format(baseInvoice.amount_vnd),
                })
              : t("billing.fullMonthPerSlotHintV2")
          }
        />
        <Metric
          label={t("billing.renewalDate")}
          value={
            renewalDate
              ? renewalDate.toLocaleDateString("vi-VN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : "—"
          }
          hint={
            cycleStartDate && renewalDate
              ? t("billing.renewalCycleRange", {
                  start: cycleStartDate.toLocaleDateString("vi-VN", {
                    day: "numeric",
                    month: "short",
                  }),
                  end: renewalDate.toLocaleDateString("vi-VN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  }),
                })
              : t("billing.renewalCycle")
          }
        />
        <Metric
          label={t("billing.invoiceCount")}
          value={String(invoices.length)}
          hint={t("billing.thisCycle")}
        />
      </div>

      {invoices.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary
            style={{
              cursor: "pointer",
              fontSize: 13,
              color: "var(--ink-2)",
              fontWeight: 500,
            }}
          >
            {t("billing.invoiceHistoryToggle", { n: invoices.length })}
          </summary>
          <table
            className="data-table"
            style={{ marginTop: 12, fontSize: 13 }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>{t("billing.colDate")}</th>
                <th style={{ textAlign: "right" }}>{t("billing.colAmount")}</th>
                <th style={{ textAlign: "center" }}>{t("billing.colSlots")}</th>
                <th style={{ textAlign: "right" }}>{t("billing.colPerSlot")}</th>
                <th style={{ textAlign: "left" }}>{t("billing.colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {[...invoices]
                .sort(
                  (a, b) =>
                    new Date(b.date).getTime() - new Date(a.date).getTime(),
                )
                .map((inv, i) => {
                  const br = breakdownByDateAmt.get(
                    `${inv.date}|${inv.amount_vnd}`,
                  );
                  return (
                    <tr key={`${inv.date}-${inv.amount_vnd}-${i}`}>
                      <td>{new Date(inv.date).toLocaleDateString("vi-VN")}</td>
                      <td
                        style={{
                          textAlign: "right",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {VND.format(inv.amount_vnd)}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        {br?.inferred_slots ? (
                          <span
                            className="mono"
                            title={t("billing.slotsInferTooltip", {
                              days: br.days_remaining_at_invoice,
                            })}
                          >
                            {br.inferred_slots}
                          </span>
                        ) : (
                          <span style={{ color: "var(--ink-3)" }}>—</span>
                        )}
                      </td>
                      <td
                        style={{
                          textAlign: "right",
                          fontFamily: "var(--font-mono)",
                          color: br?.amount_per_slot
                            ? "var(--ink-2)"
                            : "var(--ink-3)",
                        }}
                        title={
                          br?.amount_per_slot && br?.implied_per_slot
                            ? t("billing.perSlotTooltip", {
                                days: br.days_remaining_at_invoice,
                                fullMonth: VND.format(br.implied_per_slot),
                              })
                            : undefined
                        }
                      >
                        {br?.amount_per_slot
                          ? VND.format(br.amount_per_slot)
                          : "—"}
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            inv.status === "paid"
                              ? "badge-success"
                              : inv.status === "unpaid"
                                ? "badge-danger"
                                : "badge-neutral"
                          }`}
                        >
                          {inv.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      style={{
        padding: 12,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-3)",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: "var(--ink)",
          marginTop: 4,
          fontFamily: "var(--font-mono)",
        }}
      >
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
