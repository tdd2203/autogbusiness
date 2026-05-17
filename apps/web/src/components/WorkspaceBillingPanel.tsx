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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { confirm, toast } from "./Toast";
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
): { price: number | null; basedOn: BillingInvoice | null; note: string } {
  if (!invoices || invoices.length === 0) {
    return { price: null, basedOn: null, note: "no_invoices" };
  }
  if (!renewalIso) {
    return { price: null, basedOn: null, note: "no_renewal_date" };
  }
  const renewal = new Date(renewalIso);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysToday = daysBetween(today, renewal);
  if (daysToday <= 0) {
    return { price: null, basedOn: null, note: "cycle_ended" };
  }

  // Sắp invoices theo date desc — lấy invoice gần nhất single-slot
  // (heuristic: amount nhỏ nhất trong list = giá 1 slot, vì các invoice multi-slot
  // sẽ có amount > giá 1 slot tại cùng ngày).
  // Simpler: dùng invoice mới nhất, giả định là 1 slot.
  const sorted = [...invoices].sort((a, b) =>
    new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  const recent = sorted[0];
  const recentDate = new Date(recent.date);
  recentDate.setUTCHours(0, 0, 0, 0);
  const daysAtRecent = daysBetween(recentDate, renewal);
  if (daysAtRecent <= 0) {
    return { price: null, basedOn: recent, note: "recent_invoice_after_renewal" };
  }

  const price = Math.round(recent.amount_vnd * (daysToday / daysAtRecent));
  return { price, basedOn: recent, note: "ok" };
}

export function WorkspaceBillingPanel({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const qc = useQueryClient();
  const invoices = workspace.billing_invoices ?? [];
  const renewal = workspace.renewal_date;
  const { price: todayPrice, basedOn, note } = computeTodayPerSlotPrice(
    invoices,
    renewal,
  );

  const renewalDate = renewal ? new Date(renewal) : null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysRemaining = renewalDate ? daysBetween(today, renewalDate) : null;

  const lastSyncedAt = workspace.last_billing_synced_at
    ? new Date(workspace.last_billing_synced_at)
    : null;
  const alreadySynced = lastSyncedAt !== null;

  const syncBilling = useMutation({
    mutationFn: async () => {
      // Đã sync rồi → cảnh báo nhưng vẫn cho phép. Giá per-slot và renewal
      // date là static trong cùng chu kỳ, sync lại không thay đổi gì → user
      // confirm xong mới gọi API.
      if (alreadySynced && lastSyncedAt) {
        const ok = await confirm(
          t("billing.alreadySyncedWarn", {
            time: lastSyncedAt.toLocaleString("vi-VN"),
          }),
          {
            title: t("billing.workspaceTitle"),
            okText: t("billing.syncAgainAnyway"),
            cancelText: t("common.cancel"),
          },
        );
        if (!ok) throw new Error("__user_cancel__");
      }
      return api<{ queue_item_id: string; status: string }>(
        `/api/v1/workspaces/${workspace.id}/sync-billing`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success(t("billing.syncQueuedToast"));
      qc.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "__user_cancel__") return;
      const msg =
        e instanceof ApiError
          ? String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(t("billing.syncErrorToast", { error: msg }));
    },
  });

  if (invoices.length === 0 && !workspace.last_billing_synced_at) {
    // Chưa sync lần nào — hiện 1 nút prompt
    return (
      <div className="surface-card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="flex items-baseline justify-between" style={{ gap: 12 }}>
          <h3 className="display-h3">{t("billing.workspaceTitle")}</h3>
          <button
            onClick={() => syncBilling.mutate()}
            disabled={syncBilling.isPending}
            className="btn btn-primary btn-sm"
            title={t("billing.syncTooltip")}
          >
            {syncBilling.isPending
              ? t("billing.syncBusy")
              : t("billing.syncButton")}
          </button>
        </div>
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
      <div className="flex items-center justify-between" style={{ gap: 12 }}>
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
        <button
          onClick={() => syncBilling.mutate()}
          disabled={syncBilling.isPending}
          className={`btn btn-sm ${alreadySynced ? "btn-ghost" : "btn-primary"}`}
          title={t("billing.syncTooltip")}
        >
          {syncBilling.isPending
            ? t("billing.syncBusy")
            : t("billing.syncButton")}
        </button>
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
                  : basedOn
                    ? t("billing.basedOnInvoice", {
                        date: new Date(basedOn.date).toLocaleDateString(),
                        amount: VND.format(basedOn.amount_vnd),
                      })
                    : ""
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
