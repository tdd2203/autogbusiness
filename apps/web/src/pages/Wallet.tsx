/**
 * Trang Ví (feature 003-wallet-invite-payment) — số dư, nạp tiền (QR), lịch sử
 * giao dịch, gửi & theo dõi yêu cầu rút. Chỉ user có cờ wallet_beta (hoặc
 * super-admin) mới vào được (route bảo vệ + sidebar ẩn với người khác).
 *
 * Bố cục theo bản thiết kế Claude Design "Ví" (user 2026-08-26):
 *   • Hai thẻ chốt SỐ CỦA NGÀY ở trên (mời được bao nhiêu / tiêu bao nhiêu, kèm
 *     thanh tỉ lệ hoá-đơn ↔ trừ-ví).
 *   • Lịch sử chiếm cột rộng bên trái: chip lọc theo "tiền đi đường nào", thanh
 *     chọn ngày, và mỗi ngày một tiêu đề chốt Nạp/Chi/New/Renew.
 *   • Cột phải gộp SỐ DƯ + Nạp/Rút vào MỘT thẻ có tab, dưới cùng là bảng giải
 *     thích cách tính phí.
 * Ngày chọn ở thanh lịch sử cũng là ngày của hai thẻ trên — trước đây trang có
 * HAI ô chọn ngày rời nhau (báo cáo ngày và lịch sử) nên dễ đọc lệch nhau.
 */
import { useMemo, useState } from "react";
import {
  useCreateWithdrawal,
  useWallet,
  useWalletDailySummary,
  useWalletLive,
  useWalletTransactions,
} from "../hooks/useWallet";
import { formatVnd, TXN_KIND_LABEL } from "../lib/wallet";
import type { WalletDailySummary, WalletTxn } from "../lib/wallet";
import {
  buildTxnCsv,
  buildTxnRows,
  countHiddenRows,
  countVoidedInvites,
  groupRowsByDay,
  traceRefundUsage,
  vnDateKey,
} from "../lib/wallet-history";
import type { DayGroup, RefundSource, RefundTrace, TxnChannel, TxnRow, VoidedPair } from "../lib/wallet-history";
import { ApiError } from "../lib/api";
import { toast } from "../components/Toast";
import TopupModal from "../components/TopupModal";
import SepayReconcileModal from "../components/SepayReconcileModal";
import { useAuth } from "../hooks/useAuth";

/** Cấu hình rút tiền lưu cục bộ theo từng user (STK mặc định + số tiền gợi ý). */
type WithdrawConfig = { bank_account: string; default_amount: number };

function withdrawConfigKey(userId: string): string {
  return `wallet.withdrawConfig.${userId}`;
}

function loadWithdrawConfig(userId: string | undefined): WithdrawConfig | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(withdrawConfigKey(userId));
    return raw ? (JSON.parse(raw) as WithdrawConfig) : null;
  } catch {
    return null;
  }
}

function saveWithdrawConfig(userId: string, cfg: WithdrawConfig): void {
  localStorage.setItem(withdrawConfigKey(userId), JSON.stringify(cfg));
}

/** Hôm nay theo lịch VIỆT NAM (YYYY-MM-DD) — khớp mốc ngày mà API dùng để chốt số. */
function vnToday(): string {
  return vnDateKey(new Date().toISOString());
}

/** "2026-08-26" → "26/8/2026" (nhãn ngày kiểu Việt, bỏ số 0 thừa). */
function vnDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}/${m}/${y}`;
}

/** Số nguyên VND từ ô nhập (bỏ mọi ký tự không phải chữ số). */
function parseVnd(text: string): number {
  const digits = text.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

/** 3.300.000 → "3,3 tr" (nhãn ngắn trên nút chọn nhanh). */
function shortVnd(n: number): string {
  const trim = (v: number) => String(Number(v.toFixed(1))).replace(".", ",");
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)} tỷ`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)} tr`;
  if (n >= 1_000) return `${trim(n / 1_000)} k`;
  return String(n);
}

/** Số tiền lớn không kèm ký hiệu (chữ "đ" hiện riêng, cỡ nhỏ hơn). */
function bigVnd(n: number): string {
  return Math.abs(Math.round(n)).toLocaleString("vi-VN");
}

/** Số dòng lịch sử hiện lần đầu; nút "xem thêm" cộng dần từng nấc này. */
const PAGE_ROWS = 25;

export default function Wallet() {
  const { data: wallet, isLoading } = useWallet();
  // Số dư tự nhích 30s/lần; đổi số ⇒ lịch sử + tổng kết ngày nạp lại theo.
  useWalletLive();
  const [topupAmount, setTopupAmount] = useState<number | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);

  const today = vnToday();
  /** Ngày đang xem; null = xem mọi ngày (nút "Tất cả"). Mặc định là HÔM NAY —
   *  mở ví ra là thấy ngay việc của hôm nay, không phải lọc lại (user 2026-08-26).
   *  Hai thẻ trên chốt số của `day ?? hôm nay` nên luôn khớp với danh sách. */
  const [day, setDay] = useState<string | null>(today);
  // Ngày đang chọn được xin THẲNG ở server (không lọc trên trang đầu 100 dòng nữa) —
  // nếu không thì ngày cũ nào nằm ngoài 100 bút toán gần nhất sẽ hiện rỗng như thể
  // lịch sử đã mất (user 2026-08-26).
  const {
    data: txnPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useWalletTransactions(day);
  const txns = useMemo(
    () => ({ items: (txnPages?.pages ?? []).flatMap((p) => p.items) }),
    [txnPages],
  );
  const [channel, setChannel] = useState<TxnChannel | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [limit, setLimit] = useState(PAGE_ROWS);

  const rows = useMemo(() => buildTxnRows(txns.items), [txns]);
  const voidedCount = useMemo(() => countVoidedInvites(rows), [rows]);
  // Lần nguồn gốc tiền: khoản hoàn nào đã bị lượt mời sau tiêu hết thì TRIỆT TIÊU
  // (ẩn cùng công tắc lượt hỏng), lượt mời tiêu nó thì mang chú thích "dùng tiền
  // hoàn từ email …" — user 2026-08-26.
  const trace = useMemo(() => traceRefundUsage(rows), [rows]);
  const settled = useMemo(() => {
    const set = new Set<TxnRow>();
    for (const [row, u] of trace.usage) if (u.used >= u.total) set.add(row);
    return set;
  }, [trace]);
  const groups = useMemo(
    () => groupRowsByDay(rows, { channel, day, showVoided, hidden: settled }),
    [rows, channel, day, showVoided, settled],
  );
  // Bao nhiêu dòng đang bị công tắc giấu TRONG phạm vi đang xem — để danh sách rỗng
  // còn nói được "đang ẩn N dòng" thay vì "không có giao dịch" (user 2026-08-27).
  const hiddenHere = useMemo(
    () => countHiddenRows(rows, { channel, day, hidden: settled }),
    [rows, channel, day, settled],
  );

  const fee = wallet?.invite_fee_vnd ?? 0;

  function exportCsv() {
    // Xuất ĐÚNG những dòng đang hiện (theo chip + ngày đang chọn) — báo cáo phải
    // khớp với cái người xuất đang nhìn thấy, khỏi phải đoán nó lấy phạm vi nào.
    const csv = buildTxnCsv(groups);
    const stamp = day ?? `den-${today}`;
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vi-giao-dich-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page-fade" style={{ padding: "8px 4px 40px" }}>
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.025em", color: "var(--ink)", marginBottom: 6 }}>Ví</h1>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)", maxWidth: 520 }}>
            {fee > 0 ? (
              <>
                Mỗi lời mời có phí cố định <strong style={{ color: "var(--ink)" }}>{formatVnd(fee)}</strong>. Phí được trừ từ số dư ví.
              </>
            ) : (
              "Nạp tiền để mời thành viên. Mỗi lời mời trừ phí cố định từ số dư."
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button onClick={() => setReconcileOpen(true)} style={secondaryBtn}>
            Đối soát ngân hàng
          </button>
          <button onClick={exportCsv} disabled={groups.length === 0} style={{ ...secondaryBtn, opacity: groups.length === 0 ? 0.5 : 1 }}>
            Xuất báo cáo
          </button>
          <button onClick={() => setTopupAmount(0)} style={primaryBtn}>+ Nạp tiền</button>
        </div>
      </header>

      <DaySummary date={day ?? today} isToday={(day ?? today) === today} />

      <section style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start", marginTop: 14 }}>
        <div style={{ ...card, flex: "8 1 420px", minWidth: 0, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
              <h2 style={{ ...cardTitle, marginBottom: 0 }}>Lịch sử giao dịch</h2>
              {(voidedCount > 0 || settled.size > 0) && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={showVoided}
                    onChange={() => setShowVoided((v) => !v)}
                    style={{ width: 15, height: 15, accentColor: "var(--ink)", cursor: "pointer" }}
                  />
                  Hiện {hiddenLabel(voidedCount, settled.size)}
                </label>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {CHANNEL_CHIPS.map((c) => (
                <button
                  key={c.label}
                  onClick={() => { setChannel(c.value); setLimit(PAGE_ROWS); }}
                  style={{ ...chip, ...(channel === c.value ? chipOn : null) }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 20px", borderBottom: "1px solid var(--border)" }}>
            <button onClick={() => setDay(shiftDay(day ?? today, -1))} aria-label="Ngày trước" style={iconBtn}>←</button>
            <button
              onClick={() => setDay(shiftDay(day ?? today, 1))}
              aria-label="Ngày sau"
              disabled={(day ?? today) >= today}
              style={{ ...iconBtn, opacity: (day ?? today) >= today ? 0.4 : 1 }}
            >
              →
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border-strong)", background: "var(--surface)", borderRadius: 8, padding: "0 10px", height: 32, cursor: "pointer" }}>
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", color: "var(--ink)" }}>
                {day ? vnDateLabel(day) : "Tất cả các ngày"}
              </span>
              <input
                type="date"
                value={day ?? today}
                max={today}
                onChange={(e) => { setDay(e.target.value || null); setLimit(PAGE_ROWS); }}
                style={{ width: 20, border: "none", background: "transparent", fontSize: 13, color: "var(--ink-3)", cursor: "pointer", padding: 0 }}
              />
            </label>
            {/* Công tắc, không phải nút một chiều: đang xem "tất cả các ngày" mà bấm lại
                thì về HÔM NAY. Trước đây bấm lần hai không làm gì, muốn quay lại phải
                mở lịch chọn tay giữa một danh sách dài (user 2026-08-27: "khó nhìn"). */}
            <button
              onClick={() => { setDay(day ? null : today); setLimit(PAGE_ROWS); }}
              title={day ? "Xem tất cả các ngày" : "Bấm lại để về hôm nay"}
              style={{ ...chip, ...(day ? null : chipOn) }}
            >
              Tất cả
            </button>
          </div>

          <TxnGroups
            groups={groups}
            limit={limit}
            // Còn dòng đã tải mà chưa hiện → chỉ nới ô hiển thị. Hết sạch → xin server
            // trang CŨ HƠN. Nhờ vậy nút "xem thêm" đi được tới tận bút toán đầu tiên,
            // không dừng ở trang đầu như trước.
            onMore={() => {
              const loaded = groups.reduce((n, g) => n + g.rows.length, 0);
              if (limit < loaded) setLimit((n) => n + PAGE_ROWS);
              else if (hasNextPage) { setLimit((n) => n + PAGE_ROWS); void fetchNextPage(); }
            }}
            canMore={hasNextPage}
            loadingMore={isFetchingNextPage}
            day={day}
            trace={trace}
            hidden={showVoided ? { voided: 0, settled: 0 } : hiddenHere}
            onShowHidden={() => setShowVoided(true)}
            serverTotals={channel === null}
          />
        </div>

        <div style={{ flex: "1 1 318px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          <BalancePanel
            balance={wallet?.balance ?? 0}
            held={wallet?.held ?? 0}
            fee={fee}
            isLoading={isLoading}
            onTopup={setTopupAmount}
          />
          <FeeLegend />
        </div>
      </section>

      {topupAmount !== null && (
        <TopupModal initialAmount={topupAmount || undefined} onClose={() => setTopupAmount(null)} />
      )}
      {reconcileOpen && (
        <SepayReconcileModal initialDate={day ?? today} onClose={() => setReconcileOpen(false)} />
      )}
    </div>
  );
}

/** "2026-08-26" ± n ngày, vẫn theo lịch (không lệch vì múi giờ). */
function shiftDay(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const CHANNEL_CHIPS: { label: string; value: TxnChannel | null }[] = [
  { label: "Tất cả", value: null },
  { label: "Trừ số dư ví", value: "wallet" },
  { label: "Thanh toán trực tiếp", value: "invoice" },
  { label: "Tiền vào", value: "in" },
];

/* ── Hai thẻ chốt số của NGÀY ──────────────────────────────────────────────── */

/**
 * Chốt số trong NGÀY: mời được bao nhiêu email và tiêu/nạp bao nhiêu tiền. Lịch sử
 * bên dưới kể từng lượt, hai thẻ này chốt tổng — đi kèm nhau và dùng CHUNG ngày
 * đang chọn ở thanh lịch sử.
 *
 * Thẻ "Mời" đọc LỜI MỜI TÍNH PHÍ: thành công / tổng. Đơn vị là EMAIL — dán 5 email
 * trong một lần bấm vẫn là 5 lời mời, không phải 1 (user 2026-08-27). Trước đây nó
 * lấy `emails_added`, mà mời lại email CÒN HẠN thì miễn phí nhưng vẫn đẩy
 * `last_invited_at` sang ngày mới nên bị đếm như email mới thêm.
 */
function DaySummary({ date, isToday }: { date: string; isToday: boolean }) {
  const { data, isLoading } = useWalletDailySummary(date);
  const suffix = isToday ? "HÔM NAY" : `NGÀY ${vnDateLabel(date)}`;

  // "Thành công" = lời mời tính phí KHÔNG bị hoàn. Lượt hỏng luôn được hoàn ngay nên
  // hiệu số này là số lời mời thật sự vào được team.
  const total = data?.invite_count ?? 0;
  const ok = total - (data?.refunded_invite_count ?? 0);
  const spent = data?.fee_net ?? 0;
  const viaInvoice = data?.fee_from_invoice ?? 0;
  const viaWallet = data?.fee_from_balance ?? 0;
  const second = data ? secondInviteLine(data) : null;

  return (
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, alignItems: "stretch" }}>
      <div style={{ ...card, display: "flex", flexDirection: "column" }}>
        <div style={cardKicker}>MỜI {suffix}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, height: 46 }}>
          <div style={bigNumber}>{isLoading ? "…" : ok}</div>
          <div style={{ fontSize: 14, color: "var(--ink-3)" }}>
            {total > 0 ? `/ ${total} lời mời` : "lời mời tính phí"}
          </div>
        </div>
        <div style={legendList}>
          <LegendRow swatch="var(--ink-4)" label="Mời thành công" value={String(ok)} />
          {second && <LegendDivider />}
          {second}
        </div>
        <div style={{ marginTop: "auto", paddingTop: 20, minHeight: 52, display: "flex", alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
          Mỗi email là một lời mời, kể cả khi gửi chung một lần. Mời lại email còn hạn
          không tính phí nên không nằm ở đây; lời mời lỗi được hoàn phí lập tức.
        </div>
      </div>

      <div style={{ ...card, display: "flex", flexDirection: "column" }}>
        <div style={cardKicker}>ĐÃ TIÊU {suffix}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, height: 46 }}>
          <div style={{ ...bigNumber, color: spent > 0 ? "var(--danger)" : "var(--ink)" }}>
            {isLoading ? "…" : bigVnd(spent)}
          </div>
          <div style={{ fontSize: 18, color: "var(--ink-4)" }}>đ</div>
        </div>
        <div style={legendList}>
          <LegendRow swatch="var(--ink)" label="Thanh toán trực tiếp" value={formatVnd(viaInvoice)} />
          <LegendDivider />
          <LegendRow swatch="var(--warning-accent)" label="Trừ ví" value={formatVnd(viaWallet)} />
        </div>
        <div style={{ marginTop: "auto", paddingTop: 20, minHeight: 52, display: "flex", alignItems: "center" }}>
          {spent > 0 ? (
            <div style={{ display: "flex", width: "100%", height: 8, gap: 2 }}>
              {viaInvoice > 0 && <div style={{ flex: viaInvoice, background: "var(--ink)", borderRadius: 20 }} />}
              {viaWallet > 0 && <div style={{ flex: viaWallet, background: "var(--warning-accent)", borderRadius: 20 }} />}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Chưa tiêu đồng nào trong ngày này.</div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Dòng phụ thứ hai của thẻ "Mời": ưu tiên nói chuyện TIỀN (lượt hỏng đã hoàn), rồi
 * mới tới email rời team / lượt gia hạn. Chỉ một dòng để hai thẻ luôn cao bằng nhau.
 */
function secondInviteLine(d: WalletDailySummary): React.ReactElement | null {
  if (d.refunded_invite_count > 0) {
    return (
      <LegendRow
        swatch="var(--success)"
        label={`Đã hoàn (${d.refunded_invite_count})`}
        value={`+${formatVnd(d.refund_total)}`}
        tone="var(--success)"
      />
    );
  }
  if (d.emails_removed > 0) {
    return <LegendRow swatch="var(--danger)" label="Đã rời team" value={String(d.emails_removed)} />;
  }
  if (d.renew_count > 0) {
    return <LegendRow swatch="var(--ink-4)" label="Lượt gia hạn" value={String(d.renew_count)} />;
  }
  // Không có gì đáng nói thêm thì bỏ hẳn dòng — đừng bịa ra "Lượt hỏng: 0" cho đủ
  // chỗ. Hai thẻ vẫn cao bằng nhau vì phần chân thẻ đẩy xuống bằng `margin-top:auto`.
  return null;
}

function LegendRow({ swatch, label, value, tone }: { swatch: string; label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 18, overflow: "hidden" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: swatch }} />
      <span style={{ color: "var(--ink-2)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ marginLeft: "auto", flexShrink: 0, fontWeight: 700, color: tone ?? "var(--ink)" }}>{value}</span>
    </div>
  );
}

function LegendDivider() {
  return <div style={{ height: 1, background: "var(--border)" }} />;
}

/* ── Lịch sử theo ngày ─────────────────────────────────────────────────────── */

function TxnGroups({ groups, limit, onMore, canMore, loadingMore, day, trace, hidden, onShowHidden, serverTotals }: { groups: DayGroup[]; limit: number; onMore: () => void; canMore: boolean; loadingMore: boolean; day: string | null; trace: RefundTrace; hidden: { voided: number; settled: number }; onShowHidden: () => void; serverTotals: boolean }) {
  const today = vnToday();
  let budget = limit;
  const visible: DayGroup[] = [];
  for (const g of groups) {
    if (budget <= 0) break;
    visible.push(budget >= g.rows.length ? g : { ...g, rows: g.rows.slice(0, budget) });
    budget -= g.rows.length;
  }
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  if (groups.length === 0) {
    // Rỗng vì CÔNG TẮC đang giấu hết, không phải vì không có gì: nói thẳng đang ẩn
    // cái gì và cho bấm hiện ngay tại chỗ — câu "không có giao dịch" ở đây làm user
    // tưởng dữ liệu bay mất (user 2026-08-27).
    const label = hiddenLabel(hidden.voided, hidden.settled);
    return (
      <div style={{ padding: "34px 20px", textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
        {label ? (
          <>
            <div>
              {day
                ? `Ngày ${vnDateLabel(day)} chỉ có ${label} — đang ẩn.`
                : `Chỉ có ${label} — đang ẩn.`}
            </div>
            <button onClick={onShowHidden} style={{ ...secondaryBtn, marginTop: 12 }}>
              Hiện {label}
            </button>
          </>
        ) : day ? (
          `Không có giao dịch trong ngày ${vnDateLabel(day)}.`
        ) : (
          "Chưa có giao dịch nào."
        )}
      </div>
    );
  }

  return (
    <>
      {visible.map((g) => (
        <div key={g.date}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "10px 20px", background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".08em", color: "var(--ink-2)" }}>
              {g.date === today ? `HÔM NAY · ${vnDateLabel(g.date)}` : vnDateLabel(g.date)}
            </span>
            {/* Màn hẹp: cho các con số xuống dòng chứ không để nguyên một dải nowrap
                rồi bị thẻ (overflow hidden) cắt cụt mất ô cuối. */}
            <DayHeaderStats group={g} fromServer={serverTotals} />
          </div>
          {g.rows.map((r) => <HistoryRow key={rowKey(r)} row={r} trace={trace} />)}
        </div>
      ))}
      {(total > limit || canMore) && (
        <div style={{ padding: "14px 20px", display: "flex", justifyContent: "center" }}>
          <button onClick={onMore} disabled={loadingMore} style={{ ...secondaryBtn, opacity: loadingMore ? 0.6 : 1 }}>
            {loadingMore ? "Đang tải…" : "Xem thêm giao dịch cũ hơn"}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Chốt số của DÒNG TIÊU ĐỀ NGÀY — đọc thẳng số của SERVER thay vì cộng dồn mấy
 * dòng đang tải. Lịch sử phân trang 100 bút toán một lần, nên ngày đông lượt thì
 * cộng tại chỗ chỉ ra một phần: thẻ trên báo 67 lời mời mà tiêu đề ngày ghi
 * "New 45 · Chi 14.850.000" (user 2026-08-28).
 *
 * `fromServer=false` khi đang lọc theo kênh tiền (chip "Trừ số dư ví"…): lúc đó
 * số của cả ngày KHÔNG khớp với danh sách đã lọc, nên vẫn cộng tại chỗ.
 * Chưa có số server (đang tải, mất mạng) cũng rơi về số cộng tại chỗ.
 */
function DayHeaderStats({ group, fromServer }: { group: DayGroup; fromServer: boolean }) {
  const { data } = useWalletDailySummary(fromServer ? group.date : "");
  const d = fromServer ? data : undefined;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--ink-2)" }}>
      <DayStat label="Nạp" value={formatVnd(d ? d.topup_total : group.topup)} />
      <span style={{ width: 1, height: 11, background: "var(--border-strong)" }} />
      <DayStat label="Chi" value={formatVnd(d ? d.fee_net : group.spend)} />
      <span style={{ width: 1, height: 11, background: "var(--border-strong)" }} />
      <DayStat label="New" value={String(d ? d.new_email_count : group.newSeats)} />
      <span style={{ width: 1, height: 11, background: "var(--border-strong)" }} />
      <DayStat label="Renew" value={String(d ? d.renew_email_count : group.renewSeats)} />
    </span>
  );
}

function DayStat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--ink-3)" }}>{label}</span>
      <strong style={{ fontWeight: 700, color: "var(--ink)" }}>{value}</strong>
    </span>
  );
}

function rowKey(r: TxnRow): string {
  if (r.type === "withdraw") return `w${r.id}`;
  if (r.type === "voided") return `v${r.key}`;
  return `g${r.key}:${r.txns[0].id}`;
}

/** Bộ mặt của một dòng: icon tròn bên trái + nhãn kênh tiền bên cạnh tiêu đề. */
type RowFace = { icon: string; iconBg: string; iconFg: string; tag: string; tagBg: string; tagFg: string };

const FACE: Record<string, RowFace> = {
  wallet: { icon: "↓", iconBg: "var(--warning-bg)", iconFg: "var(--warning)", tag: "Trừ số dư ví", tagBg: "var(--warning-bg)", tagFg: "var(--warning)" },
  invoice: { icon: "≡", iconBg: "var(--surface-2)", iconFg: "var(--ink-2)", tag: "Thanh toán trực tiếp", tagBg: "var(--surface-2)", tagFg: "var(--ink-2)" },
  refund: { icon: "↺", iconBg: "var(--success-bg)", iconFg: "var(--success)", tag: "Hoàn phí", tagBg: "var(--success-bg)", tagFg: "var(--success)" },
  topup: { icon: "+", iconBg: "var(--ink)", iconFg: "var(--surface)", tag: "Nạp tiền", tagBg: "var(--surface-2)", tagFg: "var(--ink-2)" },
  voided: { icon: "×", iconBg: "var(--danger-bg)", iconFg: "var(--danger)", tag: "Lỗi mời", tagBg: "var(--danger-bg)", tagFg: "var(--danger)" },
  withdraw: { icon: "↑", iconBg: "var(--surface-2)", iconFg: "var(--ink-2)", tag: "Rút tiền", tagBg: "var(--surface-2)", tagFg: "var(--ink-2)" },
  adjust: { icon: "±", iconBg: "var(--info-bg)", iconFg: "var(--info)", tag: "Điều chỉnh", tagBg: "var(--info-bg)", tagFg: "var(--info)" },
};

function HistoryRow({ row, trace }: { row: TxnRow; trace: RefundTrace }) {
  if (row.type === "withdraw") return <WithdrawRow txns={row.txns} />;
  if (row.type === "voided") return <VoidedRow pairs={row.pairs} />;

  const fees = row.txns.filter((t) => t.kind === "invite_fee" || t.kind === "renew_fee");
  if (fees.length > 0) return <FeeRow row={row} fees={fees} funding={trace.funding.get(row)} />;

  // Tiền hoàn còn nằm trong ví (hoá đơn của lượt hỏng, hoặc bút toán hoàn lẻ) —
  // dòng riêng, nói rõ đã bị lượt mời sau tiêu tới đâu.
  const usage = trace.usage.get(row);
  if (usage) return <RefundCreditRow row={row} usage={usage} />;

  // Còn lại: từng bút toán một dòng (nạp, điều chỉnh…).
  return (
    <>
      {row.txns.map((t) => <SingleRow key={t.id} t={t} stranded={0} />)}
    </>
  );
}

/** Nhãn công tắc: gộp "lượt mời hỏng" và "khoản hoàn đã tiêu hết" cho gọn. */
function hiddenLabel(voided: number, settled: number): string {
  const parts: string[] = [];
  if (voided > 0) parts.push(`${voided} lượt lỗi mời`);
  if (settled > 0) parts.push(`${settled} khoản hoàn đã dùng hết`);
  return parts.join(" & ");
}

/**
 * TIỀN HOÀN còn trong ví: lượt mời trả thẳng qua hoá đơn QR nhưng hỏng ⇒ tiền đã
 * vào ví rồi ở lại. Trước đây dòng này ghi "Nạp qua hoá đơn" — nghe như nạp mới,
 * trong khi bản chất là hoàn (user 2026-08-26). Ăn hết bởi lượt mời sau ⇒ triệt
 * tiêu, mặc định ẩn.
 */
function RefundCreditRow({ row, usage }: { row: Extract<TxnRow, { type: "group" }>; usage: { used: number; total: number; emails: string[] } }) {
  const [open, setOpen] = useState(false);
  const left = usage.total - usage.used;
  const t = row.txns[0];
  const who = usage.emails.length === 1 ? usage.emails[0] : `${usage.emails.length} email lỗi mời`;
  return (
    <RowShell
      face={FACE.refund}
      title={`Hoàn tiền lỗi mời · ${usage.emails.length} email`}
      meta={`Hoàn từ ${who} · đã trả qua QR nhưng lỗi mời nên tiền ở lại trong ví`}
      note={
        left <= 0
          ? `Đã dùng hết cho lượt mời sau — khoản này triệt tiêu, không phải tiền mới.`
          : usage.used > 0
            ? `Đã dùng ${formatVnd(usage.used)}, còn ${formatVnd(left)} chưa tiêu.`
            : `Chưa lượt mời nào tiêu tới — ${formatVnd(left)} đang chờ trong ví.`
      }
      at={stamp(t.created_at)}
      amount={`+${formatVnd(usage.total)}`}
      amountFg={left <= 0 ? "var(--ink-3)" : "var(--success)"}
      balance={`Ví còn ${formatVnd(t.balance_after)}`}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      detail={
        <EmailList
          items={usage.emails.map((e, i) => ({
            key: `${e}-${i}`,
            email: e,
            amount: `hoàn ${formatVnd(usage.total / usage.emails.length)}`,
            tone: "var(--success)",
          }))}
        />
      }
    />
  );
}

/** Khung chung của mọi dòng — icon | nội dung | số tiền + số dư. */
function RowShell({
  face,
  title,
  meta,
  note,
  at,
  amount,
  amountFg,
  balance,
  detail,
  onToggle,
  open,
  extra,
}: {
  face: RowFace;
  title: string;
  meta: string;
  note?: string;
  at: string;
  amount: string;
  amountFg: string;
  balance: string;
  detail?: React.ReactNode;
  onToggle?: () => void;
  open?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "grid",
        gridTemplateColumns: "34px 1fr auto",
        gap: 14,
        padding: "13px 20px",
        borderBottom: "1px solid var(--border)",
        alignItems: "start",
        cursor: onToggle ? "pointer" : "default",
      }}
    >
      <div style={{ width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", fontSize: 15, fontWeight: 700, background: face.iconBg, color: face.iconFg }}>
        {face.icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>
            {title}
            {onToggle && (
              <span style={{ color: "var(--ink-3)", fontSize: 11, marginLeft: 6, display: "inline-block", transform: open ? "rotate(180deg)" : "none" }}>▾</span>
            )}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: face.tagBg, color: face.tagFg, whiteSpace: "nowrap" }}>
            {face.tag}
          </span>
        </div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--ink-2)" }}>{meta}</div>
        {note && <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--ink-2)", overflowWrap: "anywhere" }}>{note}</div>}
        <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{at}</div>
        {extra}
        {open && detail}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-.01em", color: amountFg, whiteSpace: "nowrap" }}>{amount}</div>
        <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{balance}</div>
      </div>
    </div>
  );
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("vi-VN");
}

/** Danh sách email bung ra khi bấm vào dòng. */
function EmailList({ items }: { items: { key: string; email: string; amount: string; tone?: string }[] }) {
  return (
    <div style={{ marginTop: 10, borderLeft: "2px solid var(--border)", paddingLeft: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((e) => (
        <div key={e.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-2)" }}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{e.email}</span>
          <span style={{ color: e.tone ?? "var(--danger)", flexShrink: 0 }}>{e.amount}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Một THAO TÁC mời/gia hạn (nhiều bút toán cùng `created_at`) gộp thành 1 DÒNG —
 * thay vì hiện "Nạp qua hoá đơn +X" rồi "Phí mời −X" ngược dấu rối mắt. Bấm để bung
 * chi tiết từng email.
 */
function FeeRow({ row, fees, funding }: { row: Extract<TxnRow, { type: "group" }>; fees: WalletTxn[]; funding?: RefundSource[] }) {
  const [open, setOpen] = useState(false);
  const viaInvoice = row.txns.some((t) => t.kind === "order_topup");
  const isRenew = fees.every((t) => t.kind === "renew_fee");
  const spend = fees.reduce((s, t) => s + t.amount, 0); // âm
  const finalBalance = Math.min(...row.txns.map((t) => t.balance_after));
  const notes = [
    row.voidedCount > 0
      ? `Cùng lượt này có ${row.voidedCount} email lỗi mời, đã hoàn phí (không tính vào số bên phải).`
      : null,
    funding ? fundingNote(funding) : null,
  ].filter(Boolean);
  return (
    <RowShell
      face={viaInvoice ? FACE.invoice : FACE.wallet}
      title={`${isRenew ? "Gia hạn thành viên" : "Mời thành viên"} · ${fees.length} email`}
      meta={viaInvoice ? "Thanh toán trực tiếp qua QR · số dư ví không đổi" : "Trừ trực tiếp từ số dư ví"}
      note={notes.length > 0 ? notes.join(" ") : undefined}
      at={stamp(fees[0].created_at)}
      amount={formatVnd(spend)}
      amountFg="var(--danger)"
      balance={viaInvoice ? "Ví không đổi" : `Ví còn ${formatVnd(finalBalance)}`}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      detail={
        <>
          <EmailList
            items={fees.map((t) => ({
              key: t.id,
              email: t.meta?.email ? String(t.meta.email) : t.kind,
              amount: formatVnd(t.amount),
            }))}
          />
          {funding && (
            <div style={{ marginTop: 10, borderLeft: "2px solid var(--success-border)", paddingLeft: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Tiền lấy từ các khoản hoàn:</div>
              {funding.map((f) => (
                <div key={f.email} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-2)" }}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{f.email}</span>
                  <span style={{ color: "var(--success)", flexShrink: 0 }}>{formatVnd(f.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      }
    />
  );
}

/** Chú thích nhỏ trên dòng phí: tiền này lấy từ khoản hoàn của email nào. */
function fundingNote(funding: RefundSource[]): string {
  const total = funding.reduce((s, f) => s + f.amount, 0);
  if (funding.length === 1) {
    return `Dùng tiền hoàn từ email ${funding[0].email} (${formatVnd(total)}).`;
  }
  return `Dùng tiền hoàn từ ${funding.length} email lỗi mời trước đó (${formatVnd(total)}).`;
}

/**
 * Các lượt MỜI HỎNG cùng một lúc: phí đã trừ rồi hoàn lại đủ ⇒ thực chi 0 đ. Gộp cả
 * cặp phí ↔ hoàn vào 1 dòng, đặt đúng chỗ lượt mời trong dòng thời gian, thay vì để
 * "Phí mời −X" ở một chỗ và "Hoàn phí mời +X" ở chỗ khác.
 */
function VoidedRow({ pairs }: { pairs: VoidedPair[] }) {
  const [open, setOpen] = useState(false);
  const fee = pairs.reduce((s, p) => s - p.fee.amount, 0); // tổng phí đã trừ (dương)
  return (
    <RowShell
      face={FACE.voided}
      title={`Lỗi mời · ${pairs.length} email`}
      meta={`Đã trừ ${formatVnd(fee)} rồi hoàn lại đủ · không mất tiền`}
      at={stamp(pairs[0].fee.created_at)}
      amount="0 ₫"
      amountFg="var(--ink-3)"
      balance="Ví không đổi"
      open={open}
      onToggle={() => setOpen((v) => !v)}
      detail={
        <EmailList
          items={pairs.map((p) => ({
            key: p.fee.id,
            email: p.fee.meta?.email ? String(p.fee.meta.email) : "(không rõ email)",
            amount: `hoàn ${stamp(p.refund.created_at)}`,
            tone: "var(--ink-3)",
          }))}
        />
      }
    />
  );
}

/* Nguồn phát sinh khoản tiền, dạng "<TIỀN ĐI ĐÂU> · <vì sao>" — user 2026-08-16:
   "Tự động · trừ khi mời thành viên" không cho biết tiền bị trừ ở đâu ra. */
const SINGLE_META: Partial<Record<WalletTxn["kind"], string>> = {
  topup: "Chuyển khoản ngân hàng · đã xác nhận",
  order_topup: "Tiền hoá đơn đã vào ví",
  invite_fee: "Trừ trực tiếp từ số dư ví",
  renew_fee: "Trừ trực tiếp từ số dư ví · gia hạn thành viên",
  invite_refund: "Tự động hoàn lập tức về số dư ví",
  adjust: "Sửa thẳng số dư ví · quản trị điều chỉnh tay",
};

const SINGLE_FACE: Partial<Record<WalletTxn["kind"], RowFace>> = {
  topup: FACE.topup,
  order_topup: FACE.invoice,
  invite_fee: FACE.wallet,
  renew_fee: FACE.wallet,
  invite_refund: FACE.refund,
  adjust: FACE.adjust,
};

/** Một bút toán lẻ (nạp/hoàn/điều chỉnh…) — không thuộc thao tác mời nào. */
function SingleRow({ t, stranded }: { t: WalletTxn; stranded: number }) {
  // Thanh toán TRÙNG hoá đơn: khoản này ghi là `topup` kèm cờ meta.duplicate_invoice.
  // Nói riêng để user biết tiền đã vào ví (không phải nạp thường, không bị mất) —
  // xem sepay_integration.handle_order.
  const isDupInvoice = t.kind === "topup" && Boolean(t.meta?.duplicate_invoice);
  const dupRef = isDupInvoice && t.meta?.order_ref ? String(t.meta.order_ref) : null;
  const title = isDupInvoice
    ? "Hoàn trả tiền thanh toán trùng hoá đơn"
    : t.kind === "topup"
      ? "Nạp tiền vào ví"
      : t.kind === "invite_refund"
        ? "Hoàn phí lỗi mời"
        : (TXN_KIND_LABEL[t.kind] ?? t.kind);
  const reason = t.meta?.reason ? String(t.meta.reason) : null;
  const email = t.meta?.email ? String(t.meta.email) : null;
  // Cả lượt mời hỏng hết, chỉ còn bút toán hoá đơn: tiền đã vào ví rồi Ở LẠI đó
  // (phí hoàn về) — nói thẳng, đừng để trơ dòng "+X" không đầu không cuối.
  const strandedNote =
    t.kind === "order_topup" && stranded > 0
      ? `Lượt mời cùng lúc bị lỗi, phí đã hoàn — ${formatVnd(stranded)} ở lại trong ví.`
      : null;
  const notes = [
    isDupInvoice && dupRef ? `Hoá đơn ${dupRef}. Số tiền đã được cộng vào ví.` : null,
    strandedNote,
    email ? `Thành viên: ${email}` : null,
    reason ? `Lý do: ${reason}` : null,
  ].filter(Boolean);
  return (
    <RowShell
      face={SINGLE_FACE[t.kind] ?? FACE.adjust}
      title={title}
      meta={SINGLE_META[t.kind] ?? "Bút toán ví"}
      note={notes.length > 0 ? notes.join(" · ") : undefined}
      at={stamp(t.created_at)}
      amount={`${t.amount >= 0 ? "+" : ""}${formatVnd(t.amount)}`}
      amountFg={t.amount >= 0 ? "var(--success)" : "var(--danger)"}
      balance={`Ví còn ${formatVnd(t.balance_after)}`}
    />
  );
}

/**
 * Một yêu cầu rút gộp thành 1 DÒNG duy nhất (dù sinh nhiều bút toán
 * withdraw_hold/settle/refund) — kèm thanh tiến trình 3 bước.
 */
function WithdrawRow({ txns }: { txns: WalletTxn[] }) {
  const hold = txns.find((t) => t.kind === "withdraw_hold");
  const settled = txns.some((t) => t.kind === "withdraw_settle");
  const rejected = txns.some((t) => t.kind === "withdraw_refund") && !settled;
  const latest = txns[0]; // API trả mới→cũ, txns[0] là bút toán gần nhất
  const amountVnd = Math.abs(hold?.amount ?? latest.amount);
  return (
    <RowShell
      face={FACE.withdraw}
      title="Rút tiền"
      meta={rejected ? "Bị từ chối · số dư đã trả lại ví" : settled ? "Đã chi về tài khoản ngân hàng" : "Đang giữ số dư, chờ super-admin duyệt"}
      at={stamp((hold ?? latest).created_at)}
      amount={`-${formatVnd(amountVnd)}`}
      amountFg={rejected ? "var(--ink-3)" : "var(--danger)"}
      balance={`Ví còn ${formatVnd(latest.balance_after)}`}
      extra={<WithdrawSteps settled={settled} rejected={rejected} />}
    />
  );
}

/** Thanh tiến trình rút tiền: Đã gửi yêu cầu → Chờ admin thanh toán → Thành công. */
function WithdrawSteps({ settled, rejected }: { settled: boolean; rejected: boolean }) {
  const steps = [
    { label: "Đã gửi yêu cầu", reached: true, kind: "n" as const },
    { label: "Chờ admin thanh toán", reached: true, kind: settled || rejected ? ("n" as const) : ("cur" as const) },
    rejected
      ? { label: "Bị từ chối", reached: true, kind: "fail" as const }
      : { label: "Thành công", reached: settled, kind: "done" as const },
  ];
  const color = (s: (typeof steps)[number]) => {
    if (!s.reached) return "var(--ink-4)";
    if (s.kind === "fail") return "var(--danger)";
    if (s.kind === "done") return "var(--success)";
    if (s.kind === "cur") return "var(--warning)";
    return "var(--ink-2)";
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
      {steps.map((s, i) => (
        <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, opacity: s.reached ? 1 : 0.65 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: s.reached ? color(s) : "transparent",
                border: s.reached ? "none" : "1.5px solid var(--ink-4)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 11, fontWeight: s.reached ? 600 : 500, color: s.reached ? color(s) : "var(--ink-3)", whiteSpace: "nowrap" }}>
              {s.label}
            </span>
          </span>
          {i < steps.length - 1 && (
            <span style={{ width: 18, height: 2, borderRadius: 2, background: steps[i + 1].reached ? "var(--border-strong)" : "var(--border)" }} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Cột phải: số dư + nạp/rút ─────────────────────────────────────────────── */

/**
 * Số dư và hai việc làm với nó (nạp / rút) gộp vào MỘT thẻ có tab — trước đây là hai
 * thẻ rời nhau, thẻ số dư chỉ có mỗi nút "+ Nạp tiền" nên chiếm chỗ mà không nói
 * thêm được gì.
 */
function BalancePanel({
  balance,
  held,
  fee,
  isLoading,
  onTopup,
}: {
  balance: number;
  held: number;
  fee: number;
  isLoading: boolean;
  onTopup: (amount: number) => void;
}) {
  const [tab, setTab] = useState<"topup" | "withdraw">("topup");
  const [amountText, setAmountText] = useState("");
  const amount = parseVnd(amountText);
  const seats = fee > 0 ? Math.floor(balance / fee) : null;

  return (
    <div style={{ ...card, padding: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, padding: "14px 12px 12px" }}>
        <div>
          <div style={cardKicker}>SỐ DƯ VÍ</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 5 }}>
            <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1, color: "var(--ink)" }}>
              {isLoading ? "…" : bigVnd(balance)}
            </span>
            <span style={{ fontSize: 14, color: "var(--ink-3)" }}>đ</span>
          </div>
          {held > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4 }}>Đang giữ (chờ rút): {formatVnd(held)}</div>
          )}
        </div>
        {seats !== null && (
          <span style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap" }}>đủ {seats} lượt</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", borderRadius: 10, padding: 4 }}>
        <button onClick={() => setTab("topup")} style={{ ...panelTab, ...(tab === "topup" ? panelTabOn : null) }}>Nạp tiền</button>
        <button onClick={() => setTab("withdraw")} style={{ ...panelTab, ...(tab === "withdraw" ? panelTabOn : null) }}>Rút tiền</button>
      </div>

      {tab === "topup" ? (
        <TopupForm
          balance={balance}
          fee={fee}
          amountText={amountText}
          amount={amount}
          onAmountText={setAmountText}
          onSubmit={() => onTopup(amount)}
        />
      ) : (
        <WithdrawForm
          available={balance}
          amountText={amountText}
          amount={amount}
          onAmountText={setAmountText}
        />
      )}
    </div>
  );
}

function TopupForm({
  balance,
  fee,
  amountText,
  amount,
  onAmountText,
  onSubmit,
}: {
  balance: number;
  fee: number;
  amountText: string;
  amount: number;
  onAmountText: (v: string) => void;
  onSubmit: () => void;
}) {
  // Gợi ý theo PHÍ MỜI (10/30/100 lượt) chứ không phải con số tròn cố định — nạp
  // xong là biết ngay mời được bao nhiêu người.
  const picks = fee > 0 ? [fee * 10, fee * 30, fee * 100] : [500_000, 1_000_000, 3_000_000];
  const after = balance + amount;
  const seatsAfter = fee > 0 ? Math.floor(after / fee) : null;
  return (
    <div style={{ padding: "20px 14px 14px" }}>
      <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 14, lineHeight: 1.5 }}>
        Nạp thêm để phí mời được trừ từ ví thay vì phải thanh toán trực tiếp mỗi lần.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <input
          value={amount ? amount.toLocaleString("vi-VN") : amountText}
          onChange={(e) => onAmountText(e.target.value)}
          inputMode="numeric"
          placeholder="Số tiền"
          style={input}
        />
        <div style={{ display: "flex", gap: 6 }}>
          {picks.map((p) => (
            <button key={p} onClick={() => onAmountText(String(p))} style={pickBtn}>{shortVnd(p)}</button>
          ))}
        </div>
        <div style={previewLine}>
          {amount > 0
            ? `Sau khi nạp: ${formatVnd(after)}${seatsAfter !== null ? ` · đủ ${seatsAfter} lượt mời` : ""}`
            : `Số dư hiện tại ${formatVnd(balance)}${fee > 0 ? ` · đủ ${Math.floor(balance / fee)} lượt mời` : ""}`}
        </div>
        <button onClick={onSubmit} style={{ ...primaryBtn, width: "100%", padding: 13 }}>Tiếp tục nạp tiền</button>
      </div>
    </div>
  );
}

function WithdrawForm({
  available,
  amountText,
  amount,
  onAmountText,
}: {
  available: number;
  amountText: string;
  amount: number;
  onAmountText: (v: string) => void;
}) {
  const { user } = useAuth();
  const savedCfg = loadWithdrawConfig(user?.id);
  const [bank, setBank] = useState(savedCfg?.bank_account ?? "");
  const createWithdrawal = useCreateWithdrawal();

  const [showSettings, setShowSettings] = useState(false);
  const [cfgBank, setCfgBank] = useState(savedCfg?.bank_account ?? "");
  const [cfgAmount, setCfgAmount] = useState<number>(savedCfg?.default_amount ?? 0);

  function saveSettings() {
    if (!user?.id) return;
    const cfg: WithdrawConfig = { bank_account: cfgBank.trim(), default_amount: cfgAmount > 0 ? cfgAmount : 0 };
    saveWithdrawConfig(user.id, cfg);
    // Áp cấu hình vào form ngay để dùng lần rút này luôn.
    setBank(cfg.bank_account);
    if (cfg.default_amount > 0) onAmountText(String(cfg.default_amount));
    setShowSettings(false);
    toast.success("Đã lưu cấu hình rút tiền.");
  }

  async function submit() {
    if (amount <= 0 || bank.trim().length < 3) {
      toast.error("Nhập số tiền và số tài khoản ngân hàng nhận.");
      return;
    }
    try {
      await createWithdrawal.mutateAsync({ amount_vnd: amount, bank_account: bank.trim() });
      toast.success("Đã gửi yêu cầu rút. Chờ super-admin duyệt.");
      onAmountText("");
      setBank("");
    } catch (e) {
      const detail = e instanceof ApiError ? (e.detail as { message?: string; shortfall?: number }) : null;
      toast.error(detail?.message ?? "Không gửi được yêu cầu rút");
    }
  }

  return (
    <div style={{ padding: "20px 14px 14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Yêu cầu rút sẽ giữ số dư tương ứng cho tới khi super-admin duyệt.
        </div>
        <button onClick={() => setShowSettings((s) => !s)} style={{ ...linkBtn, ...(showSettings ? { color: "var(--ink)" } : null) }}>
          Cài đặt
        </button>
      </div>

      {showSettings && (
        <div style={settingsPanel}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>Cấu hình rút tiền</div>
          <p style={{ fontSize: 12, lineHeight: 1.5, color: "var(--ink-3)", margin: "4px 0 10px" }}>
            Lưu STK và số tiền mặc định để tự điền sẵn cho những lần rút sau.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input placeholder="Ngân hàng · STK · Chủ TK" value={cfgBank} onChange={(e) => setCfgBank(e.target.value)} style={input} />
            <input
              type="number"
              placeholder="Số tiền mặc định (tuỳ chọn)"
              value={cfgAmount || ""}
              onChange={(e) => setCfgAmount(Number(e.target.value))}
              style={input}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <button onClick={() => setShowSettings(false)} style={{ ...secondaryBtn, flex: 1 }}>Huỷ</button>
              <button onClick={saveSettings} style={{ ...primaryBtn, flex: 1 }}>Lưu</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <input
          value={amount ? amount.toLocaleString("vi-VN") : amountText}
          onChange={(e) => onAmountText(e.target.value)}
          inputMode="numeric"
          placeholder="Số tiền"
          style={input}
        />
        <input placeholder="Ngân hàng · STK · Chủ TK" value={bank} onChange={(e) => setBank(e.target.value)} style={input} />
        <div style={previewLine}>
          {amount > available
            ? `Vượt quá số dư khả dụng ${formatVnd(available)}.`
            : `Khả dụng ${formatVnd(available)}${amount > 0 ? ` · còn lại ${formatVnd(available - amount)}` : ""}`}
        </div>
        <button onClick={submit} disabled={createWithdrawal.isPending} style={{ ...primaryBtn, width: "100%", padding: 13 }}>
          {createWithdrawal.isPending ? "Đang gửi…" : "Gửi yêu cầu rút"}
        </button>
      </div>
    </div>
  );
}

/** Bảng giải thích 3 đường đi của tiền — khớp màu với chip lọc và thanh tỉ lệ ở trên. */
function FeeLegend() {
  return (
    <div style={{ ...card, padding: 18 }}>
      <div style={{ ...cardKicker, marginBottom: 14 }}>CÁCH TÍNH PHÍ</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--warning-accent)", marginTop: 5, flexShrink: 0 }} />
          <span><strong style={{ color: "var(--ink)" }}>Trừ số dư ví</strong> — mặc định khi ví còn tiền. Trừ ngay lúc mời.</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--ink)", marginTop: 5, flexShrink: 0 }} />
          <span><strong style={{ color: "var(--ink)" }}>Thanh toán trực tiếp</strong> — khi ví hết tiền. Sẽ sinh QR tự động để thanh toán.</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--success)", marginTop: 5, flexShrink: 0 }} />
          <span><strong style={{ color: "var(--ink)" }}>Hoàn phí</strong> — lời mời lỗi sẽ tự động hoàn lập tức về ví.</span>
        </div>
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 20, boxShadow: "var(--shadow-card)", minWidth: 0 };
const cardKicker: React.CSSProperties = { fontSize: 10, letterSpacing: ".12em", color: "var(--ink-3)", fontFamily: "var(--font-mono)", textTransform: "uppercase", height: 24 };
const cardTitle: React.CSSProperties = { fontSize: 17, fontWeight: 700, letterSpacing: "-.02em", color: "var(--ink)", marginBottom: 10 };
const bigNumber: React.CSSProperties = { fontSize: 32, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1, color: "var(--ink)", whiteSpace: "nowrap" };
const legendList: React.CSSProperties = { marginTop: 16, display: "flex", flexDirection: "column", gap: 9, fontSize: 12 };
const input: React.CSSProperties = { width: "100%", padding: "12px 14px", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", fontSize: 14, background: "var(--surface)", color: "var(--ink)" };
const primaryBtn: React.CSSProperties = { padding: "10px 18px", background: "var(--ink)", color: "var(--surface)", border: "none", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0 };
const secondaryBtn: React.CSSProperties = { padding: "10px 16px", background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const linkBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, fontSize: 12.5, fontWeight: 600, color: "var(--ink-3)", cursor: "pointer", flexShrink: 0 };
const chip: React.CSSProperties = { border: "1px solid var(--border-strong)", borderRadius: 20, padding: "6px 13px", fontSize: 12.5, cursor: "pointer", background: "var(--surface)", color: "var(--ink-2)", whiteSpace: "nowrap" };
// Dùng nguyên `border` chứ không chỉ `borderColor`: React cảnh báo khi một style
// vừa có shorthand vừa có thuộc tính con cho cùng giá trị.
const chipOn: React.CSSProperties = { background: "var(--ink)", color: "var(--surface)", border: "1px solid var(--ink)", fontWeight: 600 };
const iconBtn: React.CSSProperties = { width: 32, height: 32, flexShrink: 0, border: "1px solid var(--border-strong)", background: "var(--surface)", borderRadius: 8, fontSize: 14, color: "var(--ink-2)", cursor: "pointer", display: "grid", placeItems: "center" };
const panelTab: React.CSSProperties = { flex: 1, border: "none", borderRadius: 8, padding: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "transparent", color: "var(--ink-3)" };
const panelTabOn: React.CSSProperties = { background: "var(--surface)", color: "var(--ink)", boxShadow: "var(--shadow-sm)" };
const pickBtn: React.CSSProperties = { flex: 1, border: "1px solid var(--border-strong)", background: "var(--surface)", borderRadius: 8, padding: "9px 0", fontSize: 12.5, cursor: "pointer", color: "var(--ink-2)" };
const previewLine: React.CSSProperties = { background: "var(--surface-2)", borderRadius: "var(--radius)", padding: "11px 13px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 };
const settingsPanel: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 12, padding: 14, background: "var(--surface-2)", marginBottom: 12 };
