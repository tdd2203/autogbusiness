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

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFormatDate, useT, useTranslateEnum } from "../i18n";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import type { BillingInvoice, Workspace } from "../types";
import {
  computeBillingCycle,
  cycleStartFromRenewal,
  daysBetween,
  invoiceSeatPricing,
} from "./billing-math";
import { toast } from "./Toast";

const VND = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export function WorkspaceBillingPanel({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const formatDate = useFormatDate();
  const tInvoiceStatus = useTranslateEnum("invoice");
  const { user } = useAuth();
  const qc = useQueryClient();
  const canEditFee = !!user?.is_super_admin;
  const invoices = workspace.billing_invoices ?? [];

  const cycle = computeBillingCycle(
    invoices,
    workspace.renewal_date,
    undefined,
    workspace.seat_used ?? workspace.seat_total ?? null,
  );
  const {
    note,
    estimated,
    renewalDate,
    cycleStart,
    daysRemaining,
    fullMonthPerSlot,
    fullMonthPerSlotWithVat,
    feePerSeat,
    feeSeats,
    fullMonthPerSlotWithFee,
    vatRate,
    todayPriceWithFee,
    totalSeats,
    totalCyclePaidWithVat,
    totalCycleFees,
    totalCyclePaidWithFees,
    projectedNextCycleWithVat,
    cycleInvoices,
    baseInvoice,
  } = cycle;
  const vatPct = vatRate != null ? Math.round(vatRate * 100) : 10;

  // Nhập/xoá phí ngân hàng cho 1 hoá đơn (super-admin). Định danh hoá đơn bằng
  // invoice_number (fallback date+amount) — khớp logic BE. Xong → invalidate query
  // workspace để bảng + tổng "thực trả" đọc lại bản sống.
  const feeMut = useMutation({
    mutationFn: (vars: { inv: BillingInvoice; fee: number | null }) =>
      api(`/api/v1/workspaces/${workspace.id}/billing-invoices/fee`, {
        method: "PATCH",
        body: JSON.stringify({
          invoice_number: vars.inv.invoice_number ?? null,
          date: vars.inv.date,
          amount_vnd: vars.inv.amount_vnd,
          service_fee_vnd: vars.fee,
        }),
      }),
    onSuccess: () => {
      toast.success(t("billing.feeSaved"));
      qc.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

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
            : note === "estimated"
              ? t("billing.estimatedHint")
              : baseInvoice && fullMonthPerSlotWithFee !== null && displayDaysRemaining !== null
              ? t("billing.todayFromBase", {
                  base: VND.format(fullMonthPerSlotWithFee),
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
        {estimated && (
          <span className="badge badge-neutral" title={t("billing.estimatedHint")}>
            {t("billing.estimatedBadge")}
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
          label={
            feePerSeat
              ? t("billing.remainingDaysPriceWithFee")
              : t("billing.remainingDaysPrice")
          }
          value={todayPriceWithFee !== null ? VND.format(todayPriceWithFee) : "—"}
          hint={
            todayPriceWithFee !== null && fullMonthPerSlotWithFee !== null && displayDaysRemaining !== null
              ? t("billing.remainingDaysPriceHint", {
                  days: Math.min(displayDaysRemaining, 30),
                  full: VND.format(fullMonthPerSlotWithFee),
                })
              : todayHint
          }
        />
        <Metric
          label={
            feePerSeat
              ? t("billing.fullMonthPerSlotWithFee")
              : t("billing.fullMonthPerSlot")
          }
          value={
            fullMonthPerSlotWithFee !== null
              ? VND.format(fullMonthPerSlotWithFee)
              : "—"
          }
          hint={
            fullMonthPerSlot === null
              ? t("billing.fullMonthPerSlotHintV2")
              : feePerSeat
                ? t("billing.fullMonthPerSlotFeeHint", {
                    withVat: VND.format(fullMonthPerSlotWithVat ?? 0),
                    feePerSeat: VND.format(feePerSeat),
                    totalFees: VND.format(totalCycleFees ?? 0),
                    seats: feeSeats ?? totalSeats ?? "?",
                  })
                : t("billing.fullMonthPerSlotVatHint", {
                    preVat: VND.format(fullMonthPerSlot),
                    vatPct,
                    qty: baseInvoice?.quantity ?? "?",
                  })
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
          label={t("billing.totalCyclePaidWithFees")}
          value={
            totalCyclePaidWithFees ? VND.format(totalCyclePaidWithFees) : "—"
          }
          hint={
            totalCycleFees
              ? t("billing.totalCyclePaidWithFeesHint", {
                  fees: VND.format(totalCycleFees),
                })
              : t("billing.totalCyclePaidWithFeesNoFee")
          }
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
                <th style={{ textAlign: "right" }} title={t("billing.colPerSeatMonthTooltip")}>
                  {t("billing.colPerSeatMonth")}
                </th>
                <th style={{ textAlign: "right" }} title={t("billing.colPerSeatRemainingTooltip")}>
                  {t("billing.colPerSeatRemaining")}
                </th>
                <th style={{ textAlign: "right" }}>{t("billing.colFee")}</th>
                <th style={{ textAlign: "right" }} title={t("billing.colActualTooltip")}>
                  {t("billing.colActual")}
                </th>
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
                    actualTooltip={t("billing.colActualTooltip")}
                    monthTooltip={t("billing.colPerSeatMonthTooltip")}
                    remainingTooltip={t("billing.colPerSeatRemainingTooltip")}
                    canEditFee={canEditFee}
                    feePlaceholder={t("billing.feePlaceholder")}
                    savingFee={feeMut.isPending}
                    onSaveFee={(fee) => feeMut.mutate({ inv, fee })}
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
  actualTooltip,
  monthTooltip,
  remainingTooltip,
  canEditFee,
  feePlaceholder,
  savingFee,
  onSaveFee,
}: {
  inv: BillingInvoice;
  formatDate: ReturnType<typeof useFormatDate>;
  tInvoiceStatus: (v: string) => string;
  notScraped: string;
  actualTooltip: string;
  monthTooltip: string;
  remainingTooltip: string;
  canEditFee: boolean;
  feePlaceholder: string;
  savingFee: boolean;
  onSaveFee: (fee: number | null) => void;
}) {
  const scraped = inv.detail_scraped === true;
  const qty = inv.quantity;
  // Thực trả = số tiền hoá đơn (gồm VAT) + phí ngân hàng nhập tay. Khớp logic
  // totalCyclePaidWithFees ở billing-math (ưu tiên total_vnd, fallback amount_vnd).
  const actual =
    (inv.total_vnd ?? inv.amount_vnd ?? 0) + (inv.service_fee_vnd ?? 0);
  // Giá/seat của RIÊNG hoá đơn này: giá tháng (đơn giá×VAT + phí/seat, loại
  // proration) + giá cho ngày còn lại (÷30, kẹp ≤ giá tháng). Tự tính theo tỉ giá
  // của chính hoá đơn. Cập nhật ngay khi nhập phí NH.
  const { monthlyPerSeat, remainingPerSeat } = invoiceSeatPricing(inv);
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
          color: monthlyPerSeat != null ? "var(--ink-2)" : "var(--ink-3)",
        }}
        title={
          monthlyPerSeat != null ? monthTooltip : !scraped ? notScraped : undefined
        }
      >
        {monthlyPerSeat != null ? VND.format(monthlyPerSeat) : "—"}
      </td>
      <td
        style={{
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          color: remainingPerSeat != null ? "var(--ink-2)" : "var(--ink-3)",
        }}
        title={
          remainingPerSeat != null
            ? remainingTooltip
            : !scraped
              ? notScraped
              : undefined
        }
      >
        {remainingPerSeat != null ? VND.format(remainingPerSeat) : "—"}
      </td>
      <td style={{ textAlign: "right" }}>
        <FeeCell
          fee={inv.service_fee_vnd ?? null}
          canEdit={canEditFee}
          placeholder={feePlaceholder}
          saving={savingFee}
          onSave={onSaveFee}
        />
      </td>
      <td
        style={{
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
        }}
        title={actualTooltip}
      >
        {VND.format(actual)}
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

/**
 * Ô nhập phí ngân hàng cho 1 hoá đơn. Super-admin → input số (chấp nhận dấu chấm/
 * phẩy, chỉ giữ chữ số); rỗng = xoá phí. Lưu khi blur/Enter, chỉ gọi API khi đổi.
 * Người không phải super-admin → chỉ xem.
 */
function FeeCell({
  fee,
  canEdit,
  placeholder,
  saving,
  onSave,
}: {
  fee: number | null;
  canEdit: boolean;
  placeholder: string;
  saving: boolean;
  onSave: (fee: number | null) => void;
}) {
  const [val, setVal] = useState(fee != null ? String(fee) : "");
  // Đồng bộ lại khi bản sống đổi (sau khi lưu → invalidate refetch workspace).
  useEffect(() => {
    setVal(fee != null ? String(fee) : "");
  }, [fee]);

  if (!canEdit) {
    return (
      <span
        style={{
          fontFamily: "var(--font-mono)",
          color: fee != null ? "var(--ink-2)" : "var(--ink-3)",
        }}
      >
        {fee != null ? VND.format(fee) : "—"}
      </span>
    );
  }

  const commit = () => {
    const digits = val.replace(/[^\d]/g, "");
    const next = digits === "" ? null : Number(digits);
    if (next === (fee ?? null)) {
      // Không đổi → reset hiển thị về giá trị chuẩn (bỏ ký tự phân tách user gõ).
      setVal(fee != null ? String(fee) : "");
      return;
    }
    onSave(next);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={val}
      placeholder={placeholder}
      disabled={saving}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="form-input"
      style={{
        width: 110,
        padding: "4px 6px",
        fontSize: 12.5,
        textAlign: "right",
        fontFamily: "var(--font-mono)",
      }}
    />
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
