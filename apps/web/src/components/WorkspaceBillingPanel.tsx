/**
 * Hiển thị thông tin billing per-workspace từ dữ liệu CHÍNH XÁC đọc ở chi tiết
 * hoá đơn (quantity, unit_price_vnd, period). Không còn ĐOÁN số seat bằng phép
 * chia — xem billing-math.ts.
 *
 * Metrics:
 *   1. Giá 1 slot hôm nay   = fullMonthPerSlot × daysRemaining/30
 *   2. Giá full month/slot  = unit_price_vnd hoá đơn gốc chu kỳ
 *   3. Ngày renew           = period_end hoá đơn gốc chu kỳ (fallback renewal_date)
 *   4. Tổng seat chu kỳ     = Σ quantity hoá đơn Paid có chi tiết trong chu kỳ
 *   5. Số hoá đơn chu kỳ
 *
 * Hoá đơn chưa đọc được chi tiết (detail_scraped=false) → hiển thị "—", KHÔNG
 * tham gia tính giá. Không hoá đơn nào có chi tiết → note="no_detail".
 */

import { useFormatDate, useT, useTranslateEnum } from "../i18n";
import type { BillingInvoice, Workspace } from "../types";
import { computeBillingCycle, cycleStartFromRenewal, daysBetween } from "./billing-math";

const VND = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export function WorkspaceBillingPanel({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const formatDate = useFormatDate();
  const tInvoiceStatus = useTranslateEnum("invoice");
  const invoices = workspace.billing_invoices ?? [];

  const cycle = computeBillingCycle(invoices, workspace.renewal_date);
  const {
    note,
    renewalDate,
    cycleStart,
    daysRemaining,
    fullMonthPerSlot,
    fullMonthPerSlotWithVat,
    vatRate,
    todayPriceWithVat,
    totalSeats,
    totalCyclePaidWithVat,
    projectedNextCycleWithVat,
    cycleInvoices,
    baseInvoice,
  } = cycle;
  const vatPct = vatRate != null ? Math.round(vatRate * 100) : 10;

  // Fallback hiển thị ngày renew ngay cả khi chỉ có renewal_date đoán.
  const displayRenewal =
    renewalDate ??
    (workspace.renewal_date ? new Date(workspace.renewal_date) : null);
  if (displayRenewal) displayRenewal.setUTCHours(0, 0, 0, 0);
  const displayCycleStart =
    cycleStart ?? (displayRenewal ? cycleStartFromRenewal(displayRenewal) : null);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const displayDaysRemaining =
    daysRemaining ?? (displayRenewal ? daysBetween(today, displayRenewal) : null);

  if (invoices.length === 0 && !workspace.last_billing_synced_at) {
    return (
      <div className="surface-card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 className="display-h3">{t("billing.workspaceTitle")}</h3>
        <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8 }}>
          {t("billing.noInvoicesHint")}
        </p>
      </div>
    );
  }

  const todayHint =
    note === "no_invoices"
      ? t("billing.noInvoicesHint")
      : note === "no_renewal_date"
        ? t("billing.noRenewalHint")
        : note === "cycle_ended"
          ? t("billing.cycleEndedHint")
          : note === "no_detail"
            ? t("billing.noDetailHint")
            : baseInvoice && fullMonthPerSlotWithVat !== null && displayDaysRemaining !== null
              ? t("billing.todayFromBase", {
                  base: VND.format(fullMonthPerSlotWithVat),
                  days: displayDaysRemaining,
                })
              : "";

  return (
    <div className="surface-card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="flex items-baseline" style={{ gap: 12 }}>
        <h3 className="display-h3">{t("billing.workspaceTitle")}</h3>
        {displayRenewal && displayDaysRemaining !== null && displayDaysRemaining > 0 && (
          <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {t("billing.daysRemaining", { n: displayDaysRemaining })}
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
          value={todayPriceWithVat !== null ? VND.format(todayPriceWithVat) : "—"}
          hint={
            todayPriceWithVat !== null && fullMonthPerSlotWithVat !== null && displayDaysRemaining !== null
              ? t("billing.todaySlotPriceVatHint", {
                  days: displayDaysRemaining,
                  full: VND.format(fullMonthPerSlotWithVat),
                })
              : todayHint
          }
        />
        <Metric
          label={t("billing.fullMonthPerSlot")}
          value={
            fullMonthPerSlotWithVat !== null
              ? VND.format(fullMonthPerSlotWithVat)
              : "—"
          }
          hint={
            fullMonthPerSlot !== null
              ? t("billing.fullMonthPerSlotVatHint", {
                  preVat: VND.format(fullMonthPerSlot),
                  vatPct,
                  qty: baseInvoice?.quantity ?? "?",
                })
              : t("billing.fullMonthPerSlotHintV2")
          }
        />
        <Metric
          label={t("billing.renewalDate")}
          value={
            displayRenewal
              ? formatDate(displayRenewal, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : "—"
          }
          hint={
            displayCycleStart && displayRenewal
              ? t("billing.renewalCycleRange", {
                  start: formatDate(displayCycleStart, {
                    day: "numeric",
                    month: "short",
                  }),
                  end: formatDate(displayRenewal, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  }),
                })
              : t("billing.renewalCycle")
          }
        />
        <Metric
          label={t("billing.totalSeats")}
          value={totalSeats !== null && totalSeats > 0 ? String(totalSeats) : "—"}
          hint={t("billing.totalSeatsHint")}
        />
        <Metric
          label={t("billing.totalCyclePaid")}
          value={
            totalCyclePaidWithVat ? VND.format(totalCyclePaidWithVat) : "—"
          }
          hint={t("billing.totalCyclePaidHint", { n: cycleInvoices.length })}
        />
        <Metric
          label={t("billing.projectedNextCycle")}
          value={
            projectedNextCycleWithVat
              ? VND.format(projectedNextCycleWithVat)
              : "—"
          }
          hint={
            totalSeats && fullMonthPerSlotWithVat
              ? t("billing.projectedNextCycleHint", {
                  seats: totalSeats,
                  perSeat: VND.format(fullMonthPerSlotWithVat),
                })
              : t("billing.thisCycle")
          }
        />
        <Metric
          label={t("billing.invoiceCount")}
          value={String(cycleInvoices.length)}
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
          <table className="data-table" style={{ marginTop: 12, fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>{t("billing.colDate")}</th>
                <th style={{ textAlign: "right" }}>{t("billing.colAmount")}</th>
                <th style={{ textAlign: "center" }}>{t("billing.colQty")}</th>
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
                .map((inv, i) => (
                  <InvoiceRow
                    key={`${inv.date}-${inv.amount_vnd}-${i}`}
                    inv={inv}
                    formatDate={formatDate}
                    tInvoiceStatus={tInvoiceStatus}
                    notScraped={t("billing.notScrapedShort")}
                  />
                ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function InvoiceRow({
  inv,
  formatDate,
  tInvoiceStatus,
  notScraped,
}: {
  inv: BillingInvoice;
  formatDate: ReturnType<typeof useFormatDate>;
  tInvoiceStatus: (v: string) => string;
  notScraped: string;
}) {
  const scraped = inv.detail_scraped === true;
  const qty = inv.quantity;
  const unit = inv.unit_price_vnd;
  return (
    <tr>
      <td>{formatDate(inv.date)}</td>
      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
        {VND.format(inv.amount_vnd)}
      </td>
      <td style={{ textAlign: "center" }}>
        {qty != null ? (
          <span className="mono">{qty}</span>
        ) : (
          <span style={{ color: "var(--ink-3)" }} title={notScraped}>
            —
          </span>
        )}
      </td>
      <td
        style={{
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          color: unit != null ? "var(--ink-2)" : "var(--ink-3)",
        }}
        title={!scraped ? notScraped : undefined}
      >
        {unit != null ? VND.format(unit) : "—"}
      </td>
      <td>
        <span
          className={`badge ${
            inv.status === "paid"
              ? "badge-success"
              : inv.status === "unpaid" || inv.status === "void"
                ? "badge-danger"
                : "badge-neutral"
          }`}
        >
          {tInvoiceStatus(inv.status)}
        </span>
      </td>
    </tr>
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
