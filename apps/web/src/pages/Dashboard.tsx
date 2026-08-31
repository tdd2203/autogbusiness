/**
 * Trang "Tổng quan" của đại lý — màn hình đầu tiên sau khi đăng nhập.
 *
 * Trả lời trong 5 giây: hôm nay bán được gì, còn bao nhiêu tiền, ghế nào sắp mất,
 * đang lớn lên hay teo lại. Trước đây đăng nhập xong rơi thẳng vào bảng "Email đã
 * thêm" — một bảng dài không trả lời được câu nào trong bốn câu đó.
 *
 * MỌI SỐ đến từ MỘT lượt gọi `/api/v1/dashboard/overview` (xem docstring của
 * `routers/dashboard.py` để biết từng số lấy ở đâu). Trang này không tự cộng trừ
 * gì thêm ngoài phần trình bày — cộng ở hai nơi là sớm muộn hai nơi lệch nhau.
 *
 * Bố cục bám bản thiết kế canvas (5 artboard: ngày bùng, ngày lặng, mobile, tài
 * khoản mới, đang tải).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";
import LoadError from "../components/LoadError";
import DueWeekModal from "../components/DueWeekModal";
import {
  bigNumber,
  card,
  cardKicker,
  cardTitle,
  primaryBtn,
  secondaryBtn,
} from "../components/walletUi";
import {
  deltaLabel,
  money,
  pctLabel,
  shortDay,
  vnNowLabel,
  type DashboardOverview,
  type DashboardSeriesDay,
} from "../lib/dashboard";

/** Khoảng của biểu đồ. Hai thẻ "tỉ lệ gia hạn" và "chất lượng lượt mời" LUÔN 30
 *  ngày — đổi khoảng biểu đồ không được làm nhảy số của chúng. */
const PERIODS = [7, 30, 90] as const;

const DANGER = { color: "#b02a1e", bg: "var(--danger-bg)" };
const WARN = { color: "#8a6d1f", bg: "var(--warning-bg)" };
const PLAIN = { color: "var(--ink)", bg: "var(--bg)" };

export default function Dashboard() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [period, setPeriod] = useState<number>(30);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dashboard-overview", period],
    queryFn: () =>
      api<DashboardOverview>(`/api/v1/dashboard/overview?days=${period}`),
    // Hạn dùng trôi theo giờ và job nền vẫn gỡ/gia hạn trong lúc trang đang mở
    // (cùng nhịp với trang Gia hạn), nên tự nạp lại mỗi phút thay vì đứng im.
    refetchInterval: 60_000,
    // Đổi 7/30/90 giữ nguyên số cũ trong lúc chờ — khỏi nháy khung rỗng.
    placeholderData: keepPreviousData,
  });

  if (error) {
    return (
      <div className="page-fade" style={{ padding: "8px 4px 40px" }}>
        <LoadError error={error} onRetry={() => refetch()} />
      </div>
    );
  }
  if (isLoading || !data) return <Skeleton isMobile={isMobile} />;

  // Tài khoản chưa có ghế nào VÀ chưa từng có lượt nào — màn ba bước thay cho
  // một trang toàn số 0 (không ai hiểu trang hỏng hay mình chưa làm gì).
  const isEmpty =
    data.serving.seats === 0 &&
    data.quality.total === 0 &&
    data.series.every((d) => d.new_count + d.renew_count === 0);

  return (
    <div className="page-fade" style={{ padding: "8px 4px 40px" }}>
      <Header data={data} />
      <StatCards data={data} isMobile={isMobile} />
      {isEmpty ? (
        <EmptyState hasWallet={data.wallet != null} />
      ) : (
        <>
          {isMobile ? (
            <>
              <TodoPanel data={data} />
              <DuePanel data={data} isMobile={isMobile} />
              <GrowthPanel
                data={data}
                period={period}
                setPeriod={setPeriod}
                isMobile={isMobile}
              />
            </>
          ) : (
            <>
              <GrowthPanel
                data={data}
                period={period}
                setPeriod={setPeriod}
                isMobile={isMobile}
              />
              <section
                style={{
                  display: "flex",
                  gap: 14,
                  alignItems: "flex-start",
                  marginTop: 14,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "2 1 520px", minWidth: 0 }}>
                  <TodoPanel data={data} />
                </div>
                <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <DuePanel data={data} isMobile={isMobile} />
                </div>
              </section>
            </>
          )}
          <QualityPanel data={data} />
        </>
      )}
      {user?.is_super_admin && (
        <p style={{ margin: "18px 2px 0", fontSize: 12, color: "var(--ink-3)" }}>
          Trang này luôn chốt số của CHÍNH tài khoản đang đăng nhập. Số toàn hệ
          thống xem ở Báo cáo tài chính.
        </p>
      )}
    </div>
  );
}

// ── Đầu trang ───────────────────────────────────────────────────────────────

function Header({ data }: { data: DashboardOverview }) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 20,
        flexWrap: "wrap",
        marginBottom: 18,
      }}
    >
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <h1 className="display-h1" style={{ marginBottom: 6 }}>
          Tổng quan
        </h1>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)" }}>
          {data.username} · {vnNowLabel(data.now)}
        </p>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        {data.wallet && (
          <Link to="/wallet" style={{ ...secondaryBtn, textDecoration: "none" }}>
            Nạp tiền
          </Link>
        )}
        <Link to="/invite" style={{ ...primaryBtn, textDecoration: "none" }}>
          Mời thành viên
        </Link>
      </div>
    </header>
  );
}

// ── Bốn thẻ số ──────────────────────────────────────────────────────────────

function StatCard({
  kicker,
  value,
  unit,
  sub,
  note,
  tone,
  fixed,
}: {
  kicker: string;
  value: string;
  unit?: string;
  sub: React.ReactNode;
  note?: React.ReactNode;
  tone?: "warn";
  /** Mobile: hàng thẻ cuộn ngang → thẻ giữ nguyên bề ngang, KHÔNG co. Co lại thì
   *  nhãn xuống dòng và chữ chồng lên số. */
  fixed?: boolean;
}) {
  return (
    <div
      style={{
        ...card,
        ...(fixed
          ? { flex: "0 0 244px", width: 244 }
          : { flex: "1 1 220px" }),
        padding: 18,
        ...(tone === "warn"
          ? { background: "var(--warning-bg)", borderColor: "var(--warning-border)" }
          : null),
      }}
    >
      <div style={{ ...cardKicker, whiteSpace: "nowrap" }}>{kicker}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={bigNumber}>{value}</span>
        {unit && (
          <span style={{ fontSize: 14, color: "var(--ink-2)", fontWeight: 600 }}>
            {unit}
          </span>
        )}
      </div>
      <div style={{ marginTop: 9, fontSize: 13, color: "var(--ink-2)" }}>{sub}</div>
      {note && (
        <div style={{ marginTop: 5, fontSize: 12.5, color: "var(--ink-3)" }}>{note}</div>
      )}
    </div>
  );
}

function StatCards({ data, isMobile }: { data: DashboardOverview; isMobile: boolean }) {
  const t = data.today;
  const w = data.wallet;
  const r = data.renewal_rate;

  // Thẻ Ví trả lời "sắp tới phải gia hạn bao nhiêu email, cần bao nhiêu tiền" —
  // ĐỌC THẲNG số của backend, không tự cộng lại từ danh sách theo tuần. Tự cộng ở
  // trang thì mốc cắt là NGÀY còn backend cắt theo GIỜ, nên ghế hết hạn trong ngày
  // cuối cửa sổ làm hai chỗ lệch nhau một hai ghế mà không ai hiểu vì sao.
  const dueSoon = { seats: data.todos.due_soon, money: data.todos.due_soon_money };

  return (
    <section
      style={{
        display: "flex",
        gap: 14,
        flexWrap: isMobile ? "nowrap" : "wrap",
        overflowX: isMobile ? "auto" : undefined,
        paddingBottom: isMobile ? 4 : 0,
      }}
    >
      <StatCard
        fixed={isMobile}
        kicker="HÔM NAY"
        value={String(t.new_count + t.renew_count)}
        unit="email"
        sub={
          <>
            <strong style={{ color: "var(--ink)" }}>{t.new_count} mới</strong> ·{" "}
            {t.renew_count} gia hạn
          </>
        }
        note={
          <>
            {t.failed_count > 0 && (
              <span style={{ color: "var(--danger)", fontWeight: 600 }}>
                {t.failed_count} lượt hỏng
              </span>
            )}
            {t.failed_count > 0 && " · "}
            thực chi {money(t.fee_net)}
            <span style={{ fontSize: 11 }}>đ</span>
            {t.free_reinvite_count > 0 &&
              ` · ${t.free_reinvite_count} mời lại miễn phí`}
          </>
        }
      />
      <StatCard
        fixed={isMobile}
        kicker="ĐANG PHỤC VỤ"
        value={String(data.serving.seats)}
        unit="ghế"
        sub={
          <>
            {data.serving.active} đã tham gia · {data.serving.pending} chờ tham gia
          </>
        }
      />
      {w && (
        // Ô này trả lời "sắp tới phải gia hạn bao nhiêu email, cần bao nhiêu tiền"
        // (chốt user 2026-08-31) — nên SỐ CHÍNH là tiền phải lo, còn số dư hiện tại
        // xuống dòng nhỏ. Trước đây số dư làm số chính, đọc xong vẫn không biết
        // ngần đó đủ hay thiếu cho đợt sắp tới.
        <StatCard
          fixed={isMobile}
          kicker={dueSoon.money > w.balance ? "CẦN GIA HẠN · THIẾU TIỀN" : "GIA HẠN"}
          value={money(dueSoon.money)}
          unit="đ"
          tone={dueSoon.money > w.balance ? "warn" : undefined}
          sub={
            dueSoon.seats > 0 ? (
              <>
                <strong style={{ color: "var(--ink)" }}>{dueSoon.seats} ghế</strong>{" "}
                đến hạn trong 7 ngày
              </>
            ) : (
              "không có ghế nào đến hạn trong 7 ngày"
            )
          }
          note={
            <>
              Số dư hiện tại {money(w.balance)}
              <span style={{ fontSize: 11 }}>đ</span>
              {dueSoon.money > w.balance ? (
                <>
                  {" "}
                  · thiếu{" "}
                  <strong style={{ color: "var(--danger)" }}>
                    {money(dueSoon.money - w.balance)}đ
                  </strong>
                </>
              ) : dueSoon.seats > 0 ? (
                " · đủ cho đợt này"
              ) : (
                ` · đủ ${w.invites_left} lượt`
              )}
            </>
          }
        />
      )}
      <StatCard
        fixed={isMobile}
        kicker={`TỈ LỆ GIA HẠN ${r.days} NGÀY`}
        value={pctLabel(r.pct)}
        sub={
          r.total > 0 ? (
            <>
              <strong style={{ color: "var(--ink)" }}>{r.renew_count} gia hạn</strong>{" "}
              trên {r.total} lượt
            </>
          ) : (
            "chưa có lượt nào trong kỳ"
          )
        }
      />
    </section>
  );
}

// ── Biểu đồ tăng trưởng ─────────────────────────────────────────────────────

type Geom = ReturnType<typeof buildGeom>;

/**
 * Toạ độ trong hệ 0–100 (SVG dùng `preserveAspectRatio="none"` + nét vẽ
 * `non-scaling-stroke` nên co giãn ngang không làm méo nét).
 *
 * Trục PHẢI (email/ngày) NÉN CĂN BẬC HAI: dữ liệu thật đi từ 0–5 email/ngày nửa
 * đầu tháng rồi vọt lên 137 cuối tháng. Để tuyến tính thì mọi ngày lặng dí sát
 * đáy thành một vạch không đọc được.
 */
function buildGeom(series: DashboardSeriesDay[]) {
  const n = series.length;
  const seats = series.map((d) => d.seats_end);
  const hi = Math.max(...seats, 1);
  const lo = Math.min(...seats);

  // TRỤC GHẾ TỰ CO THEO DỮ LIỆU, và hai đầu trục LÀ CHÍNH các mốc tròn: chọn bước
  // trước (1/2/2,5/5 × 10ⁿ), rồi kéo đáy xuống bội gần nhất và đỉnh lên bội gần
  // nhất. Nhờ vậy vạch trên cùng và dưới cùng nằm đúng mép khung thay vì lửng lơ,
  // và mọi nhãn đều là số tròn dù dải ghế là 46–572 hay 3–12.
  const sStep = niceStep(Math.max(1, hi - lo));
  const sMin = Math.max(0, Math.floor(lo / sStep) * sStep - (lo % sStep === 0 ? sStep : 0));
  const sMax = Math.ceil(hi / sStep) * sStep + (hi % sStep === 0 ? sStep : 0);
  const dMax = Math.max(...series.map((d) => Math.max(d.new_count, d.renew_count)), 1);

  const X = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const Ys = (v: number) => 100 - ((v - sMin) / (sMax - sMin || 1)) * 94;
  const Yd = (v: number) => 100 - Math.sqrt(v / dMax) * 90;

  const seatsD = curve(series.map((d, i) => ({ x: X(i), y: Ys(d.seats_end) })));
  const newD = curve(series.map((d, i) => ({ x: X(i), y: Yd(d.new_count) })));
  const renewD = curve(series.map((d, i) => ({ x: X(i), y: Yd(d.renew_count) })));

  const step = Math.max(1, Math.round(n / 6));
  const xLabels = series
    .map((d, i) => ({ i, label: shortDay(d.date), left: `${X(i)}%` }))
    .filter((_, i) => i % step === 0 || i === n - 1);

  // Trục ghế: 3 mốc thì đường ghế trôi giữa hai vạch cách nhau vài trăm ghế,
  // nhìn không ra nó đang ở mức nào. Lấy ~5 mốc SỐ TRÒN (bội của 1/2/2,5/5×10^k)
  // và kẻ ngang mờ ở từng mốc — đường mới đọc được thành con số.
  const sTicks: { label: number; y: number; bottom: string }[] = [];
  for (let v = sMin; v <= sMax + 1e-6; v += sStep) {
    sTicks.push({
      label: Math.round(v),
      y: Ys(v),
      bottom: `${(((v - sMin) / (sMax - sMin || 1)) * 94).toFixed(2)}%`,
    });
  }

  // Trục email/ngày nén căn bậc hai: mốc chia đều trên trục là các phần 5% / 20% /
  // 45% / 100% của đỉnh (căn của chúng cách đều nhau), rồi làm tròn về số đẹp.
  // Cột mốc cứng kiểu [0,5,20,60,140] chỉ đúng với một dải dữ liệu duy nhất — ngày
  // lặng 0–5 email thì cả trục còn đúng hai vạch.
  // Đỉnh trục phải LÀM TRÒN LÊN, không tròn về gần nhất: tròn xuống thì vạch trên
  // cùng thấp hơn đỉnh thật (đỉnh 120 mà vạch cao nhất ghi 100) và đường vọt lên
  // trên cả trục.
  const dTop = snapNiceUp(dMax);
  const dTicks = [0, 0.05, 0.2, 0.45, 1]
    .map((f) => (f === 0 ? 0 : snapNice(f * dTop)))
    .filter((v, i, a) => a.indexOf(v) === i && v <= dTop)
    .map((v) => ({
      label: v,
      bottom: `${(Math.sqrt(v / dMax) * 90).toFixed(2)}%`,
    }));

  return {
    n,
    sGrid: sTicks.map((t) => t.y),
    seatsD,
    areaD: `${seatsD} L 100,100 L 0,100 Z`,
    newD,
    renewD,
    xLabels,
    sTicks,
    dTicks,
    points: series.map((d, i) => ({
      d,
      left: `${X(i)}%`,
      seatBottom: `${(100 - Ys(d.seats_end)).toFixed(2)}%`,
      newBottom: `${(100 - Yd(d.new_count)).toFixed(2)}%`,
      renewBottom: `${(100 - Yd(d.renew_count)).toFixed(2)}%`,
      flip: X(i) > 62,
    })),
  };
}

/** Bước chia TRÒN cho một dải: 1/2/2,5/5 × 10ⁿ, chọn bước nhỏ nhất mà vẫn ra
 *  khoảng `target` vạch. Nhờ vậy nhãn luôn là số đọc quen mắt (50, 100, 250…)
 *  chứ không phải 137,5 — và tự đổi theo dữ liệu chứ không ghim cứng. */
function niceStep(span: number, target = 5): number {
  const mag = Math.pow(10, Math.floor(Math.log10(span / target)));
  for (const step of [1, 2, 2.5, 5, 10, 20, 25].map((m) => m * mag)) {
    if (span / step <= target) return step;
  }
  return 10 * mag;
}

/** Số "đẹp" nhỏ nhất KHÔNG dưới `v` — dùng cho mốc đỉnh của trục. */
function snapNiceUp(v: number): number {
  if (v <= 0) return 0;
  if (v < 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const r = v / mag;
  const c = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => x >= r - 1e-9) ?? 10;
  return Math.round(c * mag);
}

/** Làm tròn về con số "đẹp" gần nhất (1, 1,5, 2, 2,5, 3, 4, 5, 6, 8 × 10ⁿ). */
function snapNice(v: number): number {
  if (v <= 0) return 0;
  if (v < 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const r = v / mag;
  const c = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].reduce((a, b) =>
    Math.abs(b - r) < Math.abs(a - r) ? b : a,
  );
  return Math.round(c * mag);
}

/** Catmull-Rom đi qua ĐÚNG từng điểm, control point kẹp trong khoảng hai đầu đoạn
 *  → đường mượt mà không vọt ra ngoài dải dữ liệu (chấm tròn luôn nằm trên đường). */
function curve(p: { x: number; y: number }[]): string {
  const f = (v: number) => v.toFixed(2);
  if (p.length === 0) return "M 0,100";
  if (p.length === 1) return `M ${f(p[0].x)},${f(p[0].y)}`;
  const clamp = (v: number, a: number, b: number) =>
    Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));
  let d = `M ${f(p[0].x)},${f(p[0].y)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] || p[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6, p1.y, p2.y);
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6, p1.y, p2.y);
    d += ` C ${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2.x)},${f(p2.y)}`;
  }
  return d;
}

function GrowthPanel({
  data,
  period,
  setPeriod,
  isMobile,
}: {
  data: DashboardOverview;
  period: number;
  setPeriod: (n: number) => void;
  isMobile: boolean;
}) {
  const geom = useMemo(() => buildGeom(data.series), [data.series]);
  const [hover, setHover] = useState<number | null>(null);
  const c = data.compare;
  const plotH = isMobile ? 170 : 240;

  return (
    <section style={{ ...card, marginTop: 14, padding: isMobile ? 16 : 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <div>
          <h2 style={{ ...cardTitle, marginBottom: 0 }}>Tăng trưởng</h2>
          <div style={{ display: "flex", gap: 14, marginTop: 7, flexWrap: "wrap" }}>
            <Legend color="var(--ink-4)" label="ghế đang phục vụ" area />
            <Legend color="#059669" label="email mới/ngày" />
            <Legend color="#8b918b" label="email gia hạn/ngày" dashed />
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: "6px 12px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border-strong)",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                background: p === period ? "var(--ink)" : "var(--surface)",
                color: p === period ? "var(--surface)" : "var(--ink-2)",
              }}
            >
              {p} ngày
            </button>
          ))}
        </div>
      </div>

      {/* marginTop chừa chỗ cho nhãn trục nằm TRÊN vạch cao nhất — không chừa
          thì "GHẾ" đè lên số của vạch đó. */}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Axis ticks={geom.sTicks} height={plotH} align="left" caption="GHẾ" />
        <div
          style={{ position: "relative", flex: 1, minWidth: 0, height: plotH }}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - r.left) / (r.width || 1);
            setHover(
              Math.max(0, Math.min(geom.n - 1, Math.round(ratio * (geom.n - 1)))),
            );
          }}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }}
          >
            <path d={geom.areaD} fill="var(--bg)" stroke="none" />
            {geom.sGrid.map((y, i) => (
              <line
                key={i}
                x1={0}
                x2={100}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path
              d={geom.seatsD}
              fill="none"
              stroke="var(--ink-4)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={geom.renewD}
              fill="none"
              stroke="#8b918b"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={geom.newD}
              fill="none"
              stroke="#059669"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {hover != null && geom.points[hover] && (
            <HoverMark point={geom.points[hover]} />
          )}
        </div>
        <Axis ticks={geom.dTicks} height={plotH} align="right" caption="EMAIL/NGÀY" />
      </div>

      <div
        style={{
          position: "relative",
          height: 16,
          marginTop: 6,
          marginLeft: 46,
          marginRight: 52,
        }}
      >
        {geom.xLabels.map((x) => (
          <span
            key={x.i}
            style={{
              position: "absolute",
              left: x.left,
              transform: "translateX(-50%)",
              fontSize: 10.5,
              color: "var(--ink-3)",
              whiteSpace: "nowrap",
            }}
          >
            {x.label}
          </span>
        ))}
      </div>

      <p
        style={{
          margin: "10px 0 0",
          fontSize: 10,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          fontFamily: "var(--font-mono)",
          color: "var(--ink-3)",
          lineHeight: 1.6,
        }}
      >
        Trục email/ngày nén căn bậc hai để ngày 2 email vẫn đọc được cạnh ngày 137 ·
        rê chuột để xem số từng ngày · {geom.n} ngày dữ liệu
      </p>

      <div
        style={{
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          marginTop: 14,
          paddingTop: 14,
          borderTop: "1px solid var(--border)",
        }}
      >
        <Compare
          label="Hôm nay"
          value={c.today}
          delta={deltaLabel(c.today, Math.round(c.avg7))}
          against={`so với trung bình 7 ngày ${c.avg7}`}
        />
        <Compare
          label="Tuần này"
          value={c.week}
          delta={deltaLabel(c.week, c.prev_week)}
          against={`so với tuần trước ${c.prev_week}`}
        />
        <Compare
          label="Tháng này tới hôm nay"
          value={c.mtd}
          delta={deltaLabel(c.mtd, c.prev_mtd)}
          against={`so với cùng kỳ tháng trước ${c.prev_mtd}`}
        />
      </div>
    </section>
  );
}

function HoverMark({ point }: { point: Geom["points"][number] }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: point.left,
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border-strong)",
          pointerEvents: "none",
        }}
      />
      {[
        { bottom: point.seatBottom, color: "var(--ink-4)" },
        { bottom: point.renewBottom, color: "#8b918b" },
        { bottom: point.newBottom, color: "#059669" },
      ].map((dot, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: point.left,
            bottom: dot.bottom,
            width: 7,
            height: 7,
            margin: "0 0 -3.5px -3.5px",
            borderRadius: "50%",
            background: dot.color,
            pointerEvents: "none",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          left: point.left,
          top: 4,
          transform: point.flip
            ? "translateX(-100%) translateX(-12px)"
            : "translateX(12px)",
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          padding: "8px 10px",
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: "nowrap",
          boxShadow: "var(--shadow-card)",
          pointerEvents: "none",
          zIndex: 2,
        }}
      >
        <strong style={{ color: "var(--ink)" }}>{shortDay(point.d.date)}</strong>
        <div style={{ color: "var(--ink-2)" }}>Ghế: {point.d.seats_end}</div>
        <div style={{ color: "#059669" }}>Email mới: {point.d.new_count}</div>
        <div style={{ color: "var(--ink-2)" }}>Gia hạn: {point.d.renew_count}</div>
        {point.d.failed_count > 0 && (
          <div style={{ color: "var(--danger)" }}>Hỏng: {point.d.failed_count}</div>
        )}
      </div>
    </>
  );
}

function Axis({
  ticks,
  height,
  align,
  caption,
}: {
  ticks: { label: number; bottom: string }[];
  height: number;
  align: "left" | "right";
  caption: string;
}) {
  return (
    <div
      style={{
        position: "relative",
        height,
        width: align === "left" ? 38 : 44,
        flexShrink: 0,
      }}
    >
      {ticks.map((t, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            bottom: t.bottom,
            [align]: 0,
            transform: "translateY(50%)",
            fontSize: 10,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {t.label}
        </span>
      ))}
      <span
        style={{
          position: "absolute",
          top: -14,
          [align]: 0,
          fontSize: 9,
          letterSpacing: ".1em",
          color: "var(--ink-4)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {caption}
      </span>
    </div>
  );
}

function Legend({
  color,
  label,
  area,
  dashed,
}: {
  color: string;
  label: string;
  area?: boolean;
  dashed?: boolean;
}) {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}
    >
      <span
        style={{
          width: 14,
          height: area ? 8 : 0,
          borderTop: area ? undefined : `2px ${dashed ? "dashed" : "solid"} ${color}`,
          background: area ? "var(--bg)" : undefined,
          borderBottom: area ? `1.5px solid ${color}` : undefined,
          display: "inline-block",
        }}
      />
      <span style={{ color: "var(--ink-2)" }}>{label}</span>
    </span>
  );
}

function Compare({
  label,
  value,
  delta,
  against,
}: {
  label: string;
  value: number;
  delta: string;
  against: string;
}) {
  const down = delta.startsWith("−");
  return (
    <div style={{ flex: "1 1 200px", minWidth: 0 }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{label}</div>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}
      >
        <span style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)" }}>
          {value}
        </span>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: down ? "var(--danger)" : "#059669",
          }}
        >
          {delta}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 1 }}>
        {against}
      </div>
    </div>
  );
}

// ── Việc cần làm ────────────────────────────────────────────────────────────

function TodoPanel({ data }: { data: DashboardOverview }) {
  const t = data.todos;
  // Dòng "lời mời lỗi" KHÔNG dẫn đi đâu mà bung ra ngay tại chỗ: email lời mời
  // hỏng bị xoá phantom khỏi bảng member nên không trang nào khác liệt kê được.
  const [openFailed, setOpenFailed] = useState(false);

  // Thứ tự = mức khẩn, KHÔNG theo số lượng. Dòng bằng 0 vẫn đứng nguyên chỗ (đọc
  // quen mắt) nhưng chìm hẳn xuống: không màu, không mũi tên, không bấm được.
  const rows = [
    {
      key: "failed",
      n: t.failed_pending_reinvite,
      label: "Email - Lời mời lỗi, chưa được mời lại",
      note: "",
      tone: DANGER,
      to: "",
    },
    {
      key: "due",
      n: t.due_soon,
      label: "Đến hạn - dưới 7 ngày",
      note: "",
      tone: WARN,
      to: "/renewals",
    },
    {
      key: "pending",
      n: t.pending,
      label: "Lời mời đang chờ xử lý",
      note: "",
      tone: PLAIN,
      // Mở thẳng tab "Chờ tham gia" — đúng danh sách của con số vừa bấm.
      to: "/added-emails?tab=pending",
    },
    {
      key: "unpaid",
      n: t.unpaid,
      label: "Chưa thanh toán",
      note: "",
      tone: PLAIN,
      // Mở thẳng chip "Chưa thanh toán" — chip lọc xuyên cả hai tab nên khớp
      // đúng con số đang hiện ở đây.
      to: "/added-emails?filter=unpaid",
    },
    {
      // Email chưa chỉ định người nhận tin nhắc gia hạn: tin sắp-hết-hạn về chính
      // đại lý chứ không tới khách. Đứng CUỐI vì không gấp — và số này thường bằng
      // gần hết danh sách nên để trên sẽ át mấy dòng thật sự phải làm hôm nay.
      key: "notify",
      n: t.unbound_notify,
      label: "Chưa gắn người nhận nhắc gia hạn",
      note: "",
      tone: PLAIN,
      to: "/notifications",
    },
  ];
  const nothing = rows.every((r) => r.n === 0);

  return (
    <section style={{ ...card, marginTop: 14 }}>
      <h2 style={{ ...cardTitle, marginBottom: nothing ? 8 : 12 }}>Việc cần làm</h2>
      {nothing && (
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--ink-2)" }}>
          Không có việc khẩn hôm nay.
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {rows.map((r) => {
          const dim = r.n === 0;
          const expandable = r.key === "failed";
          const body = (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 4px",
                borderTop: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  minWidth: 44,
                  textAlign: "center",
                  padding: "4px 8px",
                  borderRadius: "var(--radius)",
                  fontSize: 15,
                  fontWeight: dim ? 500 : 700,
                  color: dim ? "var(--ink-4)" : r.tone.color,
                  background: dim ? "transparent" : r.tone.bg,
                }}
              >
                {r.n}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: dim ? 500 : 700,
                    color: dim ? "var(--ink-3)" : "var(--ink)",
                  }}
                >
                  {r.label}
                </span>
                {!dim && r.note && (
                  <span
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--ink-3)",
                      marginTop: 1,
                    }}
                  >
                    {r.note}
                  </span>
                )}
              </span>
              {!dim && (
                <span style={{ fontSize: 14, color: "var(--ink-3)" }}>
                  {expandable ? (openFailed ? "−" : "+") : "→"}
                </span>
              )}
            </div>
          );
          if (dim) return <div key={r.key}>{body}</div>;
          if (expandable) {
            return (
              <div key={r.key}>
                <button
                  onClick={() => setOpenFailed((v) => !v)}
                  style={{
                    display: "block",
                    width: "100%",
                    background: "none",
                    border: "none",
                    padding: 0,
                    textAlign: "left",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  {body}
                </button>
                {openFailed && <FailedEmailList rows={data.failed_emails} />}
              </div>
            );
          }
          return (
            <Link key={r.key} to={r.to} style={{ textDecoration: "none" }}>
              {body}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** Email lời mời lỗi còn chờ mời lại — chỉ email, trạng thái tiền và thời gian
 *  (chốt user 2026-08-31). Nguyên nhân kỹ thuật không thuộc về danh sách việc. */
function FailedEmailList({ rows }: { rows: DashboardOverview["failed_emails"] }) {
  if (rows.length === 0) return null;
  return (
    <div
      style={{
        margin: "0 4px 10px",
        padding: "8px 12px",
        background: "var(--bg)",
        borderRadius: "var(--radius)",
      }}
    >
      {rows.map((r) => (
        <div
          key={r.email}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "6px 0",
            fontSize: 12.5,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              flex: "1 1 200px",
              minWidth: 0,
              color: "var(--ink)",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.email}
          </span>
          {r.fee_state !== "none" && (
            <span
              style={{
                fontSize: 11.5,
                whiteSpace: "nowrap",
                color: r.fee_state === "refunded" ? "#059669" : "var(--ink-2)",
              }}
            >
              {r.fee_state === "refunded"
                ? "đã hoàn phí"
                : "giữ tiền, mời lại miễn phí"}
            </span>
          )}
          <span
            style={{
              color: "var(--ink-3)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              whiteSpace: "nowrap",
            }}
          >
            {shortDay(r.failed_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Sắp đến hạn ─────────────────────────────────────────────────────────────

function DuePanel({
  data,
  isMobile,
}: {
  data: DashboardOverview;
  isMobile: boolean;
}) {
  // Bấm một đợt → POPUP liệt kê từng email + gia hạn ngay tại chỗ (user
  // 2026-08-31). Trước đây chỉ bung ra dòng ngày: nhìn thấy cụm 277 ghế mà không
  // làm gì được ngay thì con số chỉ để ngắm.
  const [openWeek, setOpenWeek] = useState<{ from: string; to: string } | null>(
    null,
  );
  const weeks = data.due_weeks;
  const total = weeks.reduce((a, w) => a + w.money, 0);
  const seats = weeks.reduce((a, w) => a + w.seats, 0);
  const first = weeks[0];
  const balance = data.wallet?.balance ?? 0;
  const short = first ? first.money - balance : 0;

  return (
    <section style={{ ...card, marginTop: 14 }}>
      <h2 style={{ ...cardTitle, marginBottom: 4 }}>Sắp đến hạn 30 ngày</h2>
      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--ink-3)" }}>
        Gom theo đợt 7 ngày từ hôm nay — bấm một đợt để xem danh sách và gia hạn.
      </p>
      {weeks.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
          Không có ghế nào đến hạn trong 30 ngày tới.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {weeks.map((w) => (
            <button
              key={w.from_date}
              onClick={() => setOpenWeek({ from: w.from_date, to: w.to_date })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 4px",
                background: "none",
                border: "none",
                borderTop: "1px solid var(--border)",
                cursor: "pointer",
                textAlign: "left",
                font: "inherit",
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                <span style={{ color: "var(--ink)", fontWeight: 600 }}>
                  {shortDay(w.from_date)} – {shortDay(w.to_date)}
                </span>
                <span style={{ color: "var(--ink-2)" }}> · {w.seats} ghế</span>
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
                {money(w.money)}
                <span style={{ fontSize: 10.5, fontWeight: 500 }}>đ</span>
              </span>
              <span style={{ fontSize: 13, color: "var(--ink-3)" }}>›</span>
            </button>
          ))}
        </div>
      )}

      {weeks.length > 0 && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}
        >
          <div
            style={{ display: "flex", justifyContent: "space-between", gap: 10 }}
          >
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              Tổng cần chuẩn bị · {seats} ghế
            </span>
            <span style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>
              {money(total)}
              <span style={{ fontSize: 11, fontWeight: 500 }}>đ</span>
            </span>
          </div>
          {data.wallet && first && (
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 12,
                lineHeight: 1.55,
                color: short > 0 ? "var(--danger)" : "var(--ink-2)",
              }}
            >
              Số dư {money(balance)}đ,{" "}
              {short > 0 ? (
                <>
                  thiếu <strong>{money(short)}đ</strong> cho tuần đến hạn gần nhất (
                  {shortDay(first.from_date)} – {shortDay(first.to_date)})
                </>
              ) : (
                <>đủ cho tuần đến hạn gần nhất ({shortDay(first.from_date)})</>
              )}
            </p>
          )}
        </div>
      )}
      {isMobile && weeks.length > 0 && (
        <Link
          to="/renewals"
          style={{
            display: "inline-block",
            marginTop: 10,
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ink-3)",
          }}
        >
          Xem trang Gia hạn →
        </Link>
      )}

      {openWeek && (
        <DueWeekModal
          from={openWeek.from}
          to={openWeek.to}
          onClose={() => setOpenWeek(null)}
        />
      )}
    </section>
  );
}

// ── Chất lượng lượt mời ─────────────────────────────────────────────────────

function QualityPanel({ data }: { data: DashboardOverview }) {
  const q = data.quality;
  if (q.total === 0) return null;
  const okPct = (q.ok_count / q.total) * 100;

  return (
    <section style={{ ...card, marginTop: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ ...cardTitle, marginBottom: 0 }}>
          Chất lượng lượt mời {q.days} ngày
        </h2>
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {q.total} lượt · tỉ lệ hỏng{" "}
          <strong style={{ color: q.failed_count ? "var(--danger)" : "var(--ink)" }}>
            {pctLabel(q.fail_pct)}
          </strong>
        </span>
      </div>

      <div
        style={{
          display: "flex",
          height: 10,
          borderRadius: 5,
          overflow: "hidden",
          margin: "12px 0 8px",
          background: "var(--bg)",
        }}
      >
        <div style={{ flex: `1 1 ${okPct}%`, background: "#059669" }} />
        {q.failed_count > 0 && (
          <div
            style={{
              flex: `1 1 ${100 - okPct}%`,
              minWidth: 3,
              background: "var(--danger)",
            }}
          />
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 16,
          fontSize: 12.5,
          color: "var(--ink-2)",
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <span>{q.ok_count} thành công</span>
        <span>{q.failed_count} hỏng</span>
        {/* Lượt hỏng rồi mời lại được NGAY trong ngày không tính là hỏng — nhưng
            im luôn thì khối này khoe "gần như không hỏng" đúng hôm phải hoàn phí
            mấy chục lượt. */}
        {q.retried_count > 0 && (
          <span style={{ color: "var(--ink-3)" }}>
            {q.retried_count} phải mời lại mới xong
          </span>
        )}
      </div>

      {q.reasons.map((r) => (
        <div
          key={r.code}
          title={r.message}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "9px 4px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <span
            style={{
              minWidth: 34,
              textAlign: "center",
              fontSize: 14,
              fontWeight: 700,
              color: "var(--danger)",
            }}
          >
            {r.count}
          </span>
          {/* Chỉ nhãn ngắn — câu đầy đủ để ở tooltip. Dán nguyên đoạn hướng dẫn
              vào từng dòng thì bảng xếp hạng thành bài đọc, không ai soi ra được
              lỗi nào đang nhiều nhất. */}
          <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--ink)" }}>
            {r.label}
          </span>
          {/* Mã lỗi mà mời lại cũng hỏng y hệt (hết suất, chưa đăng nhập, giao
              diện ChatGPT đổi) phải nói rõ là VIỆC CỦA ADMIN — dán nhãn "mời lại"
              cho cả hai nhóm là cách sinh ra 16 lệnh mời lại y hệt sáng 28/8. */}
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              padding: "3px 8px",
              borderRadius: 20,
              color: r.self_serve ? "var(--ink-2)" : "#8a6d1f",
              background: r.self_serve ? "var(--bg)" : "var(--warning-bg)",
            }}
          >
            {r.self_serve ? "mời lại được" : "báo quản trị viên"}
          </span>
        </div>
      ))}
    </section>
  );
}

// ── Tài khoản mới ───────────────────────────────────────────────────────────

function EmptyState({ hasWallet }: { hasWallet: boolean }) {
  const steps = [
    hasWallet
      ? {
          n: "1",
          title: "Nạp tiền vào ví",
          desc: "Mỗi lượt mời hoặc gia hạn trừ phí cố định. Nạp trước để không bị gián đoạn giữa chừng.",
          cta: "Nạp tiền",
          to: "/wallet",
          primary: true,
        }
      : null,
    {
      n: hasWallet ? "2" : "1",
      title: "Mời email đầu tiên",
      desc: "Nhập email khách và chọn số tháng. Hết hạn hệ thống tự gỡ khỏi workspace.",
      cta: "Mời thành viên",
      to: "/invite",
      primary: !hasWallet,
    },
    {
      n: hasWallet ? "3" : "2",
      title: "Kết nối Telegram nhận nhắc",
      desc: "Nhận thông báo ghế sắp hết hạn và lượt mời hỏng ngay trên điện thoại.",
      cta: "Kết nối",
      to: "/notifications",
      primary: false,
    },
  ].filter(Boolean) as {
    n: string;
    title: string;
    desc: string;
    cta: string;
    to: string;
    primary: boolean;
  }[];

  return (
    <section style={{ ...card, marginTop: 14, padding: 24 }}>
      <h2 className="display-h2">
        Bắt đầu bán ghế trong {steps.length === 3 ? "ba" : "hai"} bước
      </h2>
      <p style={{ margin: "6px 0 18px", fontSize: 13.5, color: "var(--ink-2)" }}>
        Chưa có email nào trong workspace. Làm xong các bước dưới là trang này bắt
        đầu có số.
      </p>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {steps.map((s) => (
          <div
            key={s.n}
            style={{
              flex: "1 1 240px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              padding: 16,
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "var(--bg)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                color: "var(--ink-2)",
                marginBottom: 10,
              }}
            >
              {s.n}
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)" }}>
              {s.title}
            </div>
            <p
              style={{
                margin: "5px 0 12px",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: "var(--ink-2)",
              }}
            >
              {s.desc}
            </p>
            <Link
              to={s.to}
              style={{
                ...(s.primary ? primaryBtn : secondaryBtn),
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              {s.cta}
            </Link>
          </div>
        ))}
      </div>
      <p style={{ margin: "16px 0 0", fontSize: 12, color: "var(--ink-3)" }}>
        Biểu đồ tăng trưởng, việc cần làm và chất lượng lượt mời sẽ xuất hiện sau
        ngày đầu tiên có dữ liệu.
      </p>
    </section>
  );
}

// ── Đang tải ────────────────────────────────────────────────────────────────

function Bone({ h, w = "100%" }: { h: number; w?: string | number }) {
  return (
    <div
      style={{
        height: h,
        width: w,
        borderRadius: 6,
        background: "var(--bg)",
      }}
    />
  );
}

/** Khung xám theo ĐÚNG bố cục thật (không spinner): mắt người dùng không phải
 *  nhảy chỗ khi số về. */
function Skeleton({ isMobile }: { isMobile: boolean }) {
  return (
    <div className="page-fade" style={{ padding: "8px 4px 40px" }}>
      <div style={{ marginBottom: 18 }}>
        <Bone h={30} w={180} />
        <div style={{ height: 8 }} />
        <Bone h={14} w={300} />
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ ...card, flex: "1 1 220px", padding: 18 }}>
            <Bone h={10} w={80} />
            <div style={{ height: 14 }} />
            <Bone h={32} w={120} />
            <div style={{ height: 10 }} />
            <Bone h={12} w={160} />
          </div>
        ))}
      </div>
      <div style={{ ...card, marginTop: 14 }}>
        <Bone h={17} w={140} />
        <div style={{ height: 16 }} />
        <Bone h={isMobile ? 170 : 240} />
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
        <div style={{ ...card, flex: "2 1 520px" }}>
          <Bone h={17} w={120} />
          <div style={{ height: 14 }} />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ padding: "9px 0" }}>
              <Bone h={20} />
            </div>
          ))}
        </div>
        <div style={{ ...card, flex: "1 1 300px" }}>
          <Bone h={17} w={160} />
          <div style={{ height: 14 }} />
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ padding: "9px 0" }}>
              <Bone h={20} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
