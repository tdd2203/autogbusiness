/**
 * Trang "Bảng giá Canva" (super-admin) — sửa bảng bậc mặc định + gán hàng loạt cho
 * nhiều đại lý một lần.
 *
 * VÌ SAO CÓ HÀNG LOẠT: yêu cầu thẳng của user (2026-09-01). Đổi giá Canva mà phải mở
 * từng đại lý thì kiểu gì cũng sót một người, và người đó bán sai giá hàng tháng trời
 * mới lộ ra khi đối soát.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorText } from "../../lib/api";
import { useI18n } from "../../i18n";
import { CANVA_PRICE_KEY, type CanvaPriceTiers } from "../../hooks/useCanvaPrice";

type Row = { months: string; price: string };
type AgentUser = { id: string; username: string; email: string; is_super_admin: boolean };

function toRows(data?: CanvaPriceTiers): Row[] {
  return (data?.tiers ?? []).map((t) => ({
    months: String(t.months),
    price: String(t.price_vnd),
  }));
}

function parseRows(rows: Row[]): { months: number; price_vnd: number }[] {
  return rows
    .map((r) => ({ months: Number(r.months), price_vnd: Number(r.price) }))
    .filter((r) => Number.isFinite(r.months) && r.months >= 1 && Number.isFinite(r.price_vnd) && r.price_vnd >= 0)
    .sort((a, b) => a.months - b.months);
}

export default function CanvaPricing() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const def = useQuery<CanvaPriceTiers>({
    queryKey: ["canva-price-default"],
    queryFn: () => api<CanvaPriceTiers>("/api/v1/canva/price-tiers/default"),
  });
  const users = useQuery<AgentUser[]>({
    queryKey: ["users"],
    queryFn: () => api<AgentUser[]>("/api/v1/users"),
  });

  useEffect(() => {
    if (def.data) setRows(toRows(def.data));
  }, [def.data]);

  const agents = useMemo(
    () => (users.data ?? []).filter((u) => !u.is_super_admin),
    [users.data],
  );
  const parsed = useMemo(() => parseRows(rows), [rows]);

  const saveDefault = useMutation({
    mutationFn: () =>
      api("/api/v1/canva/price-tiers/default", {
        method: "PUT",
        body: JSON.stringify({ tiers: parsed }),
      }),
    onSuccess: () => {
      setMsg(t("canva.priceSaved"));
      qc.invalidateQueries({ queryKey: ["canva-price-default"] });
      qc.invalidateQueries({ queryKey: CANVA_PRICE_KEY });
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  const applyAgents = useMutation({
    mutationFn: (clear: boolean) =>
      api<{ updated: number }>("/api/v1/canva/price-tiers/agents", {
        method: "PUT",
        body: JSON.stringify({
          user_ids: [...picked],
          tiers: clear ? [] : parsed,
        }),
      }),
    onSuccess: (res) => {
      setMsg(t("canva.priceAppliedAgents", { count: res.updated }));
      qc.invalidateQueries({ queryKey: CANVA_PRICE_KEY });
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  return (
    <div>
      <h1 className="display-h2" style={{ marginBottom: 4 }}>
        {t("canva.pricingTitle")}
      </h1>
      <div className="form-hint" style={{ marginBottom: 20 }}>
        {t("canva.pricingSubtitle")}
      </div>

      {msg && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>{msg}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setMsg(null)}>
            {t("common.dismiss")}
          </button>
        </div>
      )}
      {err && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>{err}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setErr(null)}>
            {t("common.dismiss")}
          </button>
        </div>
      )}

      <div className="surface-card" style={{ padding: 20, marginBottom: 20 }}>
        <div className="display-h3" style={{ marginBottom: 4 }}>
          {t("canva.tiersTitle")}
        </div>
        <div className="form-hint" style={{ marginBottom: 12 }}>
          {t("canva.tiersHint")}
        </div>
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>{t("canva.colMonths")}</th>
              <th>{t("canva.colPrice")}</th>
              <th>{t("canva.colPerMonth")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const months = Number(r.months) || 0;
              const price = Number(r.price) || 0;
              return (
                <tr key={i}>
                  <td style={{ width: 140 }}>
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
                    />
                  </td>
                  <td style={{ width: 200 }}>
                    <input
                      className="form-input"
                      type="number"
                      min={0}
                      step={1000}
                      value={r.price}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)),
                        )
                      }
                    />
                  </td>
                  <td className="form-hint">
                    {months > 0 ? Math.round(price / months).toLocaleString("vi-VN") : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                    >
                      {t("common.delete")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex gap-2">
          <button
            className="btn btn-ghost"
            onClick={() => setRows((prev) => [...prev, { months: "", price: "" }])}
          >
            {t("canva.addTier")}
          </button>
          <button
            className="btn btn-primary"
            disabled={saveDefault.isPending || parsed.length === 0}
            onClick={() => {
              setErr(null);
              saveDefault.mutate();
            }}
          >
            {saveDefault.isPending ? t("common.saving") : t("canva.saveDefault")}
          </button>
        </div>
      </div>

      <div className="surface-card" style={{ padding: 20 }}>
        <div className="display-h3" style={{ marginBottom: 4 }}>
          {t("canva.bulkTitle")}
        </div>
        <div className="form-hint" style={{ marginBottom: 12 }}>
          {t("canva.bulkHint")}
        </div>
        <div
          style={{
            maxHeight: 260,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 10,
            marginBottom: 12,
          }}
        >
          {agents.length === 0 && <div className="form-hint">{t("canva.noAgents")}</div>}
          {agents.map((u) => (
            <label key={u.id} className="flex items-center gap-2" style={{ padding: "4px 0" }}>
              <input
                type="checkbox"
                checked={picked.has(u.id)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(u.id);
                    else next.delete(u.id);
                    return next;
                  })
                }
              />
              <span>{u.username}</span>
              <span className="form-hint">{u.email}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setPicked(new Set(agents.map((u) => u.id)))}
          >
            {t("canva.selectAll")}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>
            {t("canva.selectNone")}
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-ghost"
            disabled={applyAgents.isPending || picked.size === 0}
            onClick={() => {
              setErr(null);
              applyAgents.mutate(true);
            }}
          >
            {t("canva.clearAgentPrice")}
          </button>
          <button
            className="btn btn-primary"
            disabled={applyAgents.isPending || picked.size === 0 || parsed.length === 0}
            onClick={() => {
              setErr(null);
              applyAgents.mutate(false);
            }}
          >
            {t("canva.applyToAgents", { count: picked.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
