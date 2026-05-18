/**
 * Hiển thị thông tin billing per-workspace:
 *   1. Seat usage (used/total)
 *   2. Chu kỳ hoá đơn (renewal_date)
 *   3. Giá ước tính cho 1 slot HÔM NAY — smart inference từ history
 *   4. Lịch sử hoá đơn từ /admin/billing scrape (kèm số slot suy diễn mỗi invoice)
 *
 * Smart inference (v2 — 2026-05-18):
 *   - Chu kỳ ChatGPT Business = 30 ngày, giá chuẩn ≈ 286k VND/slot/month.
 *   - Với mỗi invoice: thử slot count 1..10, công thức
 *       implied_per_slot = amount / (slots × days_remaining_at_invoice / 30)
 *     chọn slot count cho implied_per_slot rơi vào range [200k, 400k] và gần
 *     mức kỳ vọng 286k nhất.
 *   - Lấy median per_slot của tất cả invoice match được → fullMonthPerSlot.
 *   - Today's price = fullMonthPerSlot × (days_today / 30).
 *
 * Logic cũ (first_invoice / 2) đã bỏ vì assumption "2-slot lần đầu" SAI khi
 * workspace mua nhiều slot khác nhau trong cycle.
 */

import { useT } from "../i18n";
import type { BillingInvoice, Workspace } from "../types";

const CYCLE_DAYS = 30;
const EXPECTED_PER_SLOT_MIN = 200_000;
const EXPECTED_PER_SLOT_MAX = 400_000;
const EXPECTED_PER_SLOT_MID = 286_000;
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

export type InvoiceBreakdown = {
  date: string;
  amount_vnd: number;
  inferred_slots: number | null;
  implied_per_slot: number | null;
  days_remaining_at_invoice: number;
};

function inferInvoiceBreakdown(
  inv: BillingInvoice,
  renewal: Date,
): InvoiceBreakdown {
  const invDate = new Date(inv.date);
  invDate.setUTCHours(0, 0, 0, 0);
  const daysAtInv = daysBetween(invDate, renewal);
  if (daysAtInv <= 0 || daysAtInv > CYCLE_DAYS + 2) {
    return {
      date: inv.date,
      amount_vnd: inv.amount_vnd,
      inferred_slots: null,
      implied_per_slot: null,
      days_remaining_at_invoice: daysAtInv,
    };
  }

  // Thử slot count 1..MAX, chọn cái cho implied_per_slot gần mức kỳ vọng nhất
  // và rơi vào range hợp lý.
  let bestSlots: number | null = null;
  let bestPerSlot: number | null = null;
  let bestDist = Infinity;
  for (let n = 1; n <= MAX_SLOT_GUESS; n++) {
    const perSlot = inv.amount_vnd / ((n * daysAtInv) / CYCLE_DAYS);
    if (perSlot < EXPECTED_PER_SLOT_MIN || perSlot > EXPECTED_PER_SLOT_MAX) {
      continue;
    }
    const dist = Math.abs(perSlot - EXPECTED_PER_SLOT_MID);
    if (dist < bestDist) {
      bestDist = dist;
      bestSlots = n;
      bestPerSlot = perSlot;
    }
  }
  return {
    date: inv.date,
    amount_vnd: inv.amount_vnd,
    inferred_slots: bestSlots,
    implied_per_slot: bestPerSlot !== null ? Math.round(bestPerSlot) : null,
    days_remaining_at_invoice: daysAtInv,
  };
}

function computeTodayPerSlotPrice(
  invoices: BillingInvoice[] | null,
  renewalIso: string | null,
): {
  price: number | null;
  fullMonthPerSlot: number | null;
  breakdown: InvoiceBreakdown[];
  matched: number;
  total: number;
  note: string;
} {
  const empty = {
    price: null,
    fullMonthPerSlot: null,
    breakdown: [],
    matched: 0,
    total: 0,
  };
  if (!invoices || invoices.length === 0) {
    return { ...empty, note: "no_invoices" };
  }
  if (!renewalIso) {
    return { ...empty, total: invoices.length, note: "no_renewal_date" };
  }
  const renewal = new Date(renewalIso);
  renewal.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysToday = daysBetween(today, renewal);
  if (daysToday <= 0) {
    return { ...empty, total: invoices.length, note: "cycle_ended" };
  }

  const breakdown = invoices.map((inv) => inferInvoiceBreakdown(inv, renewal));
  const matched = breakdown.filter((b) => b.implied_per_slot !== null);

  if (matched.length === 0) {
    return {
      ...empty,
      breakdown,
      total: invoices.length,
      note: "inference_failed",
    };
  }

  // Median per_slot của các invoice match được
  const sorted = matched
    .map((b) => b.implied_per_slot as number)
    .sort((a, b) => a - b);
  const mid =
    sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

  const fullMonthPerSlot = mid;
  const price = Math.round(fullMonthPerSlot * (daysToday / CYCLE_DAYS));

  return {
    price,
    fullMonthPerSlot,
    breakdown,
    matched: matched.length,
    total: invoices.length,
    note: "ok",
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
  } = computeTodayPerSlotPrice(invoices, renewal);
  const breakdownByDateAmt = new Map<string, InvoiceBreakdown>();
  for (const b of breakdown) {
    breakdownByDateAmt.set(`${b.date}|${b.amount_vnd}`, b);
  }

  const renewalDate = renewal ? new Date(renewal) : null;
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
                  : note === "inference_failed"
                    ? t("billing.inferenceFailedHint", { total })
                    : t("billing.inferredFromN", { matched, total })
          }
        />
        <Metric
          label={t("billing.fullMonthPerSlot")}
          value={
            fullMonthPerSlot !== null ? VND.format(fullMonthPerSlot) : "—"
          }
          hint={t("billing.fullMonthPerSlotHintV2")}
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
          hint={t("billing.renewalCycle")}
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
                          color: br?.implied_per_slot
                            ? "var(--ink-2)"
                            : "var(--ink-3)",
                        }}
                      >
                        {br?.implied_per_slot
                          ? VND.format(br.implied_per_slot)
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
