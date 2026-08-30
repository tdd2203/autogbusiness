/**
 * Thống kê ĐẦU EMAIL trong Báo cáo tài chính — một ngày phục vụ bao nhiêu email,
 * bao nhiêu là add mới bao nhiêu là gia hạn, của đại lý nào, thành công/thất bại.
 *
 * ĐƠN VỊ ĐẾM = 1 EMAIL TRONG 1 NGÀY (giờ VN), KHÔNG phải 1 lượt thao tác (chốt user
 * 2026-08-29). Email mời đi mời lại 5 lượt trong ngày vẫn là 1 email; có lượt nào
 * thành công thì ngày đó tính THÀNH CÔNG. Backend đã gộp sẵn (wallet/email_stats.py),
 * chỗ này chỉ vẽ — đừng cộng lại từ nhật ký ở frontend.
 *
 * NGÀY TRỐNG BỊ ẨN: khoảng 6 tháng có ~180 ngày mà phần lớn không add email nào;
 * hiện hết thì phải cuộn qua hàng chục dòng số 0 mới thấy ngày có việc.
 *
 * MỞ TỪ NÚT RIÊNG, không xếp nối đuôi dưới sổ tiền (chốt user 2026-08-30): bảng
 * theo ngày dài hàng chục dòng, để dưới trang thì mỗi lần xem phải cuộn qua toàn
 * bộ báo cáo tiền. Cùng kiểu modal với "Doanh thu theo đại lý".
 */
import { useMemo, useState, type ReactNode } from "react";
import { useEmailStats } from "../hooks/useWallet";
import type { EmailStats, EmailStatsAgent, EmailStatsDay } from "../lib/wallet";

const FAIL = "#b3261e"; // thất bại
const NEW = "#3a5bd0"; // add mới (= --perm-member)
const RENEW = "#a8791f"; // gia hạn

const WEEKDAY = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** "2026-08-29" → { day: "29/08", wd: "T6" }. Parse tay, KHÔNG new Date(iso) —
 *  chuỗi date-only bị coi là UTC nên máy ở múi âm sẽ lùi mất 1 ngày. */
function dayLabel(iso: string): { day: string; wd: string } {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return { day: `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`, wd: WEEKDAY[dt.getDay()] };
}

function agentName(a: EmailStatsAgent): string {
  return a.username || a.email || "Chưa rõ chủ";
}

const COLS = "minmax(120px,1.1fr) 0.85fr 0.85fr 0.85fr 0.85fr 0.8fr";

export function EmailStatsModal({
  from,
  to,
  onClose,
}: {
  from: string;
  to: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useEmailStats(from, to);
  const [tab, setTab] = useState<"day" | "agent">("day");

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
          width: 900,
          maxWidth: "100%",
          maxHeight: "86vh",
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
          zIndex: 1,
          background: "var(--surface)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          padding: "18px 24px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>
            Thống kê email add mới &amp; gia hạn
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2, maxWidth: 560 }}>
            Đếm theo ĐẦU EMAIL, mỗi email chỉ tính 1 lần trong 1 ngày — mời đi mời lại vẫn là 1, có lượt
            nào thành công thì ngày đó tính thành công. {from} → {to}, ngày không có email nào bị ẩn.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", borderRadius: 10, padding: 3 }}>
          {(
            [
              ["day", "Theo ngày"],
              ["agent", "Theo đại lý"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "7px 14px",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
                background: tab === key ? "var(--ink)" : "transparent",
                color: tab === key ? "var(--surface)" : "var(--ink-2)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng"
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
            flexShrink: 0,
          }}
        >
          ✕
        </button>
        </div>
      </div>

      {isLoading && <Empty>Đang tải thống kê email…</Empty>}
      {isError && <Empty>Không tải được thống kê email. Thử lại sau.</Empty>}
      {data && (
        <>
          <Summary data={data} />
          {tab === "day" ? <DayTable data={data} /> : <AgentTable rows={data.by_agent} />}
        </>
      )}
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)" }}>{children}</div>;
}

// ── Dải số tổng ─────────────────────────────────────────────────────────────

function Summary({ data }: { data: EmailStats }) {
  const failed = data.new_failed + data.renew_failed;
  const failRate = data.total > 0 ? (failed / data.total) * 100 : 0;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <Stat label="TỔNG LƯỢT EMAIL" value={data.total} hint={`${data.unique_emails} email khác nhau`} />
      <Stat label="ADD MỚI" value={data.new_ok + data.new_failed} color={NEW} hint={`${data.new_ok} thành công · ${data.new_failed} thất bại`} />
      <Stat label="GIA HẠN" value={data.renew_ok + data.renew_failed} color={RENEW} hint={`${data.renew_ok} thành công · ${data.renew_failed} thất bại`} />
      <Stat
        label="THẤT BẠI"
        value={failed}
        color={failed > 0 ? FAIL : undefined}
        hint={`${failRate.toFixed(1)}% tổng lượt`}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: number;
  hint: string;
  color?: string;
}) {
  return (
    <div style={{ padding: "14px 24px", borderRight: "1px solid var(--border)" }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.1em", color: "var(--ink-3)", fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 23,
          fontWeight: 700,
          fontFamily: "var(--font-display)",
          color: color ?? "var(--ink)",
          lineHeight: 1.25,
          marginTop: 3,
        }}
      >
        {value.toLocaleString("vi-VN")}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{hint}</div>
    </div>
  );
}

// ── Bảng theo ngày ──────────────────────────────────────────────────────────

function DayTable({ data }: { data: EmailStats }) {
  // Ngày mới nhất lên đầu — nhìn báo cáo là để xem hôm nay/hôm qua chạy ra sao.
  const rows = useMemo(
    () => data.days.filter((d) => d.total > 0).slice().reverse(),
    [data.days],
  );
  const [open, setOpen] = useState<string | null>(null);

  if (rows.length === 0) {
    return <Empty>Khoảng thời gian này chưa add hay gia hạn email nào.</Empty>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 620 }}>
        <HeadRow cols={["NGÀY", "ADD MỚI ✓", "ADD MỚI ✕", "GIA HẠN ✓", "GIA HẠN ✕", "TỔNG"]} />
        {rows.map((d) => (
          <DayRow key={d.date} day={d} open={open === d.date} onToggle={() => setOpen(open === d.date ? null : d.date)} />
        ))}
      </div>
    </div>
  );
}

function HeadRow({ cols }: { cols: string[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        gap: 12,
        padding: "11px 24px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      {cols.map((h, i) => (
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
  );
}

function DayRow({ day, open, onToggle }: { day: EmailStatsDay; open: boolean; onToggle: () => void }) {
  const { day: dd, wd } = dayLabel(day.date);
  const canOpen = day.by_agent.length > 0;
  return (
    <>
      <div
        onClick={canOpen ? onToggle : undefined}
        style={{
          display: "grid",
          gridTemplateColumns: COLS,
          gap: 12,
          alignItems: "center",
          padding: "12px 24px",
          borderBottom: "1px solid var(--border)",
          cursor: canOpen ? "pointer" : "default",
          background: open ? "var(--surface-2)" : "transparent",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden
            style={{
              fontSize: 10,
              color: "var(--ink-3)",
              width: 10,
              visibility: canOpen ? "visible" : "hidden",
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform 0.12s",
            }}
          >
            ▶
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", fontFamily: "var(--font-mono)" }}>
            {dd}
          </span>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{wd}</span>
        </div>
        <Num v={day.new_ok} color={NEW} />
        <Num v={day.new_failed} color={FAIL} />
        <Num v={day.renew_ok} color={RENEW} />
        <Num v={day.renew_failed} color={FAIL} />
        <Num v={day.total} bold />
      </div>
      {open &&
        day.by_agent.map((a) => (
          <div
            key={a.user_id ?? "unknown"}
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 12,
              alignItems: "center",
              padding: "9px 24px 9px 46px",
              borderBottom: "1px solid var(--border)",
              background: "var(--surface-2)",
            }}
          >
            <div style={{ fontSize: 12.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>
              {agentName(a)}
            </div>
            <Num v={a.new_ok} small />
            <Num v={a.new_failed} small color={a.new_failed > 0 ? FAIL : undefined} />
            <Num v={a.renew_ok} small />
            <Num v={a.renew_failed} small color={a.renew_failed > 0 ? FAIL : undefined} />
            <Num v={a.total} small />
          </div>
        ))}
    </>
  );
}

function Num({ v, color, bold, small }: { v: number; color?: string; bold?: boolean; small?: boolean }) {
  return (
    <div
      style={{
        textAlign: "right",
        fontSize: small ? 12.5 : 13.5,
        fontFamily: "var(--font-mono)",
        fontWeight: bold ? 700 : 500,
        // Số 0 làm nhạt đi để mắt bắt ngay ô có việc.
        color: v === 0 ? "var(--ink-3)" : color ?? "var(--ink)",
      }}
    >
      {v.toLocaleString("vi-VN")}
    </div>
  );
}

// ── Bảng theo đại lý (gộp cả kỳ) ────────────────────────────────────────────

function AgentTable({ rows }: { rows: EmailStatsAgent[] }) {
  if (rows.length === 0) {
    return <Empty>Khoảng thời gian này chưa add hay gia hạn email nào.</Empty>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 620 }}>
        <HeadRow cols={["ĐẠI LÝ", "ADD MỚI ✓", "ADD MỚI ✕", "GIA HẠN ✓", "GIA HẠN ✕", "TỔNG"]} />
        {rows.map((a) => (
          <div
            key={a.user_id ?? "unknown"}
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 12,
              alignItems: "center",
              padding: "12px 24px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ overflow: "hidden" }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: a.user_id ? "var(--ink)" : "var(--ink-3)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {agentName(a)}
              </div>
              {a.username && a.email && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--ink-3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.email}
                </div>
              )}
            </div>
            <Num v={a.new_ok} color={NEW} />
            <Num v={a.new_failed} color={FAIL} />
            <Num v={a.renew_ok} color={RENEW} />
            <Num v={a.renew_failed} color={FAIL} />
            <Num v={a.total} bold />
          </div>
        ))}
      </div>
    </div>
  );
}

export default EmailStatsModal;
