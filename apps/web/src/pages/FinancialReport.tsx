/**
 * Báo cáo tài chính (feature 003 — super-admin). Chốt bởi user 2026-07-14:
 *   - THU (doanh thu) = phí mời + phí gia hạn (đọc từ sổ cái ví).
 *   - CHI (chi phí) = tiền thực trả ChatGPT (hoá đơn Stripe 'paid' của workspace).
 *   - LỢI NHUẬN = THU − CHI (gộp mời + gia hạn — "cách A").
 *   - Có bảng doanh thu theo đại lý. KHÔNG hiện công nợ, KHÔNG hiện rút tiền.
 * Chốt bổ sung 2026-08-11: CẢ HAI vế ghi nhận DỒN TÍCH THEO NGÀY (backend rải phí
 * kỳ member trên [start, end) và hoá đơn ChatGPT trên [period_start, period_end)),
 * nên mọi khoảng — kể cả nửa tháng — đều so sánh được. Trước đó THU tính một cục
 * lúc mời/gia hạn còn CHI tính theo ngày hoá đơn → tháng nào không có hoá đơn Stripe
 * phát hành là CHI = 0, biên lợi nhuận 100% ảo.
 *
 * Giao diện mới (mockup "Báo cáo tài chính.dc.html", 2026-07-14): KPI kèm
 * sparkline, biểu đồ cột Thu&Chi theo tháng (HTML/flex), bảng lãi/lỗ (P&L),
 * cơ cấu doanh thu dạng donut + top đại lý, và bảng đại lý đầy đủ trong modal.
 * Số liệu lấy qua useFinancialReport; đổi kỳ → query key đổi → tự refetch.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useFinancialCycles, useFinancialReport } from "../hooks/useWallet";
import { EmailStatsModal } from "../components/EmailStatsModal";
import { type FinancialReport } from "../lib/wallet";

// ── Bảng màu biểu đồ (dữ liệu, không phải chrome) — khớp mockup ──────────────
const REV = "#3a5bd0"; // doanh thu (= --perm-member)
const REV_TOP = "#5c7ce0";
const REV_BG = "#eef2fd";
const COST = "#c99b3f"; // chi phí ChatGPT
const COST_TOP = "#dcb35c";
const COST_TEXT = "#a8791f";
const COST_BG = "#f7eecf";
const GAIN = "#0a6b3b"; // lãi (= --perm-view)

// ── Presets khoảng thời gian ────────────────────────────────────────────────

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type Preset = { key: string; label: string; range: () => { from: string; to: string } };

/** Ngày CUỐI tháng hiện tại (day 0 của tháng sau = ngày cuối tháng này). */
function endOfThisMonth(): string {
  const now = new Date();
  return fmtDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

// Mọi preset đều kết thúc ở NGÀY CUỐI THÁNG HIỆN TẠI, không dừng ở hôm nay (chốt user
// 2026-08-12: "lấy theo tháng" thì phải trọn tháng). Hệ quả cần biết: tháng đang chạy
// luôn hiện lỗ, vì chi phí ChatGPT đã trả đủ cả tháng còn doanh thu thì chưa bán tới
// những ngày cuối tháng — xem bảng "theo chu kỳ thanh toán" để biết tỷ lệ đã bán.
const PRESETS: Preset[] = [
  {
    key: "month",
    label: "Tháng này",
    range: () => {
      const now = new Date();
      return { from: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: endOfThisMonth() };
    },
  },
  {
    key: "3m",
    label: "3 tháng",
    range: () => {
      const now = new Date();
      return {
        from: fmtDate(new Date(now.getFullYear(), now.getMonth() - 2, 1)),
        to: endOfThisMonth(),
      };
    },
  },
  {
    key: "6m",
    label: "6 tháng",
    range: () => {
      const now = new Date();
      return {
        from: fmtDate(new Date(now.getFullYear(), now.getMonth() - 5, 1)),
        to: endOfThisMonth(),
      };
    },
  },
  {
    key: "year",
    label: "Năm nay",
    range: () => {
      const now = new Date();
      return { from: fmtDate(new Date(now.getFullYear(), 0, 1)), to: endOfThisMonth() };
    },
  },
];

/** "2026-07" → "T7" (thêm "/26" khi khoảng trải nhiều năm). */
function monthLabel(mk: string, multiYear: boolean): string {
  const [y, m] = mk.split("-");
  return multiYear ? `${Number(m)}/${y.slice(2)}` : `T${Number(m)}`;
}

/** Rút gọn tiền cho nhãn nhỏ: 1.250.000 → "1.3tr", -900.000 → "-900k". */
function compactVnd(v: number): string {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1).replace(/\.0$/, "")}tr`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)}k`;
  return `${sign}${a}`;
}

/** Tách số VND thành phần dấu + phần số nhóm (để render đơn vị ₫ nhỏ hơn). */
function vnNum(v: number): { neg: boolean; num: string } {
  return { neg: v < 0, num: Math.abs(Math.round(v)).toLocaleString("vi-VN") };
}

/** Biên lợi nhuận: gọn số khi quá lớn (vd −10741) để badge không tràn. */
function fmtMargin(pct: number): string {
  const abs = Math.abs(pct);
  return abs >= 1000 ? String(Math.round(pct)) : pct.toFixed(1);
}

/** Trần "đẹp" ≥ x (1/2/2.5/5/10 × 10^k) để trục Y tròn số. */
function niceMax(x: number): number {
  if (x <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

export default function FinancialReport() {
  // Mặc định "Tháng này" (theo thời gian thực) — range tính từ ngày 1 tháng hiện
  // tại → hôm nay bằng new Date() lúc mở trang.
  const [presetKey, setPresetKey] = useState("month");
  const [showAgents, setShowAgents] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const range = useMemo(
    () => (PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0]).range(),
    [presetKey],
  );
  const { data, isLoading, isError } = useFinancialReport(range.from, range.to);

  const agentCount = data?.by_agent.length ?? 0;

  return (
    <div className="page-fade" style={{ paddingBottom: 40 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 24,
          flexWrap: "wrap",
          marginBottom: 26,
        }}
      >
        <div>
          <div className="breadcrumb" style={{ marginBottom: 10 }}>
            Tổ chức&nbsp;&nbsp;/&nbsp;&nbsp;Báo cáo tài chính
          </div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 32,
              fontWeight: 700,
              letterSpacing: "-0.025em",
              color: "var(--ink)",
              margin: "0 0 8px",
            }}
          >
            Báo cáo tài chính
          </h1>
          <p style={{ fontSize: 14, color: "var(--ink-2)", margin: 0, maxWidth: 640 }}>
            Doanh thu (phí mời + gia hạn) trừ chi phí trả ChatGPT ={" "}
            <strong style={{ color: "var(--ink)" }}>lợi nhuận</strong>. Thu ghi theo ngày bắt đầu kỳ của
            khách, chi ghi theo ngày hoá đơn ChatGPT. Số liệu {range.from} → {range.to}.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12, flexShrink: 0 }}>
          <div
            style={{
              display: "flex",
              gap: 4,
              background: "var(--surface-2)",
              borderRadius: 11,
              padding: 4,
            }}
          >
            {PRESETS.map((p) => {
              const active = p.key === presetKey;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPresetKey(p.key)}
                  style={{
                    border: "none",
                    borderRadius: 8,
                    padding: "8px 15px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    background: active ? "var(--ink)" : "transparent",
                    color: active ? "var(--surface)" : "var(--ink-2)",
                    transition: "background 0.12s, color 0.12s",
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => setShowAgents(true)}
            disabled={agentCount === 0}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "var(--ink)",
              color: "var(--surface)",
              border: "none",
              borderRadius: 10,
              padding: "10px 16px",
              fontSize: 13.5,
              fontWeight: 600,
              cursor: agentCount === 0 ? "not-allowed" : "pointer",
              opacity: agentCount === 0 ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            <span>Doanh thu theo đại lý</span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                background: "rgba(255,255,255,0.18)",
                borderRadius: 20,
                padding: "1px 7px",
              }}
            >
              {agentCount}
            </span>
            </button>
            {/* Đếm ĐẦU EMAIL (add mới / gia hạn / hỏng) — mở riêng chứ không xếp
                nối đuôi dưới sổ tiền: bảng theo ngày dài, để dưới trang thì mỗi
                lần xem phải cuộn qua toàn bộ báo cáo. */}
            <button
              type="button"
              onClick={() => setShowEmails(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "var(--surface)",
                color: "var(--ink)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "10px 16px",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Thống kê email add mới &amp; gia hạn
            </button>
          </div>
        </div>
      </div>

      {isLoading && <Muted>Đang tải báo cáo…</Muted>}
      {isError && <Muted>Không tải được báo cáo. Thử lại sau.</Muted>}
      {data && (
        <>
          <ReportBody data={data} range={range} />
          {showAgents && <AgentModal data={data} range={range} onClose={() => setShowAgents(false)} />}
        </>
      )}
      {/* NGOÀI khối `data &&`: bảng email đọc endpoint riêng, sổ tiền hỏng thì nút
          này vẫn phải mở được. */}
      {showEmails && (
        <EmailStatsModal from={range.from} to={range.to} onClose={() => setShowEmails(false)} />
      )}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13.5, color: "var(--ink-3)", padding: "24px 0" }}>{children}</div>;
}

// ── Card khung chung ────────────────────────────────────────────────────────

const card: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-card)",
};

function ReportBody({ data, range }: { data: FinancialReport; range: { from: string; to: string } }) {
  const rangeLabel = `${range.from} → ${range.to}`;
  return (
    <>
      {(data.cost_missing_workspaces > 0 ||
        data.cost_skipped_invoices > 0 ||
        data.months_no_cost > 0) && (
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            background: "var(--warning-bg)",
            border: "1px solid var(--warning-border)",
            borderRadius: "var(--radius)",
            padding: "10px 14px",
            marginBottom: 18,
            fontSize: 13,
            color: "var(--warning)",
          }}
        >
          <span aria-hidden>⚠</span>
          <span>
            {data.cost_missing_workspaces > 0 && (
              <>
                {data.cost_missing_workspaces} workspace chưa đồng bộ hoá đơn — chi phí (giá vốn ChatGPT)
                có thể thấp hơn thực tế, khiến lợi nhuận cao hơn thực. Đồng bộ billing để chính xác.{" "}
              </>
            )}
            {data.cost_skipped_invoices > 0 && (
              <>
                {data.cost_skipped_invoices} hoá đơn trong kỳ chưa có chi tiết nên chưa vào chi phí — chi
                phí đang thấp hơn thực tế. Dán chi tiết hoá đơn ở trang workspace là nó vào sổ ngay.{" "}
              </>
            )}
            {data.months_no_cost > 0 && (
              <>
                {data.months_no_cost} tháng trong kỳ có doanh thu nhưng chi phí bằng 0 — hoá đơn ChatGPT
                của những tháng đó nằm trước mốc tính sổ nên bị loại. Lãi của các tháng ấy là ảo, đừng
                dùng để đánh giá.
              </>
            )}
          </span>
        </div>
      )}

      <KpiRow data={data} />
      <MonthlyChart data={data} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1.4fr) minmax(300px,1fr)",
          gap: 20,
          alignItems: "stretch",
        }}
      >
        <PnlStatement data={data} rangeLabel={rangeLabel} />
        <Composition data={data} />
      </div>
      <CycleTable />
    </>
  );
}

// ── Lãi/lỗ theo ĐÚNG chu kỳ thanh toán ChatGPT ──────────────────────────────
// Bảng trên cắt theo tháng lịch (01→31) nên phải chia tiền hoá đơn theo ngày. Bảng
// này cắt đúng bằng chu kỳ hoá đơn (vd 11/08→11/09) nên CHI là TRỌN số tiền đã trả,
// không chia chác — khớp cách "thanh toán theo tháng". Không phụ thuộc preset đang chọn.

/** "2026-08-11" → "11/08". */
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function CycleTable() {
  const { data, isLoading } = useFinancialCycles(12);
  const cycles = data?.cycles ?? [];
  return (
    <div style={{ ...card, marginTop: 20, overflow: "hidden" }}>
      <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>
          Lãi/lỗ theo chu kỳ thanh toán ChatGPT
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>
          Cắt đúng chu kỳ hoá đơn — chi phí lấy trọn số đã trả, không chia theo ngày. Không đổi theo
          khoảng thời gian đang chọn ở trên.
        </div>
      </div>
      {isLoading ? (
        <div style={{ padding: "24px", fontSize: 13, color: "var(--ink-3)" }}>Đang tải…</div>
      ) : cycles.length === 0 ? (
        <div style={{ padding: "24px", fontSize: 13, color: "var(--ink-3)" }}>
          Chưa có hoá đơn nào ghi đủ chu kỳ.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 0.95fr 60px 1.05fr 1fr 1fr 1.05fr",
              gap: 14,
              padding: "11px 24px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg)",
            }}
          >
            {["WORKSPACE", "CHU KỲ", "GHẾ", "LẤP ĐẦY", "CHI PHÍ", "DOANH THU", "LÃI/LỖ"].map((h, i) => (
              <div
                key={h}
                style={{
                  fontSize: 10.5,
                  letterSpacing: "0.1em",
                  color: "var(--ink-3)",
                  fontWeight: 600,
                  textAlign: i >= 2 ? "right" : "left",
                }}
              >
                {h}
              </div>
            ))}
          </div>
          {cycles.map((c) => {
            const gain = c.profit >= 0;
            // Lấp đầy = seat·tháng đã bán ÷ seat·tháng đã trả tiền. Phần trống mà
            // không bù được người vào là mất luôn — hoá đơn đã trả trọn kỳ.
            const cap = c.capacity_seat_months;
            const fill = cap && cap > 0 ? (c.seat_months / cap) * 100 : null;
            const fillColor =
              fill === null ? "var(--ink-3)" : fill >= 95 ? GAIN : fill >= 70 ? COST_TEXT : "var(--danger)";
            return (
              <div
                key={`${c.workspace}-${c.period_end}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 0.95fr 60px 1.05fr 1fr 1fr 1.05fr",
                  gap: 14,
                  alignItems: "center",
                  padding: "14px 24px",
                  borderBottom: "1px solid var(--border)",
                  opacity: c.in_progress ? 0.75 : 1,
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{c.workspace}</div>
                <div>
                  <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--ink)" }}>
                    {shortDate(c.period_start)} → {shortDate(c.period_end)}
                  </div>
                  <div style={{ fontSize: 11, color: c.in_progress ? COST_TEXT : "var(--ink-3)", marginTop: 2 }}>
                    {c.in_progress ? `đang chạy · còn ${c.days - c.days_elapsed} ngày` : "đã đóng"}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right", color: "var(--ink-2)" }}>
                  {/* Kỳ có mua thêm ghế giữa chừng thì hiện "đầu kỳ→cuối kỳ" (vd 46→62). */}
                  {c.seats === null
                    ? "—"
                    : c.seats_start !== null && c.seats_start !== c.seats
                      ? `${c.seats_start}→${c.seats}`
                      : c.seats}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, fontFamily: "var(--font-mono)", color: fillColor }}>
                    {fill === null ? "—" : `${Math.round(fill)}%`}
                  </div>
                  {cap !== null && (
                    <div style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--ink-3)", marginTop: 2 }}>
                      {c.seat_months.toFixed(1)}/{cap.toFixed(1)}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right", color: COST_TEXT }}>
                  −{vnNum(c.cost).num}
                </div>
                <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right", color: "var(--ink)" }}>
                  {vnNum(c.revenue).num}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    fontFamily: "var(--font-mono)",
                    textAlign: "right",
                    color: gain ? "var(--success-strong)" : "var(--danger)",
                  }}
                >
                  {gain ? "+" : "−"}
                  {vnNum(c.profit).num} <span style={{ fontSize: 11, opacity: 0.7 }}>đ</span>
                </div>
              </div>
            );
          })}
          <div style={{ padding: "12px 24px", fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--ink-2)" }}>Lấp đầy</strong> = seat·tháng đã bán ÷ seat·tháng đã
            trả tiền cho ChatGPT (ghế × ngày ÷ 30). Hoá đơn trả trọn kỳ nên khách nghỉ giữa chừng mà không
            bù được người vào là mất luôn số ngày đó — lãi/lỗ của kỳ đi theo cột này chứ không theo số ngày
            đã trôi qua. Kỳ <strong style={{ color: COST_TEXT }}>đang chạy</strong> còn bán tiếp được, chỉ
            chốt lãi/lỗ khi đã đóng. Cột ghế dạng <strong style={{ color: "var(--ink-2)" }}>46→62</strong> là
            kỳ có mua thêm ghế giữa chừng: tiền mua thêm đã cộng vào chi phí của chính kỳ đó, không tách
            thành dòng riêng.
          </div>
        </>
      )}
    </div>
  );
}

// ── KPI + sparkline ─────────────────────────────────────────────────────────

function KpiRow({ data }: { data: FinancialReport }) {
  const revenue = data.revenue;
  const revSeries = data.monthly.map((m) => m.revenue);
  const costSeries = data.monthly.map((m) => m.cost);
  const profitSeries = data.monthly.map((m) => m.profit);
  const gain = data.profit >= 0;
  const margin = revenue > 0 ? (data.profit / revenue) * 100 : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 16,
        marginBottom: 20,
      }}
    >
      <Kpi
        dot={REV}
        line={REV}
        label="Doanh thu"
        value={revenue}
        series={revSeries}
        sub={`Mời ${vnNum(data.revenue_invite).num} đ · Gia hạn ${vnNum(data.revenue_renew).num} đ`}
      />
      <Kpi
        dot={COST}
        line={COST}
        label="Chi phí ChatGPT"
        value={data.cost}
        series={costSeries}
        sub="Hoá đơn Stripe trả trong kỳ (gồm VAT + phí ngân hàng)"
      />
      <Kpi
        dot={gain ? GAIN : "var(--danger)"}
        line={gain ? GAIN : "var(--danger)"}
        label="Lợi nhuận"
        value={data.profit}
        series={profitSeries}
        valueColor={gain ? "var(--success-strong)" : "var(--danger)"}
        bg={gain ? "linear-gradient(135deg,#ecf6f0,#e2f1e8)" : "linear-gradient(135deg,#fbf1ef,#f9e6e1)"}
        border={gain ? "var(--success-border)" : "#f0d4cd"}
        labelColor={gain ? "var(--success)" : "#a2493b"}
        sub={
          margin !== null
            ? `${gain ? "▲" : "▼"} Biên lợi nhuận ${fmtMargin(margin)}% · ${gain ? "có lãi" : "đang lỗ"}`
            : "—"
        }
        subColor={gain ? "var(--success)" : "#a2493b"}
        subBold
      />
    </div>
  );
}

function Kpi({
  dot,
  line,
  label,
  value,
  series,
  sub,
  valueColor,
  bg,
  border,
  labelColor,
  subColor,
  subBold,
}: {
  dot: string;
  line: string;
  label: string;
  value: number;
  series: number[];
  sub: string;
  valueColor?: string;
  bg?: string;
  border?: string;
  labelColor?: string;
  subColor?: string;
  subBold?: boolean;
}) {
  const { neg, num } = vnNum(value);
  return (
    <div
      style={{
        ...card,
        background: bg ?? "var(--surface)",
        border: `1px solid ${border ?? "var(--border)"}`,
        padding: "20px 22px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              color: labelColor ?? "var(--ink-3)",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: dot, display: "inline-block" }} />
            {label}
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              letterSpacing: "-0.02em",
              marginTop: 8,
              color: valueColor ?? "var(--ink)",
              whiteSpace: "nowrap",
            }}
          >
            {neg ? "−" : ""}
            {num}{" "}
            <span style={{ fontSize: 16, color: valueColor ? undefined : "var(--ink-3)", opacity: valueColor ? 0.7 : 1 }}>đ</span>
          </div>
        </div>
        <Sparkline values={series} color={line} />
      </div>
      <div
        style={{
          fontSize: 12,
          color: subColor ?? "var(--ink-3)",
          marginTop: 8,
          fontWeight: subBold ? 600 : 400,
        }}
      >
        {sub}
      </div>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 80;
  const H = 32;
  const pts = useMemo(() => {
    if (values.length === 0) return `0,${H - 2} ${W},${H - 2}`;
    if (values.length === 1) return `0,${H / 2} ${W},${H / 2}`;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * W;
        const y = H - 2 - ((v - min) / span) * (H - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [values]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ flexShrink: 0, overflow: "visible" }} aria-hidden>
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
    </svg>
  );
}

// ── Biểu đồ cột Thu & Chi theo tháng (HTML/flex) ────────────────────────────

function MonthlyChart({ data }: { data: FinancialReport }) {
  const months = data.monthly;
  const multiYear = new Set(months.map((m) => m.month.slice(0, 4))).size > 1;
  const rawMax = Math.max(0, ...months.map((m) => Math.max(m.revenue, m.cost)));
  const maxV = niceMax(rawMax);
  const plotH = 240;
  const barH = (v: number, has: boolean) =>
    v <= 0 ? (has ? 6 : 0) : Math.max(10, Math.round((Math.min(v, maxV) / maxV) * plotH));

  const yLabels = [1, 0.75, 0.5, 0.25, 0].map((f) => compactVnd(maxV * f));
  const gridPct = [0, 25, 50, 75];

  return (
    <div style={{ ...card, padding: "24px 26px", marginBottom: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 22,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>Thu &amp; Chi theo tháng</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>
            Đối chiếu doanh thu với chi phí, kèm lãi/lỗ ròng
          </div>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <Legend color={REV} text="Doanh thu" />
          <Legend color={COST} text="Chi phí" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 14 }}>
        {/* Trục Y */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "flex-end",
            height: plotH,
            fontSize: 11,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
            paddingBottom: 2,
          }}
        >
          {yLabels.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
        {/* Vùng vẽ */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ position: "relative", height: plotH, borderBottom: "1.5px solid var(--border-strong)" }}>
            {gridPct.map((g) => (
              <div key={g} style={{ position: "absolute", left: 0, right: 0, top: `${g}%`, borderTop: "1px solid var(--border)" }} />
            ))}
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "stretch", justifyContent: "space-around", gap: 10 }}>
              {months.map((m, i) => {
                const has = m.revenue !== 0 || m.cost !== 0;
                const revH = barH(m.revenue, has);
                const costH = barH(m.cost, has);
                const delay = `${(i * 0.09 + 0.15).toFixed(2)}s`;
                return (
                  <div
                    key={m.month}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      borderRadius: "8px 8px 0 0",
                      background: has ? "rgba(58,91,208,0.04)" : "transparent",
                    }}
                  >
                    <div style={{ flex: 1, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 8, width: "100%" }}>
                      <ChartBar height={revH} show={has} label={compactVnd(m.revenue)} labelColor={REV} labelBg={REV_BG} top={REV_TOP} bottom={REV} delay={delay} />
                      <ChartBar height={costH} show={has} label={compactVnd(m.cost)} labelColor={COST_TEXT} labelBg={COST_BG} top={COST_TOP} bottom={COST} delay={delay} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {/* Nhãn X + lãi/lỗ */}
          <div style={{ display: "flex", justifyContent: "space-around", gap: 10, paddingTop: 10 }}>
            {months.map((m) => {
              const has = m.revenue !== 0 || m.cost !== 0;
              return (
                <div key={m.month} style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: has ? "var(--ink)" : "var(--ink-4)" }}>
                    {monthLabel(m.month, multiYear)}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: !has ? "var(--ink-4)" : m.profit < 0 ? "var(--danger)" : GAIN,
                      fontFamily: "var(--font-mono)",
                      marginTop: 3,
                    }}
                  >
                    {has ? `${m.profit < 0 ? "−" : "+"}${compactVnd(Math.abs(m.profit))}` : "0"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartBar({
  height,
  show,
  label,
  labelColor,
  labelBg,
  top,
  bottom,
  delay,
}: {
  height: number;
  show: boolean;
  label: string;
  labelColor: string;
  labelBg: string;
  top: string;
  bottom: string;
  delay: string;
}) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "flex-end" }}>
      {show && (
        <span
          style={{
            position: "absolute",
            bottom: `calc(${height}px + 6px)`,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 10.5,
            fontWeight: 600,
            color: labelColor,
            whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)",
            background: labelBg,
            padding: "1px 5px",
            borderRadius: 5,
          }}
        >
          {label}
        </span>
      )}
      <div
        className="fr-bar"
        style={{
          width: 22,
          height,
          background: `linear-gradient(180deg, ${top}, ${bottom})`,
          borderRadius: "5px 5px 0 0",
          animationDelay: delay,
        }}
      />
    </div>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-2)" }}>
      <span style={{ width: 12, height: 12, borderRadius: 3, background: color }} />
      {text}
    </span>
  );
}

// ── Báo cáo lãi/lỗ (P&L) ────────────────────────────────────────────────────

function PnlStatement({ data, rangeLabel }: { data: FinancialReport; rangeLabel: string }) {
  const gain = data.profit >= 0;
  const margin = data.revenue > 0 ? (data.profit / data.revenue) * 100 : null;
  const p = vnNum(data.profit);
  // Trung bình mỗi seat/tháng: giá vốn từ backend (cost ÷ seat-tháng), doanh thu &
  // lãi suy tại chỗ. Chỉ hiện khi có ít nhất 1 seat-tháng phát sinh THU trong kỳ.
  const pricePerSeat = data.avg_price_per_seat;
  const seatCost = data.avg_seat_cost;
  const marginPerSeat =
    pricePerSeat !== null && seatCost !== null ? pricePerSeat - seatCost : null;
  return (
    <div style={{ ...card, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>Báo cáo lãi/lỗ (P&amp;L)</div>
        <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>Luỹ kế {rangeLabel}</div>
      </div>

      <div style={{ padding: "16px 24px 4px" }}>
        <SectionLabel>DOANH THU</SectionLabel>
        <PnlRow label="Phí mời" value={`${vnNum(data.revenue_invite).num} đ`} />
        <PnlRow label="Gia hạn" value={`${vnNum(data.revenue_renew).num} đ`} />
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 16,
            padding: "11px 0",
            marginTop: 2,
            borderTop: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>Tổng doanh thu</span>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--ink)" }}>
            {vnNum(data.revenue).num} đ
          </span>
        </div>
      </div>

      <div style={{ padding: "4px 24px 18px" }}>
        <SectionLabel>CHI PHÍ</SectionLabel>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "7px 0" }}>
          <span style={{ fontSize: 13.5, color: COST_TEXT }}>ChatGPT (Stripe, gồm VAT) — trả trong kỳ</span>
          <span style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--font-mono)", color: COST_TEXT }}>
            −{vnNum(data.cost).num} đ
          </span>
        </div>
      </div>

      {(pricePerSeat !== null || seatCost !== null) && (
        <div style={{ padding: "4px 24px 18px" }}>
          <SectionLabel>MỖI GHẾ · THÁNG</SectionLabel>
          <PnlRow label="Số seat·tháng bán ra" value={`${data.seat_months.toFixed(0)} seat·tháng`} />
          <PnlRow
            label="Giá bán TB"
            value={pricePerSeat !== null ? `${vnNum(pricePerSeat).num} đ` : "—"}
          />
          <PnlRow
            label="Phí seat thực tế (ChatGPT)"
            value={seatCost !== null ? `−${vnNum(seatCost).num} đ` : "—"}
          />
          {marginPerSeat !== null && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 16,
                padding: "9px 0 2px",
                marginTop: 2,
                borderTop: "1px solid var(--border)",
              }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>Lãi mỗi ghế</span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                  color: marginPerSeat < 0 ? "var(--danger)" : "var(--success-strong)",
                }}
              >
                {marginPerSeat < 0 ? "−" : "+"}
                {vnNum(marginPerSeat).num} đ
              </span>
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.5 }}>
            Phí seat thực tế = tiền hoá đơn ChatGPT ÷ {data.billed_seat_months.toFixed(1)} ghế·tháng ChatGPT
            thu tiền. Một chu kỳ hoá đơn tính TRỌN 1 tháng (kỳ 28/30/31 ngày đều thu như nhau), và hoá đơn
            mua thêm suất giữa kỳ chỉ tính phần suất·ngày thực sự trả tiền chứ không lấy tổng suất ghi trên
            hoá đơn. <strong style={{ color: "var(--ink-2)" }}>
            Lãi mỗi ghế dương mà lợi nhuận ròng vẫn âm là bình thường</strong>: kỳ của khách và hoá đơn
            ChatGPT neo vào hai mốc khác nhau nên không rơi cùng tháng, và ghế chưa bán được vẫn phải trả
            tiền. Xem bảng theo chu kỳ thanh toán bên dưới để biết tỷ lệ lấp đầy.
          </div>
        </div>
      )}

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px 16px",
          padding: "18px 24px",
          background: gain ? "var(--success-bg)" : "#fbf1ef",
          borderTop: `1px solid ${gain ? "var(--success-border)" : "#f0d4cd"}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: gain ? "var(--success)" : "#a2493b" }}>
            Lợi nhuận ròng
          </span>
          {margin !== null && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
                background: gain ? "var(--success-strong)" : "var(--danger)",
                borderRadius: 6,
                padding: "2px 8px",
                fontFamily: "var(--font-mono)",
              }}
            >
              {gain ? "+" : ""}
              {fmtMargin(margin)}%
            </span>
          )}
        </div>
        <span style={{ fontSize: 19, fontWeight: 700, fontFamily: "var(--font-mono)", color: gain ? "var(--success-strong)" : "var(--danger)" }}>
          {p.neg ? "−" : ""}
          {p.num} đ
        </span>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, letterSpacing: "0.1em", color: "var(--ink-3)", fontWeight: 600, margin: "6px 0" }}>
      {children}
    </div>
  );
}

function PnlRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "7px 0" }}>
      <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{label}</span>
      <span style={{ fontSize: 13.5, fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{value}</span>
    </div>
  );
}

// ── Cơ cấu doanh thu (donut) + top đại lý ───────────────────────────────────

function Composition({ data }: { data: FinancialReport }) {
  const revenue = data.revenue;
  const comp = [
    { label: "Phí mời", value: data.revenue_invite, color: REV },
    { label: "Gia hạn", value: data.revenue_renew, color: COST },
  ].filter((c) => c.value > 0);

  const R = 47;
  const C = 2 * Math.PI * R;
  const gap = comp.length > 1 ? 3 : 0;
  let acc = 0;
  const segments = comp.map((c) => {
    const frac = revenue > 0 ? c.value / revenue : 0;
    const len = Math.max(frac * C - gap, 2);
    const rot = acc * 360;
    acc += frac;
    return { color: c.color, len, rot };
  });

  const agents = data.by_agent;
  const totalTxns = agents.reduce((s, a) => s + a.invite_count + a.renew_count, 0);
  const avg = agents.length > 0 ? Math.round(revenue / agents.length) : 0;
  const top = [...agents].sort((a, b) => b.revenue - a.revenue).slice(0, 3);
  const medals = ["#c9a227", "#a6a49a", "#b07a4a"];

  return (
    <div style={{ ...card, padding: "20px 24px", display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginBottom: 4 }}>Cơ cấu doanh thu</div>
      <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 18 }}>Theo nguồn thu · luỹ kế kỳ</div>

      <div style={{ display: "flex", alignItems: "center", gap: 26, flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 150, height: 150, flexShrink: 0 }}>
          <svg viewBox="0 0 120 120" width={150} height={150} style={{ transform: "rotate(-90deg)" }}>
            <circle cx={60} cy={60} r={R} fill="none" stroke="var(--surface-2)" strokeWidth={18} />
            {segments.map((s, i) => (
              <circle
                key={i}
                className="fr-ring"
                cx={60}
                cy={60}
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth={18}
                transform={`rotate(${s.rot.toFixed(2)} 60 60)`}
                style={{ ["--len" as string]: `${s.len.toFixed(1)}`, strokeDasharray: `${s.len.toFixed(1)} 999` }}
              />
            ))}
          </svg>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--ink-3)", fontWeight: 600 }}>TỔNG THU</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em", marginTop: 1, color: "var(--ink)" }}>
              {compactVnd(revenue)}
            </div>
            <div style={{ fontSize: 10, color: "var(--ink-3)" }}>đồng</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 16 }}>
          {comp.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ink-3)" }}>Chưa có doanh thu trong kỳ.</div>
          ) : (
            comp.map((c) => {
              const pct = revenue > 0 ? Math.round((c.value / revenue) * 100) : 0;
              return (
                <div key={c.label}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: c.color, alignSelf: "center" }} />
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{c.label}</span>
                    <span style={{ marginLeft: "auto", fontSize: 13.5, fontWeight: 700, fontFamily: "var(--font-mono)", color: c.color }}>
                      {pct}%
                    </span>
                  </div>
                  <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: c.color, borderRadius: 4 }} />
                  </div>
                  <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--ink-3)", marginTop: 5 }}>
                    {vnNum(c.value).num} đ
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ marginTop: "auto", paddingTop: 18, borderTop: "1px solid var(--border)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <MiniStat label="TB doanh thu / đại lý" value={compactVnd(avg)} unit="đ" />
            <MiniStat label="Tổng giao dịch" value={String(totalTxns)} unit="đơn" />
          </div>
          <div>
            <div style={{ fontSize: 10.5, letterSpacing: "0.1em", color: "var(--ink-3)", fontWeight: 600, marginBottom: 12 }}>
              TOP ĐẠI LÝ
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {top.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>—</div>
              ) : (
                top.map((a, i) => (
                  <div key={a.user_id ?? "none"} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                      style={{
                        flexShrink: 0,
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: medals[i],
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12,
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {i + 1}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.username ?? "—"}
                      </div>
                      <div style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--ink-3)", marginTop: 1 }}>
                        {vnNum(a.revenue).num} đ
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 11, padding: "11px 14px" }}>
      <div style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--font-mono)", marginTop: 3, color: "var(--ink)" }}>
        {value} <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{unit}</span>
      </div>
    </div>
  );
}

// ── Modal doanh thu theo đại lý ─────────────────────────────────────────────

function AgentModal({
  data,
  range,
  onClose,
}: {
  data: FinancialReport;
  range: { from: string; to: string };
  onClose: () => void;
}) {
  const agents = data.by_agent;
  const maxRev = Math.max(1, ...agents.map((a) => a.revenue));
  const cols = "1fr 90px 90px 220px";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28,26,23,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 760,
          maxWidth: "100%",
          maxHeight: "calc(86vh / var(--ui-scale))",
          overflow: "auto",
          background: "var(--surface)",
          borderRadius: 18,
          boxShadow: "0 24px 70px -18px rgba(28,26,23,0.5)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            background: "var(--surface)",
            padding: "20px 24px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            zIndex: 1,
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>Doanh thu theo đại lý</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>
              {agents.length} đại lý · luỹ kế {range.from} → {range.to}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--ink-3)",
              fontSize: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {agents.length === 0 ? (
          <div style={{ padding: "40px 24px", fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
            Chưa có giao dịch phí trong kỳ.
          </div>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: cols,
                alignItems: "center",
                gap: 18,
                padding: "12px 24px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg)",
              }}
            >
              {["ĐẠI LÝ", "MỜI", "GIA HẠN", "DOANH THU"].map((h, i) => (
                <div
                  key={h}
                  style={{
                    fontSize: 10.5,
                    letterSpacing: "0.1em",
                    color: "var(--ink-3)",
                    fontWeight: 600,
                    textAlign: i === 0 ? "left" : "right",
                  }}
                >
                  {h}
                </div>
              ))}
            </div>
            {agents.map((a) => {
              const pct = Math.round((a.revenue / maxRev) * 100);
              const initial = (a.username ?? a.email ?? "?").charAt(0).toUpperCase();
              return (
                <div
                  key={a.user_id ?? "none"}
                  style={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    alignItems: "center",
                    gap: 18,
                    padding: "15px 24px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        flexShrink: 0,
                        borderRadius: "50%",
                        background: "var(--surface-2)",
                        color: "var(--ink-2)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 14,
                        fontWeight: 600,
                      }}
                    >
                      {initial}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.username ?? "—"}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.email ?? ""}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontFamily: "var(--font-mono)", textAlign: "right", color: "var(--ink)" }}>{a.invite_count}</div>
                  <div style={{ fontSize: 14, fontFamily: "var(--font-mono)", textAlign: "right", color: "var(--ink)" }}>{a.renew_count}</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right", color: "var(--ink)" }}>
                      {vnNum(a.revenue).num} <span style={{ color: "var(--ink-3)", fontSize: 11 }}>đ</span>
                    </div>
                    <div style={{ height: 5, background: "var(--surface-2)", borderRadius: 3, marginTop: 6, overflow: "hidden" }}>
                      <div style={{ height: "100%", background: REV, width: `${pct}%`, borderRadius: 3 }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
