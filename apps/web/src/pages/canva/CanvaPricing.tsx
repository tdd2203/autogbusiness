/**
 * Trang "Bảng giá Canva" (super-admin) — sửa giá chung + đặt giá riêng cho từng đại lý
 * hoặc hàng loạt.
 *
 * VÌ SAO CÓ HÀNG LOẠT: yêu cầu thẳng của user (2026-09-01). Đổi giá Canva mà phải mở
 * từng đại lý thì kiểu gì cũng sót một người, và người đó bán sai giá hàng tháng trời
 * mới lộ ra khi đối soát.
 *
 * BỐ CỤC theo bản mockup user gửi (2026-09-01) sau khi chê bản bảng-trong-bảng "khó
 * hiểu quá": mỗi bậc là một dòng đọc thẳng ra tiền ("13.333 đ mỗi tháng", "rẻ hơn
 * 11%"), còn giá riêng thì SỬA NGAY TẠI DÒNG của đại lý — mở ra là thấy chênh bao
 * nhiêu so với giá chung, khỏi phải nhớ hai bảng cùng lúc.
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
type Filter = "all" | "custom" | "default";

const AGENT_PRICES_KEY = ["canva-price-agents"] as const;
const PAGE_STEP = 8;
/** Mức giảm nhanh so với giá chung — đủ dùng cho mọi lần thương lượng thường gặp. */
const QUICK_OFF = [5, 10, 15];

const fmt = (n: number) => Math.round(n || 0).toLocaleString("vi-VN");
/** Ô tiền chỉ giữ chữ số; người dùng gõ dấu chấm hay khoảng trắng đều không sao. */
const digits = (v: string) => v.replace(/[^0-9]/g, "");
const money = (v: string) => (v ? fmt(Number(v)) : "");

function toRows(tiers?: CanvaPriceTier[]): Row[] {
  return (tiers ?? []).map((t) => ({ months: String(t.months), price: String(t.price_vnd) }));
}

function parseRows(rows: Row[]): CanvaPriceTier[] {
  return rows
    .map((r) => ({ months: Number(r.months), price_vnd: Number(r.price) }))
    .filter(
      (r) =>
        Number.isFinite(r.months) &&
        r.months >= 1 &&
        Number.isFinite(r.price_vnd) &&
        r.price_vnd >= 0,
    )
    .sort((a, b) => a.months - b.months);
}

/** Giá theo tỉ lệ của giá chung, làm tròn 500đ cho số đẹp khi đọc. */
function scaled(tiers: CanvaPriceTier[], factor: number): CanvaPriceTier[] {
  return tiers.map((t) => ({
    months: t.months,
    price_vnd: Math.round((t.price_vnd * factor) / 500) * 500,
  }));
}

const perMonth = (months: number, price: number) => (months > 0 ? price / months : 0);

/* ── Mảnh dùng lại ─────────────────────────────────────────────────────────── */

/** Ô nhập tiền: số căn phải + hậu tố "đ" dính liền, khỏi ai nhầm với số tháng. */
function MoneyInput({
  value,
  onChange,
  width,
}: {
  value: string;
  onChange: (next: string) => void;
  width: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        width,
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      <input
        value={money(value)}
        inputMode="numeric"
        onChange={(e) => onChange(digits(e.target.value))}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "9px 11px",
          border: 0,
          outline: "none",
          textAlign: "right",
          fontSize: 15,
          fontWeight: 600,
          background: "transparent",
          color: "inherit",
        }}
      />
      <span
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 11px",
          fontSize: 13,
          color: "var(--ink-3)",
          background: "var(--surface-2)",
          borderLeft: "1px solid var(--border)",
        }}
      >
        đ
      </span>
    </div>
  );
}

function chipStyle(on: boolean): React.CSSProperties {
  return {
    padding: "7px 13px",
    borderRadius: 20,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    border: `1px solid ${on ? "var(--success)" : "var(--border-strong)"}`,
    background: on ? "var(--success)" : "var(--surface)",
    color: on ? "#fff" : "var(--ink-2)",
  };
}

const ROW_CARD: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "12px 14px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--surface-2)",
};

/* ── Trang ─────────────────────────────────────────────────────────────────── */

export default function CanvaPricing() {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<string>("");
  const [justSaved, setJustSaved] = useState(false);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE_STEP);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Row[]>([]);

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
    if (!def.data) return;
    setRows(toRows(def.data.tiers));
    setSaved(JSON.stringify(def.data.tiers));
  }, [def.data]);

  const common = useMemo(() => parseRows(rows), [rows]);
  const dirty = saved !== "" && JSON.stringify(common) !== saved;
  const commonBase = common.length ? perMonth(common[0].months, common[0].price_vnd) : 0;

  const agents = useMemo(
    () => (users.data ?? []).filter((u) => !u.is_super_admin),
    [users.data],
  );
  const overrideOf = useMemo(() => {
    const map = new Map<string, CanvaPriceTier[]>();
    for (const o of overrides.data?.overrides ?? []) map.set(o.user_id, o.tiers);
    return map;
  }, [overrides.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((u) => {
      if (q && !`${u.username} ${u.email}`.toLowerCase().includes(q)) return false;
      if (filter === "custom") return overrideOf.has(u.id);
      if (filter === "default") return !overrideOf.has(u.id);
      return true;
    });
  }, [agents, query, filter, overrideOf]);
  const page = filtered.slice(0, limit);
  const customCount = useMemo(
    () => agents.filter((u) => overrideOf.has(u.id)).length,
    [agents, overrideOf],
  );
  const allChecked = page.length > 0 && page.every((u) => picked.has(u.id));

  const saveCommon = useMutation({
    mutationFn: () =>
      api("/api/v1/canva/price-tiers/default", {
        method: "PUT",
        body: JSON.stringify({ tiers: common }),
      }),
    onSuccess: () => {
      setSaved(JSON.stringify(common));
      setJustSaved(true);
      setMsg(t("canva.priceSaved"));
      qc.invalidateQueries({ queryKey: ["canva-price-default"] });
      qc.invalidateQueries({ queryKey: CANVA_PRICE_KEY });
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  const applyAgents = useMutation({
    mutationFn: (v: { ids: string[]; tiers: CanvaPriceTier[] | null }) =>
      api<{ updated: number }>("/api/v1/canva/price-tiers/agents", {
        method: "PUT",
        body: JSON.stringify({ user_ids: v.ids, tiers: v.tiers ?? [] }),
      }),
    onSuccess: (res, v) => {
      setMsg(
        v.tiers
          ? t("canva.priceAppliedAgents", { count: res.updated })
          : t("canva.priceClearedAgents", { count: res.updated }),
      );
      qc.invalidateQueries({ queryKey: AGENT_PRICES_KEY });
      qc.invalidateQueries({ queryKey: CANVA_PRICE_KEY });
    },
    onError: (e) => setErr(apiErrorText(e)),
  });

  const runAgents = (ids: string[], tiers: CanvaPriceTier[] | null) => {
    if (!ids.length) return;
    setErr(null);
    applyAgents.mutate({ ids, tiers });
  };

  const openAgent = (u: AgentUser) => {
    if (openId === u.id) {
      setOpenId(null);
      return;
    }
    setOpenId(u.id);
    setDraft(toRows(overrideOf.get(u.id) ?? common));
  };

  const summaryOf = (tiers: CanvaPriceTier[]) =>
    tiers
      .map((x) => `${t("canva.monthsShort", { count: x.months })} ${fmt(x.price_vnd)}`)
      .join(" · ");

  /** Nhãn chênh lệch của một bậc so với giá chung — mốc để biết đang bán rẻ hay đắt. */
  const deltaOf = (months: number, price: number) => {
    const ref = common.find((c) => c.months === months);
    if (!ref || !ref.price_vnd) return { label: "—", color: "var(--ink-3)" };
    const diff = Math.round(((price - ref.price_vnd) / ref.price_vnd) * 100);
    if (diff === 0) return { label: t("canva.sameAsCommon"), color: "var(--ink-3)" };
    if (diff < 0)
      return {
        label: t("canva.tierCheaper", { pct: Math.abs(diff) }),
        color: "var(--success-strong)",
      };
    return { label: t("canva.tierPricier", { pct: diff }), color: "var(--danger)" };
  };

  return (
    <div style={{ maxWidth: 940 }}>
      <h1 className="display-h2" style={{ marginBottom: 4 }}>
        {t("canva.pricingTitle")}
      </h1>
      <div className="form-hint" style={{ marginBottom: 16 }}>
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

      <div className="surface-card" style={{ padding: 22 }}>
        {/* ── Giá chung ── */}
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("canva.commonTitle")}</div>
        <div className="form-hint" style={{ marginTop: 2 }}>
          {t("canva.commonHint")}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {rows.map((r, i) => {
            const months = Number(r.months) || 0;
            const price = Number(r.price) || 0;
            const pm = perMonth(months, price);
            const pct = commonBase > 0 && pm > 0 ? Math.round((1 - pm / commonBase) * 100) : 0;
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
                  width={180}
                  onChange={(next) =>
                    setRows((prev) => prev.map((x, j) => (j === i ? { ...x, price: next } : x)))
                  }
                />
                <div style={{ flex: 1, fontSize: 13.5, color: "var(--ink-2)" }}>
                  {months > 0 ? t("canva.perMonthEach", { amount: fmt(pm) }) : "—"}
                </div>
                <div
                  style={{
                    width: 104,
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

        <div style={{ height: 1, background: "var(--border)", margin: "22px 0 18px" }} />

        {/* ── Đại lý ── */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>
              {t("canva.agentsTitle")}{" "}
              <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>({agents.length})</span>
            </div>
            <div className="form-hint" style={{ marginTop: 2 }}>
              {t("canva.agentsHint")}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius)",
              padding: "8px 13px",
              background: "var(--surface)",
              minWidth: 250,
            }}
          >
            <span style={{ color: "var(--ink-4)" }}>⌕</span>
            <input
              value={query}
              placeholder={t("canva.searchAgent")}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE_STEP);
              }}
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                outline: "none",
                fontSize: 13.5,
                background: "transparent",
                color: "inherit",
              }}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          {(
            [
              ["all", t("canva.filterAll", { count: agents.length })],
              ["custom", t("canva.filterCustom", { count: customCount })],
              ["default", t("canva.filterDefault", { count: agents.length - customCount })],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              style={chipStyle(filter === key)}
              onClick={() => {
                setFilter(key);
                setLimit(PAGE_STEP);
              }}
            >
              {label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <span className="form-hint">
            {t("canva.resultLabel", { shown: page.length, total: filtered.length })}
          </span>
        </div>

        {picked.size > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 12,
              padding: "11px 14px",
              border: "1px solid var(--success-border)",
              borderRadius: "var(--radius)",
              background: "var(--success-bg)",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--success-strong)" }}>
              {t("canva.selectedCount", { count: picked.size })}
            </span>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{t("canva.applyPrice")}</span>
            <button
              className="btn btn-ghost btn-sm"
              disabled={applyAgents.isPending}
              onClick={() => runAgents([...picked], null)}
            >
              {t("canva.bulkCommon")}
            </button>
            {QUICK_OFF.map((p) => (
              <button
                key={p}
                className="btn btn-ghost btn-sm"
                disabled={applyAgents.isPending || common.length === 0}
                onClick={() => runAgents([...picked], scaled(common, 1 - p / 100))}
              >
                −{p}%
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>
              {t("canva.selectNone")}
            </button>
          </div>
        )}

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 12,
            padding: "0 4px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={allChecked}
            onChange={() =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (allChecked) page.forEach((u) => next.delete(u.id));
                else page.forEach((u) => next.add(u.id));
                return next;
              })
            }
            style={{ width: 16, height: 16, accentColor: "var(--success)" }}
          />
          <span className="form-hint">{t("canva.selectShown", { count: page.length })}</span>
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {page.map((u) => {
            const own = overrideOf.get(u.id);
            const isOpen = openId === u.id;
            const isPicked = picked.has(u.id);
            return (
              <div
                key={u.id}
                style={{
                  border: `1px solid ${
                    isOpen
                      ? "var(--success)"
                      : isPicked
                        ? "var(--success-border)"
                        : "var(--border)"
                  }`,
                  borderRadius: "var(--radius)",
                  overflow: "hidden",
                  background: isPicked && !isOpen ? "var(--success-bg)" : "var(--surface)",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 14px" }}
                >
                  <input
                    type="checkbox"
                    checked={isPicked}
                    onChange={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(u.id)) next.delete(u.id);
                        else next.add(u.id);
                        return next;
                      })
                    }
                    style={{ width: 16, height: 16, flex: "none", accentColor: "var(--success)" }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14.5, fontWeight: 600 }}>{u.username}</span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "2px 8px",
                          borderRadius: 20,
                          background: own ? "var(--role-super-bg)" : "var(--surface-2)",
                          color: own ? "var(--role-super)" : "var(--ink-3)",
                        }}
                      >
                        {own ? t("canva.sourceCustom") : t("canva.sourceDefault")}
                      </span>
                      <span className="form-hint">{u.email}</span>
                    </div>
                    <div
                      className="form-hint"
                      style={{
                        marginTop: 2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {own ? summaryOf(own) : t("canva.usingDefault")}
                    </div>
                  </div>
                  {own && (
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={applyAgents.isPending}
                      onClick={() => {
                        if (openId === u.id) setOpenId(null);
                        runAgents([u.id], null);
                      }}
                    >
                      {t("canva.clearAgentPrice")}
                    </button>
                  )}
                  <button
                    className={isOpen ? "btn btn-sm" : "btn btn-ghost btn-sm"}
                    onClick={() => openAgent(u)}
                  >
                    {isOpen
                      ? t("canva.editing")
                      : own
                        ? t("common.edit")
                        : t("canva.setCustomPrice")}
                  </button>
                </div>

                {isOpen && (
                  <div
                    style={{
                      borderTop: "1px solid var(--border)",
                      background: "var(--surface-2)",
                      padding: 14,
                    }}
                  >
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
                          disabled={common.length === 0}
                          onClick={() => setDraft(toRows(scaled(common, 1 - p / 100)))}
                        >
                          −{p}%
                        </button>
                      ))}
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={common.length === 0}
                        onClick={() => setDraft(toRows(common))}
                      >
                        {t("canva.copyCommon")}
                      </button>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {draft.map((r, i) => {
                        const months = Number(r.months) || 0;
                        const price = Number(r.price) || 0;
                        const delta = deltaOf(months, price);
                        return (
                          <div key={i} style={{ ...ROW_CARD, background: "var(--surface)" }}>
                            <div style={{ width: 92, fontSize: 14, fontWeight: 600 }}>
                              {t("canva.monthsShort", { count: months })}
                            </div>
                            <MoneyInput
                              value={r.price}
                              width={165}
                              onChange={(next) =>
                                setDraft((prev) =>
                                  prev.map((x, j) => (j === i ? { ...x, price: next } : x)),
                                )
                              }
                            />
                            <div style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>
                              {months > 0
                                ? t("canva.perMonthEach", { amount: fmt(perMonth(months, price)) })
                                : "—"}
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: delta.color }}>
                              {delta.label}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 13 }}>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={applyAgents.isPending || parseRows(draft).length === 0}
                        onClick={() => {
                          setOpenId(null);
                          runAgents([u.id], parseRows(draft));
                        }}
                      >
                        {t("common.save")}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setOpenId(null)}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {filtered.length === 0 && (
          <div
            style={{
              marginTop: 12,
              padding: 30,
              textAlign: "center",
              border: "1px dashed var(--border-strong)",
              borderRadius: "var(--radius)",
              fontSize: 13.5,
              color: "var(--ink-3)",
            }}
          >
            {agents.length === 0 ? t("canva.noAgents") : t("canva.noAgentFound")}
          </div>
        )}

        {filtered.length > page.length && (
          <button
            className="btn btn-ghost"
            style={{ width: "100%", marginTop: 12 }}
            onClick={() => setLimit((n) => n + 20)}
          >
            {t("canva.showMore", { count: Math.min(20, filtered.length - page.length) })}
          </button>
        )}
      </div>

      <div
        style={{
          position: "sticky",
          bottom: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 16,
          marginTop: 16,
          padding: "12px 16px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {dirty
            ? t("canva.commonDirty")
            : justSaved
              ? t("canva.commonSaved")
              : t("canva.commonClean")}
        </span>
        <button
          className="btn btn-primary"
          disabled={!dirty || saveCommon.isPending || common.length === 0}
          onClick={() => {
            setErr(null);
            saveCommon.mutate();
          }}
        >
          {saveCommon.isPending ? t("common.saving") : t("canva.saveDefault")}
        </button>
      </div>
    </div>
  );
}
