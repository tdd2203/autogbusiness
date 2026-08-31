/**
 * Trang "Bảng giá Canva" (super-admin) — sửa bảng bậc mặc định + gán hàng loạt cho
 * nhiều đại lý một lần.
 *
 * VÌ SAO CÓ HÀNG LOẠT: yêu cầu thẳng của user (2026-09-01). Đổi giá Canva mà phải mở
 * từng đại lý thì kiểu gì cũng sót một người, và người đó bán sai giá hàng tháng trời
 * mới lộ ra khi đối soát.
 *
 * VÌ SAO HAI Ô SOẠN RIÊNG: bản đầu dùng CHUNG một bảng cho cả giá mặc định lẫn giá
 * riêng — sửa số để đặt riêng cho một đại lý thì bảng mặc định trên màn hình cũng đổi
 * theo, nhìn không biết mình đang sửa cái nào (user 2026-09-01: "bảng giá này khó hiểu
 * quá"). Nay tách hẳn: thẻ trên chỉ là mặc định, ô soạn giá riêng chỉ hiện khi đã chọn
 * đại lý, và danh sách đại lý nói thẳng ai đang lệch khỏi mặc định.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorText } from "../../lib/api";
import { useI18n } from "../../i18n";
import {
  CANVA_PRICE_KEY,
  type CanvaPriceTier,
  type CanvaPriceTiers,
} from "../../hooks/useCanvaPrice";

type Row = { months: string; price: string };
type AgentUser = { id: string; username: string; email: string; is_super_admin: boolean };
type AgentOverride = { user_id: string; tiers: CanvaPriceTier[] };

const AGENT_PRICES_KEY = ["canva-price-agents"] as const;

function toRows(tiers?: CanvaPriceTier[]): Row[] {
  return (tiers ?? []).map((t) => ({
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

const fmt = (n: number) => Math.round(n).toLocaleString("vi-VN");

/** Đơn giá/tháng của bậc ngắn nhất — mốc để nói "mua dài rẻ hơn bao nhiêu". */
function basePerMonth(tiers: { months: number; price_vnd: number }[]): number {
  if (!tiers.length) return 0;
  const first = tiers.reduce((a, b) => (a.months <= b.months ? a : b));
  return first.months ? first.price_vnd / first.months : 0;
}

/** Hai bảng có y hệt nhau không (đã sắp xếp) — dùng để gộp lựa chọn nhiều đại lý. */
function sameTiers(a: CanvaPriceTier[], b: CanvaPriceTier[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.months === b[i].months && t.price_vnd === b[i].price_vnd);
}

/** Ô soạn một bảng bậc: nhập số, đọc ngay ra tiền mỗi tháng và rẻ hơn mấy phần trăm. */
export function TierEditor({
  rows,
  setRows,
}: {
  rows: Row[];
  setRows: (fn: (prev: Row[]) => Row[]) => void;
}) {
  const { t } = useI18n();
  const parsed = useMemo(() => parseRows(rows), [rows]);
  const base = basePerMonth(parsed);
  const shortest = parsed.length ? parsed[0].months : 0;
  const dupMonths = useMemo(() => {
    const seen = new Set<number>();
    return parsed.some((r) => (seen.has(r.months) ? true : (seen.add(r.months), false)));
  }, [parsed]);

  return (
    <>
      <table className="data-table" style={{ marginBottom: 8 }}>
        <thead>
          <tr>
            <th>{t("canva.colMonths")}</th>
            <th>{t("canva.colPrice")}</th>
            <th>{t("canva.colPerMonth")}</th>
            <th>{t("canva.colDiscount")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const months = Number(r.months) || 0;
            const price = Number(r.price) || 0;
            const perMonth = months > 0 ? price / months : 0;
            const pct = base > 0 && perMonth > 0 ? Math.round((1 - perMonth / base) * 100) : 0;
            return (
              <tr key={i}>
                <td style={{ width: 130 }}>
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
                <td style={{ width: 190 }}>
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
                  <div className="form-hint" style={{ marginTop: 2 }}>
                    {price > 0 ? t("canva.wholePackage", { amount: fmt(price) }) : " "}
                  </div>
                </td>
                <td>
                  {months > 0 ? (
                    <span>{t("canva.perMonthAmount", { amount: fmt(perMonth) })}</span>
                  ) : (
                    <span className="form-hint">—</span>
                  )}
                </td>
                <td>
                  {months <= 0 || price <= 0 || base <= 0 ? (
                    <span className="form-hint">—</span>
                  ) : months === shortest ? (
                    <span className="form-hint">{t("canva.tierBase")}</span>
                  ) : pct > 0 ? (
                    <span className="badge badge-success">
                      {t("canva.tierCheaper", { pct })}
                    </span>
                  ) : (
                    <span className="badge badge-warning">{t("canva.tierNotCheaper")}</span>
                  )}
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
      {dupMonths && (
        <div className="form-hint" style={{ marginBottom: 8 }}>
          {t("canva.dupMonths")}
        </div>
      )}
    </>
  );
}

export default function CanvaPricing() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [customRows, setCustomRows] = useState<Row[]>([]);
  // Chưa động vào ô giá riêng thì mỗi lần đổi lựa chọn lại nạp theo đại lý được chọn;
  // đã sửa tay rồi thì giữ nguyên, kẻo gõ dở lại bị nạp đè mất.
  const [customTouched, setCustomTouched] = useState(false);
  const [onlyCustom, setOnlyCustom] = useState(false);
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
  const overrides = useQuery<{ overrides: AgentOverride[] }>({
    queryKey: AGENT_PRICES_KEY,
    queryFn: () => api<{ overrides: AgentOverride[] }>("/api/v1/canva/price-tiers/agents"),
  });

  useEffect(() => {
    if (def.data) setRows(toRows(def.data.tiers));
  }, [def.data]);

  const agents = useMemo(
    () => (users.data ?? []).filter((u) => !u.is_super_admin),
    [users.data],
  );
  const overrideOf = useMemo(() => {
    const map = new Map<string, CanvaPriceTier[]>();
    for (const o of overrides.data?.overrides ?? []) map.set(o.user_id, o.tiers);
    return map;
  }, [overrides.data]);
  const shownAgents = useMemo(
    () => (onlyCustom ? agents.filter((u) => overrideOf.has(u.id)) : agents),
    [agents, onlyCustom, overrideOf],
  );

  const parsed = useMemo(() => parseRows(rows), [rows]);
  const customParsed = useMemo(() => parseRows(customRows), [customRows]);
  const defaultTiers = useMemo(() => def.data?.tiers ?? [], [def.data]);

  // Nạp ô giá riêng theo đại lý đang chọn: cả nhóm cùng một bảng thì lấy bảng đó,
  // khác nhau (hoặc đang dùng mặc định) thì lấy bảng mặc định làm điểm xuất phát.
  useEffect(() => {
    if (customTouched || picked.size === 0) return;
    const ids = [...picked];
    const first = overrideOf.get(ids[0]);
    const shared =
      first && ids.every((id) => {
        const t2 = overrideOf.get(id);
        return t2 && sameTiers(first, t2);
      });
    setCustomRows(toRows(shared ? first : defaultTiers));
  }, [picked, overrideOf, defaultTiers, customTouched]);

  const editCustom = (fn: (prev: Row[]) => Row[]) => {
    setCustomTouched(true);
    setCustomRows(fn);
  };

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
          tiers: clear ? [] : customParsed,
        }),
      }),
    onSuccess: (res, clear) => {
      setMsg(
        clear
          ? t("canva.priceClearedAgents", { count: res.updated })
          : t("canva.priceAppliedAgents", { count: res.updated }),
      );
      setCustomTouched(false);
      qc.invalidateQueries({ queryKey: AGENT_PRICES_KEY });
      qc.invalidateQueries({ queryKey: CANVA_PRICE_KEY });
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  const tiersSummary = (tiers: CanvaPriceTier[]) =>
    tiers
      .map((x) => `${t("canva.monthsShort", { count: x.months })} ${fmt(x.price_vnd)}`)
      .join(" · ");

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
        <TierEditor rows={rows} setRows={setRows} />
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

        <div className="flex gap-2" style={{ flexWrap: "wrap", marginBottom: 10 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setPicked(new Set(shownAgents.map((u) => u.id)))}
          >
            {t("canva.selectAll")}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>
            {t("canva.selectNone")}
          </button>
          <label className="flex items-center gap-2 form-hint" style={{ marginLeft: 4 }}>
            <input
              type="checkbox"
              checked={onlyCustom}
              onChange={(e) => setOnlyCustom(e.target.checked)}
            />
            <span>
              {t("canva.onlyCustom", { count: overrideOf.size })}
            </span>
          </label>
        </div>

        <div
          style={{
            maxHeight: 340,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            marginBottom: 12,
          }}
        >
          {shownAgents.length === 0 && (
            <div className="form-hint" style={{ padding: 10 }}>
              {t("canva.noAgents")}
            </div>
          )}
          {shownAgents.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>{t("canva.colAgent")}</th>
                  <th style={{ width: 130 }}>{t("canva.colPriceSource")}</th>
                  <th>{t("canva.colTiersSummary")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownAgents.map((u) => {
                  const own = overrideOf.get(u.id);
                  return (
                    <tr key={u.id}>
                      <td>
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
                      </td>
                      <td>
                        <div>{u.username}</div>
                        <div className="form-hint">{u.email}</div>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {own ? (
                          <span className="badge badge-info">{t("canva.sourceCustom")}</span>
                        ) : (
                          <span className="badge badge-neutral">{t("canva.sourceDefault")}</span>
                        )}
                      </td>
                      <td className="form-hint">
                        {own ? tiersSummary(own) : t("canva.usingDefault")}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setCustomTouched(false);
                            setPicked(new Set([u.id]));
                          }}
                        >
                          {t("common.edit")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {picked.size === 0 ? (
          <div className="form-hint">{t("canva.pickAgentsFirst")}</div>
        ) : (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {t("canva.customPanelTitle", { count: picked.size })}
            </div>
            <div className="form-hint" style={{ marginBottom: 10 }}>
              {t("canva.customPanelHint")}
            </div>
            <TierEditor rows={customRows} setRows={editCustom} />
            <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => editCustom((prev) => [...prev, { months: "", price: "" }])}
              >
                {t("canva.addTier")}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => editCustom(() => toRows(defaultTiers))}
              >
                {t("canva.copyDefault")}
              </button>
              <div style={{ flex: 1 }} />
              <button
                className="btn btn-ghost"
                disabled={applyAgents.isPending}
                onClick={() => {
                  setErr(null);
                  applyAgents.mutate(true);
                }}
              >
                {t("canva.clearAgentPrice")}
              </button>
              <button
                className="btn btn-primary"
                disabled={applyAgents.isPending || customParsed.length === 0}
                onClick={() => {
                  setErr(null);
                  applyAgents.mutate(false);
                }}
              >
                {t("canva.applyToAgents", { count: picked.size })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
