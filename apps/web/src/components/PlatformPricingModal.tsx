/**
 * Modal "Bảng giá" (super-admin) — giá CHUNG của từng nền tảng, mở từ trang Tài khoản
 * phụ.
 *
 * Gộp về đây vì giá chung và giá riêng của đại lý là một câu chuyện: trước đây giá
 * ChatGPT nằm trong Quản trị Ví, giá Canva nằm ở một trang riêng, đổi giá là phải đi
 * hai nơi và chẳng nhìn thấy hai nền tảng cạnh nhau (user 2026-09-01).
 *
 * Hai nền tảng bán KHÁC nhau về bản chất nên mỗi khối một dạng nhập: ChatGPT thu một
 * mức phí cho mỗi lượt mời/gia hạn, Canva bán theo bậc tháng (mua dài rẻ hơn).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorText } from "../lib/api";
import { useT } from "../i18n";
import {
  CANVA_PRICE_KEY,
  type CanvaPriceTier,
  type CanvaPriceTiers,
} from "../hooks/useCanvaPrice";
import { usePaymentSettings, useUpdatePaymentSettings } from "../hooks/useWallet";
import {
  fmtVnd,
  MoneyInput,
  parseRows,
  perMonth,
  type PriceRow,
  ROW_CARD,
  toRows,
} from "./priceEditor";
import { PriceModalShell } from "./priceModalShell";
import { toast } from "./Toast";

export default function PlatformPricingModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const settings = usePaymentSettings();
  const canvaDefault = useQuery<CanvaPriceTiers>({
    queryKey: ["canva-price-default"],
    queryFn: () => api<CanvaPriceTiers>("/api/v1/canva/price-tiers/default"),
  });
  const loaded = !!settings.data && !!canvaDefault.data;

  return (
    <PriceModalShell
      title={t("pricing.commonTitle")}
      subtitle={t("pricing.commonSubtitle")}
      onClose={onClose}
    >
      {loaded ? (
        <CommonPriceForm
          fee={settings.data!.invite_fee_vnd}
          tiers={canvaDefault.data!.tiers}
          onClose={onClose}
        />
      ) : (
        <div style={{ padding: "18px 22px" }} className="form-hint">
          {t("common.loading")}
        </div>
      )}
    </PriceModalShell>
  );
}

/** Tách riêng để ô nhập lấy giá đang lưu làm giá trị ĐẦU — khỏi cần useEffect nạp lại
 *  (nạp bằng effect thì lần dựng đầu ô trống, nhìn như giá bị xoá). */
function CommonPriceForm({
  fee: savedFee,
  tiers: savedTiers,
  onClose,
}: {
  fee: number;
  tiers: CanvaPriceTier[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const saveSettings = useUpdatePaymentSettings();
  const saveTiers = useMutation({
    mutationFn: (tiers: CanvaPriceTier[]) =>
      api("/api/v1/canva/price-tiers/default", {
        method: "PUT",
        body: JSON.stringify({ tiers }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["canva-price-default"] });
      qc.invalidateQueries({ queryKey: CANVA_PRICE_KEY });
    },
  });

  const [fee, setFee] = useState(String(savedFee));
  const [rows, setRows] = useState<PriceRow[]>(() => toRows(savedTiers));

  const tiers = parseRows(rows);
  const base = tiers.length ? perMonth(tiers[0].months, tiers[0].price_vnd) : 0;
  const feeValue = Number(fee.trim());
  const feeOk = fee.trim() !== "" && Number.isFinite(feeValue) && feeValue >= 0;
  const feeDirty = feeOk && feeValue !== savedFee;
  const tiersDirty =
    tiers.length > 0 && JSON.stringify(tiers) !== JSON.stringify(savedTiers);
  const busy = saveSettings.isPending || saveTiers.isPending;

  async function save() {
    if (!feeDirty && !tiersDirty) return;
    try {
      if (feeDirty) await saveSettings.mutateAsync({ invite_fee_vnd: feeValue });
      if (tiersDirty) await saveTiers.mutateAsync(tiers);
      toast.success(t("pricing.commonSaved"));
      onClose();
    } catch (e) {
      toast.error(apiErrorText(e, t("pricing.saveError")));
    }
  }

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
        {/* ── ChatGPT ── */}
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("pricing.chatgpt")}</div>
        <div className="form-hint" style={{ marginTop: 2, marginBottom: 10 }}>
          {t("pricing.chatgptHint")}
        </div>
        <div style={ROW_CARD}>
          <div style={{ width: 190, fontSize: 13.5, fontWeight: 600 }}>
            {t("pricing.feeLabel")}
          </div>
          <MoneyInput value={fee} width={180} onChange={setFee} />
          <div style={{ flex: 1 }} />
        </div>

        <div style={{ height: 1, background: "var(--border)", margin: "22px 0 18px" }} />

        {/* ── Canva ── */}
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("pricing.canva")}</div>
        <div className="form-hint" style={{ marginTop: 2, marginBottom: 10 }}>
          {t("pricing.canvaHint")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r, i) => {
            const months = Number(r.months) || 0;
            const price = Number(r.price) || 0;
            const pm = perMonth(months, price);
            const pct = base > 0 && pm > 0 ? Math.round((1 - pm / base) * 100) : 0;
            return (
              <div key={i} style={ROW_CARD}>
                <div style={{ width: 92, display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    value={r.months}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, months: e.target.value } : x)),
                      )
                    }
                    style={{ width: 52, textAlign: "center", padding: "8px 6px" }}
                  />
                  <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                    {t("canva.monthsUnit")}
                  </span>
                </div>
                <MoneyInput
                  value={r.price}
                  width={165}
                  onChange={(next) =>
                    setRows((prev) => prev.map((x, j) => (j === i ? { ...x, price: next } : x)))
                  }
                />
                <div style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>
                  {months > 0 ? t("canva.perMonthEach", { amount: fmtVnd(pm) }) : "—"}
                </div>
                <div
                  style={{
                    width: 92,
                    textAlign: "right",
                    fontSize: 13,
                    fontWeight: 600,
                    color: pct > 0 ? "var(--success-strong)" : "var(--ink-3)",
                  }}
                >
                  {months > 0 && price > 0
                    ? pct > 0
                      ? t("canva.tierCheaper", { pct })
                      : t("canva.tierBase")
                    : ""}
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  title={t("common.delete")}
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => setRows((prev) => [...prev, { months: "", price: "" }])}
        >
          {t("canva.addTier")}
        </button>
      </div>

      <div
        style={{
          padding: "14px 22px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span className="form-hint" style={{ marginRight: "auto" }}>
          {feeDirty || tiersDirty ? t("pricing.dirty") : t("pricing.clean")}
        </span>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={busy || (!feeDirty && !tiersDirty)}
        >
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </>
  );
}
