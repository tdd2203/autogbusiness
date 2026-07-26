/**
 * Modal DÁN chi tiết hoá đơn (thay cho scrape). Mở khi bấm "Cập nhật giá & ngày
 * renew". Người dùng dán toàn bộ text chi tiết hoá đơn Stripe → parse phía web
 * (invoice-parse.ts) → xem trước → Lưu (POST /billing-paste) → panel cập nhật.
 */

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useT, useFormatDate } from "../i18n";
import { api } from "../lib/api";
import { parseInvoiceText, isParsedInvoiceUsable } from "../lib/invoice-parse";
import { toast } from "./Toast";

const VND = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export function PasteInvoiceModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const qc = useQueryClient();
  const [raw, setRaw] = useState("");

  const parsed = useMemo(() => (raw.trim() ? parseInvoiceText(raw) : null), [raw]);
  const usable = parsed !== null && isParsedInvoiceUsable(parsed);
  const perSeatWithVat =
    parsed?.unit_price_vnd != null
      ? Math.round(parsed.unit_price_vnd * 1.1)
      : null;

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/workspaces/${workspaceId}/billing-paste`, {
        method: "POST",
        body: JSON.stringify(parsed),
      }),
    onSuccess: () => {
      toast.success(t("billing.pasteSaved"));
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      style={{ padding: 24 }}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={{
          width: "min(680px, 100%)",
          maxHeight: "90vh",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 20,
          boxShadow:
            "0 40px 90px -30px rgba(0,0,0,.45), 0 12px 30px -14px rgba(0,0,0,.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "18px 22px",
            display: "flex",
            alignItems: "flex-start",
            gap: 14,
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
              {t("billing.pasteTitle")}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              {t("billing.pasteSubtitle")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={save.isPending}
            aria-label={t("common.cancel")}
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--ink-2)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 22, overflowY: "auto" }}>
          <textarea
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={t("billing.pastePlaceholder")}
            className="form-input"
            style={{
              width: "100%",
              minHeight: 200,
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.5,
              resize: "vertical",
            }}
          />

          {parsed && (
            <div
              style={{
                marginTop: 16,
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 14,
                background: "var(--bg)",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--ink-3)",
                  fontWeight: 500,
                  marginBottom: 10,
                }}
              >
                {t("billing.pasteParsePreview")}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: 12,
                }}
              >
                <PreviewCell
                  label={t("billing.pasteSeat")}
                  value={parsed.quantity != null ? String(parsed.quantity) : "—"}
                  bad={parsed.quantity == null}
                />
                <PreviewCell
                  label={t("billing.pastePerSeat")}
                  value={perSeatWithVat != null ? VND.format(perSeatWithVat) : "—"}
                  bad={perSeatWithVat == null}
                />
                <PreviewCell
                  label={t("billing.pasteCycle")}
                  value={
                    parsed.period_start && parsed.period_end
                      ? `${formatDate(new Date(parsed.period_start), { day: "numeric", month: "short" })} → ${formatDate(new Date(parsed.period_end), { day: "numeric", month: "short", year: "numeric" })}`
                      : "—"
                  }
                  bad={!parsed.period_end}
                />
                <PreviewCell
                  label={t("billing.pasteTotal")}
                  value={parsed.total_vnd != null ? VND.format(parsed.total_vnd) : "—"}
                  bad={parsed.total_vnd == null}
                />
              </div>
              {!usable && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 10 }}>
                  {t("billing.pasteInvalid")}
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "14px 22px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={save.isPending}
            className="btn btn-ghost"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!usable || save.isPending}
            className="btn btn-primary"
          >
            {save.isPending ? t("billing.pasteSaving") : t("billing.pasteSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewCell({
  label,
  value,
  bad,
}: {
  label: string;
  value: string;
  bad?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          color: bad ? "var(--ink-3)" : "var(--ink)",
          marginTop: 3,
        }}
      >
        {value}
      </div>
    </div>
  );
}
