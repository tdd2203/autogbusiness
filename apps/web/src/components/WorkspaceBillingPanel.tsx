/**
 * Hiển thị thông tin billing per-workspace:
 *   1. Seat usage (used/total)
 *   2. Chu kỳ hoá đơn (renewal_date)
 *   3. Giá ước tính cho 1 slot HÔM NAY — prorated theo days_remaining
 *   4. Lịch sử hoá đơn từ /admin/billing scrape
 *
 * Logic giá hôm nay:
 *   - Lấy invoice gần nhất {date, amount_vnd, quantity=1 implied}
 *   - days_remaining_at_that_invoice = renewal - invoice_date
 *   - days_remaining_today = renewal - today
 *   - today_price ≈ recent_amount × (days_remaining_today / days_remaining_at_invoice)
 *
 * Đây là ước tính tuyến tính. ChatGPT thực tế dùng công thức gần đúng nhưng có
 * thể có rounding/tax — số hiển thị có thể chênh vài %.
 */

import { useT } from "../i18n";
import type { BillingInvoice, Workspace } from "../types";

const VND = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function computeTodayPerSlotPrice(
  invoices: BillingInvoice[] | null,
  renewalIso: string | null,
): {
  price: number | null;
  fullMonthPerSlot: number | null;
  basedOn: BillingInvoice | null;
  note: string;
} {
  if (!invoices || invoices.length === 0) {
    return { price: null, fullMonthPerSlot: null, basedOn: null, note: "no_invoices" };
  }
  if (!renewalIso) {
    return { price: null, fullMonthPerSlot: null, basedOn: null, note: "no_renewal_date" };
  }
  const renewal = new Date(renewalIso);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysToday = daysBetween(today, renewal);
  if (daysToday <= 0) {
    return { price: null, fullMonthPerSlot: null, basedOn: null, note: "cycle_ended" };
  }

  // Logic mới (theo user clarify 2026-05-17):
  // - ChatGPT Business yêu cầu mua TỐI THIỂU 2 slot lần đầu → invoice oldest
  //   (ngày đầu chu kỳ) = giá 2 slot full month → chia 2 = giá 1 slot full month
  // - Today's per-slot price = (full_month_per_slot / cycle_length) × days_today
  //   = full_month_per_slot × (days_today / cycle_length)
  //
  // Cycle length tự suy từ first_invoice.date → renewal_date (thường ≈ 30 ngày).
  const sortedAsc = [...invoices].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const firstInvoice = sortedAsc[0];
  const firstDate = new Date(firstInvoice.date);
  firstDate.setUTCHours(0, 0, 0, 0);
  const cycleLength = daysBetween(firstDate, renewal);
  if (cycleLength <= 0) {
    return {
      price: null,
      fullMonthPerSlot: null,
      basedOn: firstInvoice,
      note: "invalid_cycle",
    };
  }

  // Hoá đơn đầu = 2 slot → chia 2 = giá 1 slot cho full chu kỳ
  const fullMonthPerSlot = Math.round(firstInvoice.amount_vnd / 2);
  const price = Math.round(fullMonthPerSlot * (daysToday / cycleLength));

  // Sanity check: full month per slot phải hợp lý cho ChatGPT Business
  // (~286k VND theo user clarify). Nếu lệch quá nhiều (vd <100k hoặc >500k)
  // có thể first invoice không phải 2-slot purchase → cảnh báo admin.
  const out_of_range =
    fullMonthPerSlot < 100_000 || fullMonthPerSlot > 500_000;

  return {
    price,
    fullMonthPerSlot,
    basedOn: firstInvoice,
    note: out_of_range ? "price_out_of_range" : "ok",
  };
}

export function WorkspaceBillingPanel({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const invoices = workspace.billing_invoices ?? [];
  const renewal = workspace.renewal_date;
  const { price: todayPrice, fullMonthPerSlot, basedOn, note } =
    computeTodayPerSlotPrice(invoices, renewal);

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
                  : note === "invalid_cycle"
                    ? t("billing.invalidCycleHint")
                    : note === "price_out_of_range"
                      ? t("billing.priceOutOfRangeHint", {
                          value: VND.format(fullMonthPerSlot ?? 0),
                        })
                      : basedOn
                        ? t("billing.basedOnInvoice", {
                            date: new Date(basedOn.date).toLocaleDateString(),
                            amount: VND.format(basedOn.amount_vnd),
                          })
                        : ""
          }
        />
        <Metric
          label={t("billing.fullMonthPerSlot")}
          value={
            fullMonthPerSlot !== null ? VND.format(fullMonthPerSlot) : "—"
          }
          hint={t("billing.fullMonthPerSlotHint")}
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
                <th style={{ textAlign: "left" }}>{t("billing.colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {[...invoices]
                .sort(
                  (a, b) =>
                    new Date(b.date).getTime() - new Date(a.date).getTime(),
                )
                .map((inv, i) => (
                  <tr key={`${inv.date}-${inv.amount_vnd}-${i}`}>
                    <td>{new Date(inv.date).toLocaleDateString("vi-VN")}</td>
                    <td
                      style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}
                    >
                      {VND.format(inv.amount_vnd)}
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
                ))}
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
