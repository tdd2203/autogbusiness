/**
 * Popup "Sửa giá" của MỘT tài khoản phụ (super-admin) — đặt giá riêng cho cả hai nền
 * tảng trong một lần mở.
 *
 * Mỗi nền tảng có công tắc "giá chung / giá riêng": chọn giá chung là xoá hẳn giá
 * riêng (gửi null) chứ không lưu một bản sao cứng — nếu lưu bản sao thì sau này chỉnh
 * giá chung, tài khoản này đứng im và bán sai giá hàng tháng trời mới lộ.
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
import {
  usePaymentSettings,
  useSetUserFee,
  useWalletAdminUsers,
} from "../hooks/useWallet";
import {
  chipStyle,
  fmtVnd,
  MoneyInput,
  parseRows,
  perMonth,
  type PriceRow,
  QUICK_OFF,
  ROW_CARD,
  scaled,
  toRows,
} from "./priceEditor";
import { PriceModalShell } from "./priceModalShell";
import { toast } from "./Toast";

type AgentOverride = { user_id: string; tiers: CanvaPriceTier[] };
type Mode = "common" | "own";

const AGENT_PRICES_KEY = ["canva-price-agents"] as const;

export default function UserPriceModal({
  userId,
  username,
  email,
  onClose,
}: {
  userId: string;
  username: string;
  email: string;
  onClose: () => void;
}) {
  const t = useT();
  const settings = usePaymentSettings();
  const walletUsers = useWalletAdminUsers();
  const canvaDefault = useQuery<CanvaPriceTiers>({
    queryKey: ["canva-price-default"],
    queryFn: () => api<CanvaPriceTiers>("/api/v1/canva/price-tiers/default"),
  });
  const canvaAgents = useQuery<{ overrides: AgentOverride[] }>({
    queryKey: AGENT_PRICES_KEY,
    queryFn: () =>
      api<{ overrides: AgentOverride[] }>("/api/v1/canva/price-tiers/agents"),
  });

  const loaded =
    !!settings.data && !!canvaDefault.data && !!walletUsers.data && !!canvaAgents.data;

  return (
    <PriceModalShell
      title={t("pricing.userTitle", { name: username })}
      subtitle={`${email} · ${t("pricing.userSubtitle")}`}
      onClose={onClose}
    >
      {loaded ? (
        <UserPriceForm
          userId={userId}
          username={username}
          commonFee={settings.data!.invite_fee_vnd}
          commonTiers={canvaDefault.data!.tiers}
          ownFee={
            walletUsers.data!.find((u) => u.user_id === userId)?.invite_fee_vnd ?? null
          }
          ownTiers={
            canvaAgents.data!.overrides.find((o) => o.user_id === userId)?.tiers ?? null
          }
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

/** Hai nút chọn nguồn giá của một nền tảng. */
function ModePicker({
  mode,
  onPick,
  labels,
}: {
  mode: Mode;
  onPick: (m: Mode) => void;
  labels: [string, string];
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {(
        [
          ["common", labels[0]],
          ["own", labels[1]],
        ] as [Mode, string][]
      ).map(([key, label]) => (
        <button key={key} style={chipStyle(mode === key)} onClick={() => onPick(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function UserPriceForm({
  userId,
  username,
  commonFee,
  commonTiers,
  ownFee,
  ownTiers,
  onClose,
}: {
  userId: string;
  username: string;
  commonFee: number;
  commonTiers: CanvaPriceTier[];
  ownFee: number | null;
  ownTiers: CanvaPriceTier[] | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const setFee = useSetUserFee();
  const setTiers = useMutation({
    mutationFn: (tiers: CanvaPriceTier[] | null) =>
      api<{ updated: number }>("/api/v1/canva/price-tiers/agents", {
        method: "PUT",
        body: JSON.stringify({ user_ids: [userId], tiers: tiers ?? [] }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AGENT_PRICES_KEY });
      qc.invalidateQueries({ queryKey: CANVA_PRICE_KEY });
    },
  });

  const [feeMode, setFeeMode] = useState<Mode>(ownFee == null ? "common" : "own");
  const [tierMode, setTierMode] = useState<Mode>(ownTiers ? "own" : "common");
  const [fee, setFeeText] = useState(String(ownFee ?? commonFee));
  const [rows, setRows] = useState<PriceRow[]>(() => toRows(ownTiers ?? commonTiers));

  const feeValue = Number(fee.trim());
  const feeOk = fee.trim() !== "" && Number.isFinite(feeValue) && feeValue >= 0;
  const tiers = parseRows(rows);
  const busy = setFee.isPending || setTiers.isPending;
  const canSave =
    (feeMode === "common" || feeOk) && (tierMode === "common" || tiers.length > 0);

  /** Nhãn chênh lệch so với giá chung — mốc để biết đang bán rẻ hay đắt. */
  function delta(ref: number | null | undefined, price: number) {
    if (!ref) return { label: "", color: "var(--ink-3)" };
    const diff = Math.round(((price - ref) / ref) * 100);
    if (diff === 0) return { label: t("canva.sameAsCommon"), color: "var(--ink-3)" };
    if (diff < 0)
      return {
        label: t("canva.tierCheaper", { pct: Math.abs(diff) }),
        color: "var(--success-strong)",
      };
    return { label: t("canva.tierPricier", { pct: diff }), color: "var(--danger)" };
  }

  async function save() {
    if (!canSave || busy) return;
    // Gõ đúng bằng giá chung = coi như dùng giá chung, khỏi lưu bản sao cứng.
    const nextFee =
      feeMode === "common" || feeValue === commonFee ? null : feeValue;
    const nextTiers = tierMode === "common" ? null : tiers;
    try {
      if (nextFee !== ownFee) await setFee.mutateAsync({ userId, invite_fee_vnd: nextFee });
      if (JSON.stringify(nextTiers) !== JSON.stringify(ownTiers)) {
        await setTiers.mutateAsync(nextTiers);
      }
      toast.success(t("pricing.userSaved", { name: username }));
      onClose();
    } catch (e) {
      toast.error(apiErrorText(e, t("pricing.saveError")));
    }
  }

  const modeLabels: [string, string] = [t("pricing.useCommon"), t("pricing.useOwn")];

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
        {/* ── ChatGPT ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("pricing.chatgpt")}</div>
            <div className="form-hint" style={{ marginTop: 2 }}>
              {t("pricing.commonFeeIs", { amount: fmtVnd(commonFee) })}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <ModePicker mode={feeMode} onPick={setFeeMode} labels={modeLabels} />
        </div>
        {feeMode === "own" && (
          <div style={ROW_CARD}>
            <div style={{ width: 190, fontSize: 13.5, fontWeight: 600 }}>
              {t("pricing.feeLabel")}
            </div>
            <MoneyInput value={fee} width={180} onChange={setFeeText} />
            <div style={{ flex: 1 }} />
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: delta(commonFee, feeValue || 0).color,
              }}
            >
              {delta(commonFee, feeValue || 0).label}
            </div>
          </div>
        )}

        <div style={{ height: 1, background: "var(--border)", margin: "22px 0 18px" }} />

        {/* ── Canva ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("pricing.canva")}</div>
            <div className="form-hint" style={{ marginTop: 2 }}>
              {commonTiers
                .map(
                  (x) =>
                    `${t("canva.monthsShort", { count: x.months })} ${fmtVnd(x.price_vnd)}`,
                )
                .join(" · ")}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <ModePicker mode={tierMode} onPick={setTierMode} labels={modeLabels} />
        </div>

        {tierMode === "own" && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                {t("canva.quickDiscount")}
              </span>
              {QUICK_OFF.map((p) => (
                <button
                  key={p}
                  className="btn btn-ghost btn-sm"
                  disabled={commonTiers.length === 0}
                  onClick={() => setRows(toRows(scaled(commonTiers, 1 - p / 100)))}
                >
                  −{p}%
                </button>
              ))}
              <button
                className="btn btn-ghost btn-sm"
                disabled={commonTiers.length === 0}
                onClick={() => setRows(toRows(commonTiers))}
              >
                {t("canva.copyCommon")}
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rows.map((r, i) => {
                const months = Number(r.months) || 0;
                const price = Number(r.price) || 0;
                const ref = commonTiers.find((c) => c.months === months);
                const d = delta(ref?.price_vnd, price);
                return (
                  <div key={i} style={ROW_CARD}>
                    <div style={{ width: 92, fontSize: 14, fontWeight: 600 }}>
                      {t("canva.monthsShort", { count: months })}
                    </div>
                    <MoneyInput
                      value={r.price}
                      width={165}
                      onChange={(next) =>
                        setRows((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, price: next } : x)),
                        )
                      }
                    />
                    <div style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>
                      {months > 0
                        ? t("canva.perMonthEach", { amount: fmtVnd(perMonth(months, price)) })
                        : "—"}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: d.color }}>
                      {d.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div
        style={{
          padding: "14px 22px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave || busy}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </>
  );
}
