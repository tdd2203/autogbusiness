/**
 * Lịch sử ví — TOÀN BỘ phần nhìn của trang Ví, tách ra để dùng chung.
 *
 * Vì sao tách: trang Quản trị Ví phải cho super-admin xem ví của tài khoản khác
 * bằng ĐÚNG giao diện mà chủ ví nhìn thấy (thẻ tổng kết ngày, thanh chọn ngày,
 * lịch sử gom theo ngày). Trước đây trang quản trị tự vẽ một danh sách phẳng khác
 * hẳn — vừa xấu vừa lệch số so với trang Ví (user 2026-08-29). Chép lại một bản
 * gần giống thì sớm muộn hai bên trôi khỏi nhau, nên chỉ có MỘT bản ở đây.
 *
 * Khác nhau duy nhất giữa hai nơi là XEM VÍ CỦA AI: `WalletScopeCtx` mang `userId`
 * (null = ví của chính mình) để hook đổi endpoint, phần còn lại giống hệt.
 */
import { createContext, useContext, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWalletDailySummary, useWalletTransactions } from "../hooks/useWallet";
import LoadError from "./LoadError";
import { formatVnd, TXN_KIND_LABEL } from "../lib/wallet";
import type { WalletDailySummary, WalletTxn, WalletTxnAdmin, WalletTxnKind } from "../lib/wallet";
import {
  buildTxnRows,
  closingBalanceByDay,
  countHiddenRows,
  countVoidedInvites,
  groupRowsByDay,
  traceRefundUsage,
} from "../lib/wallet-history";
import type { DayGroup, RefundSource, RefundTrace, TxnChannel, TxnRow } from "../lib/wallet-history";
import {
  bigNumber,
  bigVnd,
  card,
  cardKicker,
  cardTitle,
  chip,
  chipOn,
  iconBtn,
  legendList,
  secondaryBtn,
  shiftDay,
  vnDateLabel,
  vnToday,
} from "./walletUi";

/** Ví đang xem là của AI: null = của chính người đang đăng nhập. */
export const WalletScopeCtx = createContext<string | null>(null);

export const PAGE_ROWS = 25;

const CHANNEL_CHIPS: { label: string; value: TxnChannel | null }[] = [
  { label: "Tất cả", value: null },
  { label: "Trừ số dư ví", value: "wallet" },
  { label: "Thanh toán trực tiếp", value: "invoice" },
  { label: "Tiền vào", value: "in" },
];

/**
 * Toàn bộ trạng thái của khối lịch sử (tải trang, lọc kênh tiền, công tắc ẩn).
 * Trả ra ngoài để trang chứa còn dùng `groups` xuất báo cáo CSV — báo cáo phải khớp
 * đúng những dòng đang hiện.
 */
export function useWalletHistoryState(day: string | null, userId?: string | null) {
  const {
    data: txnPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    // Lỗi phải đi kèm ra ngoài: không có nó thì danh sách hỏng và danh sách rỗng
    // vẽ ra giống hệt nhau (user 2026-08-30).
    error,
    isFetching,
    refetch,
  } = useWalletTransactions(day, userId);
  const items = useMemo(() => (txnPages?.pages ?? []).flatMap((p) => p.items), [txnPages]);
  const [channel, setChannel] = useState<TxnChannel | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [limit, setLimit] = useState(PAGE_ROWS);

  const rows = useMemo(() => buildTxnRows(items), [items]);
  // Chốt số dư cuối ngày lấy từ bút toán THÔ (chưa gom, chưa lọc): dòng mới nhất của
  // ngày có thể là lượt mời hỏng đang bị công tắc giấu, gom xong mới tính là hụt.
  const closing = useMemo(() => closingBalanceByDay(items), [items]);
  const voidedCount = useMemo(() => countVoidedInvites(rows), [rows]);
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

  return {
    items, rows, groups, trace, voidedCount, settled, hiddenHere, closing,
    channel, setChannel, showVoided, setShowVoided, limit, setLimit,
    hasNextPage, isFetchingNextPage, fetchNextPage,
    error, isFetching, refetch,
  };
}

export type WalletHistoryState = ReturnType<typeof useWalletHistoryState>;

/** Thẻ "Lịch sử giao dịch": chip lọc kênh tiền, thanh chọn ngày, danh sách theo ngày. */
export function WalletHistoryCard({
  s,
  day,
  setDay,
}: {
  s: WalletHistoryState;
  day: string | null;
  setDay: (d: string | null) => void;
}) {
  const today = vnToday();
  return (
    <div style={{ ...card, flex: "8 1 420px", minWidth: 0, padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
          <h2 style={{ ...cardTitle, marginBottom: 0 }}>Lịch sử giao dịch</h2>
          {(s.voidedCount > 0 || s.settled.size > 0) && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={s.showVoided}
                onChange={() => s.setShowVoided((v) => !v)}
                style={{ width: 15, height: 15, accentColor: "var(--ink)", cursor: "pointer" }}
              />
              Hiện {hiddenLabel(s.voidedCount, s.settled.size)}
            </label>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CHANNEL_CHIPS.map((c) => (
            <button
              key={c.label}
              onClick={() => { s.setChannel(c.value); s.setLimit(PAGE_ROWS); }}
              style={{ ...chip, ...(s.channel === c.value ? chipOn : null) }}
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
            onChange={(e) => { setDay(e.target.value || null); s.setLimit(PAGE_ROWS); }}
            style={{ width: 20, border: "none", background: "transparent", fontSize: 13, color: "var(--ink-3)", cursor: "pointer", padding: 0 }}
          />
        </label>
        {/* Công tắc, không phải nút một chiều: đang xem "tất cả các ngày" mà bấm lại
            thì về HÔM NAY. Trước đây bấm lần hai không làm gì, muốn quay lại phải
            mở lịch chọn tay giữa một danh sách dài (user 2026-08-27: "khó nhìn"). */}
        <button
          onClick={() => { setDay(day ? null : today); s.setLimit(PAGE_ROWS); }}
          title={day ? "Xem tất cả các ngày" : "Bấm lại để về hôm nay"}
          style={{ ...chip, ...(day ? null : chipOn) }}
        >
          Tất cả
        </button>
      </div>

      <TxnGroups
        groups={s.groups}
        limit={s.limit}
        // Còn dòng đã tải mà chưa hiện → chỉ nới ô hiển thị. Hết sạch → xin server
        // trang CŨ HƠN. Nhờ vậy nút "xem thêm" đi được tới tận bút toán đầu tiên,
        // không dừng ở trang đầu như trước.
        onMore={() => {
          const loaded = s.groups.reduce((n, g) => n + g.rows.length, 0);
          if (s.limit < loaded) s.setLimit((n) => n + PAGE_ROWS);
          else if (s.hasNextPage) { s.setLimit((n) => n + PAGE_ROWS); void s.fetchNextPage(); }
        }}
        canMore={s.hasNextPage}
        loadingMore={s.isFetchingNextPage}
        day={day}
        trace={s.trace}
        hidden={s.showVoided ? { voided: 0, settled: 0 } : s.hiddenHere}
        onShowHidden={() => s.setShowVoided(true)}
        serverTotals={s.channel === null}
        closing={s.closing}
        error={s.error}
        onRetry={() => void s.refetch()}
        retrying={s.isFetching}
      />
    </div>
  );
}

/* ── Hai thẻ chốt số của NGÀY ──────────────────────────────────────────────── */

/**
 * Chốt số trong NGÀY: mời được bao nhiêu email và tiêu/nạp bao nhiêu tiền. Lịch sử
 * bên dưới kể từng lượt, hai thẻ này chốt tổng — đi kèm nhau và dùng CHUNG ngày
 * đang chọn ở thanh lịch sử.
 *
 * Thẻ "Mời" chốt số EMAIL ĐÃ ADD, tách MỚI / GIA HẠN — đại lý đếm bằng email chứ
 * không bằng bút toán (user 2026-08-29). Dán 5 email trong một lần bấm là 5 email;
 * đổi email chỉ là THAY THẾ nên vẫn tính 1, không phải 2.
 *
 * Tổng cố tình là `mới + gia hạn` chứ không phải `emails_added`: mời lại email CÒN
 * HẠN thì miễn phí nhưng vẫn đẩy `last_invited_at` sang ngày mới, cộng vào đây là
 * đếm cả lượt không thêm email nào. Lượt đó có dòng riêng khi phát sinh.
 *
 * Số này KHÔNG bằng số lượt thu tiền: email bị chốt hỏng oan rồi hoàn phí mà thật ra
 * vẫn nằm trong workspace vẫn là email đã add.
 */
export function WalletDaySummary({ date, isToday }: { date: string; isToday: boolean }) {
  const scope = useContext(WalletScopeCtx);
  const { data, isLoading, error, isFetching, refetch } = useWalletDailySummary(date, scope);
  const suffix = isToday ? "HÔM NAY" : `NGÀY ${vnDateLabel(date)}`;

  const added = data?.added_new_count ?? 0;
  const renewed = data?.added_renew_count ?? 0;
  const spent = data?.fee_net ?? 0;
  const viaInvoice = data?.fee_from_invoice ?? 0;
  const viaWallet = data?.fee_from_balance ?? 0;
  const second = data ? secondInviteLine(data) : null;

  // Chưa đọc được số nào mà vẫn vẽ "0 email / 0 đ" là bịa: hai thẻ này là chỗ user
  // liếc để biết hôm nay làm được bao nhiêu (user 2026-08-30). Thay bằng thẻ lỗi.
  if (error && !data) {
    return (
      <section style={{ display: "grid", gap: 14 }}>
        <div style={card}>
          <div style={cardKicker}>SỐ CỦA {suffix}</div>
          <LoadError
            error={error}
            onRetry={() => void refetch()}
            retrying={isFetching}
            fallback="Không đọc được số tổng kết của ngày."
          />
        </div>
      </section>
    );
  }

  return (
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, alignItems: "stretch" }}>
      <div style={{ ...card, display: "flex", flexDirection: "column" }}>
        <div style={cardKicker}>ĐÃ ADD {suffix}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, height: 46 }}>
          <div style={bigNumber}>{isLoading ? "…" : added + renewed}</div>
          <div style={{ fontSize: 14, color: "var(--ink-3)" }}>email</div>
        </div>
        <div style={legendList}>
          <LegendRow swatch="var(--ink-4)" label="Email mới" value={String(added)} />
          <LegendDivider />
          <LegendRow swatch="var(--ink-3)" label="Gia hạn" value={String(renewed)} />
          {second && <LegendDivider />}
          {second}
        </div>
        <div style={{ marginTop: "auto", paddingTop: 20, minHeight: 52, display: "flex", alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
          Đếm theo email, kể cả khi dán chung một lần. Đổi email chỉ là thay thế nên
          vẫn tính một; mời lại email còn hạn không tính phí nên không nằm ở đây.
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
        {/* Số cũ vẫn đúng tới lúc nó được đọc, nên giữ lại — chỉ nói thêm là lần làm
            mới vừa rồi hỏng, kẻo user tưởng đang nhìn số sống. */}
        {error && (
          <LoadError
            error={error}
            onRetry={() => void refetch()}
            retrying={isFetching}
            variant="inline"
            fallback="Số của ngày chưa được làm mới."
          />
        )}
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
  // Mời lại email còn hạn: không thêm email nào nên KHÔNG nằm trong tổng — nói ra ở
  // đây để đại lý thấy lượt mời đó vẫn được ghi nhận, chỉ là không mất tiền.
  if (d.added_free_reinvite_count > 0) {
    return (
      <LegendRow
        swatch="var(--ink-4)"
        label="Mời lại (miễn phí)"
        value={String(d.added_free_reinvite_count)}
      />
    );
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

function TxnGroups({ groups, limit, onMore, canMore, loadingMore, day, trace, hidden, onShowHidden, serverTotals, closing, error, onRetry, retrying }: { groups: DayGroup[]; limit: number; onMore: () => void; canMore: boolean; loadingMore: boolean; day: string | null; trace: RefundTrace; hidden: { voided: number; settled: number }; onShowHidden: () => void; serverTotals: boolean; closing: Map<string, number>; error: unknown; onRetry: () => void; retrying: boolean }) {
  const today = vnToday();
  let budget = limit;
  const visible: DayGroup[] = [];
  for (const g of groups) {
    if (budget <= 0) break;
    visible.push(budget >= g.rows.length ? g : { ...g, rows: g.rows.slice(0, budget) });
    budget -= g.rows.length;
  }
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  // Hỏng thì nói là hỏng. Câu "Chưa có giao dịch nào" cho một lượt gọi lỗi là nói
  // sai sự thật về tiền — user tưởng sổ trống chứ không biết là chưa đọc được.
  if (error && total === 0) {
    return <LoadError error={error} onRetry={onRetry} retrying={retrying} fallback="Không đọc được lịch sử giao dịch." />;
  }

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
          {/* Danh sách xếp mới→cũ nên mốc 23:59:59 đứng ngay dưới tiêu đề ngày. */}
          {g.date !== today && (closing.get(g.date) ?? 0) > 0 && (
            <DayClosingRow date={g.date} amount={closing.get(g.date) as number} />
          )}
          {g.rows.map((r) => <HistoryRow key={rowKey(r)} row={r} trace={trace} />)}
        </div>
      ))}
      {error && (
        <div style={{ padding: "10px 20px", borderTop: "1px solid var(--border)" }}>
          <LoadError
            error={error}
            onRetry={onRetry}
            retrying={retrying}
            variant="inline"
            fallback="Không tải thêm được giao dịch cũ hơn."
          />
        </div>
      )}
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
  const scope = useContext(WalletScopeCtx);
  const { data } = useWalletDailySummary(fromServer ? group.date : "", scope);
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
  closing: { icon: "=", iconBg: "var(--surface-2)", iconFg: "var(--ink-2)", tag: "Tra soát", tagBg: "var(--surface-2)", tagFg: "var(--ink-2)" },
};

/**
 * Chốt sổ CUỐI NGÀY — chỉ hiện khi ví còn tiền lúc 23:59:59.
 *
 * Không phải bút toán, không tính vào tổng Nạp/Chi của ngày: chỉ là mốc tra soát để
 * thấy ngay phần tiền chưa tiêu hết chuyển sang hôm sau. Thiếu nó thì ngày nạp
 * 41.910.000đ mà "đã tiêu" 39.930.000đ nhìn như hụt mất tiền, phải dò từng dòng mới
 * ra (user 2026-08-29). Ngày HÔM NAY chưa đóng sổ nên không hiện.
 */
function DayClosingRow({ date, amount }: { date: string; amount: number }) {
  return (
    <RowShell
      face={FACE.closing}
      title="Số dư cuối ngày còn lại"
      at={`23:59:59 ${vnDateLabel(date)}`}
      amount={formatVnd(amount)}
      amountFg="var(--ink)"
    />
  );
}

function HistoryRow({ row, trace }: { row: TxnRow; trace: RefundTrace }) {
  if (row.type === "withdraw") return <WithdrawRow txns={row.txns} />;
  if (row.type === "voided") return <VoidedRow row={row} usage={trace.usage.get(row)} />;

  const fees = row.txns.filter((t) => t.kind === "invite_fee" || t.kind === "renew_fee");
  if (fees.length > 0) return <FeeRow row={row} fees={fees} funding={trace.funding.get(row)} perFee={trace.perFee} />;

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
 * TIỀN HOÀN LẺ còn trong ví: bút toán hoàn của một lượt mời hỏng mà dòng phí của nó
 * rơi sang trang khác, nên không ghép cặp được. Trước đây dòng này ghi "Nạp qua hoá
 * đơn" — nghe như nạp mới, trong khi bản chất là hoàn (user 2026-08-26). Ăn hết bởi
 * lượt mời sau ⇒ triệt tiêu, mặc định ẩn.
 *
 * Ca ghép được cặp thì khoản hoàn nằm luôn trong dòng lỗi mời (xem `VoidedRow`).
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
      meta={`Hoàn phí lượt mời lỗi của ${who} · tiền trả lại vào ví`}
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
      balance={`Số dư còn ${formatVnd(t.balance_after)}`}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      txns={row.txns}
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
  txns,
}: {
  face: RowFace;
  title: string;
  /** Dòng phụ dưới tiêu đề. Bỏ trống khi dòng không cần giải thích gì thêm. */
  meta?: string;
  note?: string;
  at: string;
  amount: string;
  amountFg: string;
  balance?: string;
  detail?: React.ReactNode;
  onToggle?: () => void;
  open?: boolean;
  extra?: React.ReactNode;
  /** Các bút toán làm nên dòng này — chỉ dùng để bày bảng đối soát ở trang quản trị. */
  txns?: WalletTxn[];
}) {
  const scope = useContext(WalletScopeCtx);
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
        {meta && <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--ink-2)" }}>{meta}</div>}
        {note && <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--ink-2)", overflowWrap: "anywhere" }}>{note}</div>}
        <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{at}</div>
        {extra}
        {open && detail}
        {open && scope && txns && txns.length > 0 && <AdminTxnDetails txns={txns} />}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-.01em", color: amountFg, whiteSpace: "nowrap" }}>{amount}</div>
        {balance && <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{balance}</div>}
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
 * Chi tiết dòng mời: MỖI EMAIL MỘT DÒNG, viết luôn tiền ở đâu chảy vào email đó.
 *
 * Trước đây bung ra hai khối rời — email bị trừ ở khối trên, email đã hoàn ở khối
 * dưới — cùng một khoản tiền phải tự ghép bằng mắt, mà lượt mời lại chính email cũ
 * thì hai khối in đúng một danh sách y hệt nhau (user 2026-08-28: "tiền lấy từ các
 * tài khoản sẽ → tài khoản đích nhận, như vậy hợp lý hơn, không cần nhiều dòng").
 * Nay gộp còn một dòng: `nguồn hoàn → email nhận`; mời lại chính email đã hoàn thì
 * bỏ mũi tên, chỉ gắn nhãn "tiền hoàn của chính email".
 */
function FeeEmailList({ fees, perFee }: { fees: WalletTxn[]; perFee: Map<string, RefundSource[]> }) {
  return (
    <div style={{ marginTop: 10, borderLeft: "2px solid var(--border)", paddingLeft: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      {fees.map((t) => {
        const to = t.meta?.email ? String(t.meta.email) : t.kind;
        const from = perFee.get(t.id) ?? [];
        const self = from.length === 1 && from[0].email.toLowerCase() === to.toLowerCase();
        return (
          <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-2)" }}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {from.length > 0 && !self && (
                <>
                  <span style={{ color: "var(--success)" }}>{from.map((f) => f.email).join(" + ")}</span>
                  <span style={{ color: "var(--ink-3)", padding: "0 6px" }}>→</span>
                </>
              )}
              {to}
              {self && (
                <span style={{ marginLeft: 8, fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--success)" }}>
                  tiền hoàn của chính email
                </span>
              )}
            </span>
            <span style={{ color: "var(--danger)", flexShrink: 0 }}>{formatVnd(t.amount)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Một THAO TÁC mời/gia hạn (nhiều bút toán cùng `created_at`) gộp thành 1 DÒNG —
 * thay vì hiện "Nạp qua hoá đơn +X" rồi "Phí mời −X" ngược dấu rối mắt. Bấm để bung
 * chi tiết từng email.
 */
function FeeRow({ row, fees, funding, perFee }: { row: Extract<TxnRow, { type: "group" }>; fees: WalletTxn[]; funding?: RefundSource[]; perFee: Map<string, RefundSource[]> }) {
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
      balance={viaInvoice ? "Số dư không đổi" : `Số dư còn ${formatVnd(finalBalance)}`}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      txns={row.txns}
      detail={<FeeEmailList fees={fees} perFee={perFee} />}
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
 *
 * Mẻ trả qua QR mà hỏng cả mẻ thì dòng này ôm luôn khoản tiền QR nằm lại ví
 * (`row.credit`): tiền vào ví thật nên số bên phải là +X chứ không phải 0 đ. Tách làm
 * hai dòng thì cùng một giây hiện hai lần cùng một số tiền, còn nói ngược nhau về số
 * dư (user 2026-09-01). Khoản đó còn hay đã tiêu hết chỉ nói bằng MÀU của số tiền —
 * user chốt bỏ hết câu giải thích, dòng chỉ giữ số.
 */
function VoidedRow({
  row,
  usage,
}: {
  row: Extract<TxnRow, { type: "voided" }>;
  usage?: { used: number; total: number; emails: string[] };
}) {
  const [open, setOpen] = useState(false);
  const { pairs } = row;
  const fee = pairs.reduce((s, p) => s - p.fee.amount, 0); // tổng phí đã trừ (dương)
  // Số dư ghi bên phải lấy ở bút toán hoá đơn: cả mẻ hỏng thì phí trừ rồi hoàn về
  // đúng chỗ cũ, nên đó cũng là số dư sau khi cả lượt này xong.
  const credit = row.credit && usage ? { ...usage, balanceAfter: row.credit[0].balance_after } : null;
  const left = credit ? credit.total - credit.used : 0;
  const per = credit ? credit.total / pairs.length : 0;
  return (
    <RowShell
      face={FACE.voided}
      title={`Lỗi mời · ${pairs.length} email`}
      meta={
        credit
          ? `Đã trả ${formatVnd(credit.total)}`
          : `Đã trừ ${formatVnd(fee)} rồi hoàn lại đủ · không mất tiền`
      }
      at={stamp(pairs[0].fee.created_at)}
      amount={credit ? `+${formatVnd(credit.total)}` : "0 ₫"}
      amountFg={credit && left > 0 ? "var(--success)" : "var(--ink-3)"}
      balance={credit ? `Số dư còn ${formatVnd(credit.balanceAfter)}` : "Số dư không đổi"}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      txns={[...(row.credit ?? []), ...pairs.flatMap((p) => [p.fee, p.refund])]}
      detail={
        <EmailList
          items={pairs.map((p) => ({
            key: p.fee.id,
            email: p.fee.meta?.email ? String(p.fee.meta.email) : "(không rõ email)",
            amount: credit ? `tiền QR ${formatVnd(per)} ở lại ví` : `hoàn ${stamp(p.refund.created_at)}`,
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
  cycle_fee: "Trừ trực tiếp từ số dư ví · trả kỳ còn nợ",
  invite_refund: "Tự động hoàn lập tức về số dư ví",
  adjust: "Sửa thẳng số dư ví · quản trị điều chỉnh tay",
};

const SINGLE_FACE: Partial<Record<WalletTxn["kind"], RowFace>> = {
  topup: FACE.topup,
  order_topup: FACE.invoice,
  invite_fee: FACE.wallet,
  renew_fee: FACE.wallet,
  cycle_fee: FACE.wallet,
  invite_refund: FACE.refund,
  adjust: FACE.adjust,
};

/** Một bút toán lẻ (nạp/hoàn/điều chỉnh…) — không thuộc thao tác mời nào. */
function SingleRow({ t, stranded }: { t: WalletTxn; stranded: number }) {
  // Ví của chính mình: dòng lẻ không có gì để bung. Trang quản trị: bung ra bảng đối soát.
  const scope = useContext(WalletScopeCtx);
  const [open, setOpen] = useState(false);
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
      balance={`Số dư còn ${formatVnd(t.balance_after)}`}
      txns={[t]}
      open={open}
      onToggle={scope ? () => setOpen((v) => !v) : undefined}
    />
  );
}

/**
 * Một yêu cầu rút gộp thành 1 DÒNG duy nhất (dù sinh nhiều bút toán
 * withdraw_hold/settle/refund) — kèm thanh tiến trình 3 bước.
 */
function WithdrawRow({ txns }: { txns: WalletTxn[] }) {
  const scope = useContext(WalletScopeCtx);
  const [open, setOpen] = useState(false);
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
      balance={`Số dư còn ${formatVnd(latest.balance_after)}`}
      txns={txns}
      open={open}
      onToggle={scope ? () => setOpen((v) => !v) : undefined}
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


/* ── Chi tiết ĐỐI SOÁT (chỉ trang Quản trị Ví) ───────────────────────────────
   Chủ ví không cần biết bút toán mang mã gì, trỏ về hoá đơn nào, ai bấm nút. Người
   đối soát thì cần đúng mấy thứ đó, nên bung dòng ở trang quản trị hiện thêm bảng
   này bên dưới phần chi tiết thường (user 2026-08-29). */

/** Bảng đối soát cho mọi bút toán nằm trong MỘT dòng lịch sử. */
function AdminTxnDetails({ txns }: { txns: WalletTxn[] }) {
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {txns.map((t) => (
        <DetailSheet key={t.id} t={t as WalletTxnAdmin} />
      ))}
    </div>
  );
}

// Bút toán do hệ thống ghi (không có actor_id) — nói rõ CÁI GÌ ghi, đừng để trống.
const SYSTEM_ACTOR: Partial<Record<WalletTxnKind, string>> = {
  topup: "Hệ thống · webhook SePay",
  order_topup: "Hệ thống · webhook SePay",
  invite_refund: "Hệ thống · hoàn phí mời hỏng",
};

// Trạng thái của thứ mà ref_id trỏ tới (hoá đơn, lệnh hàng đợi, yêu cầu rút).
const REF_STATUS_LABEL: Record<string, string> = {
  pending: "chờ thanh toán",
  paid: "đã thanh toán",
  expired: "hết hạn",
  cancelled: "đã huỷ",
  approved: "đã duyệt",
  rejected: "bị từ chối",
  PENDING: "chờ chạy",
  IN_PROGRESS: "đang chạy",
  COMPLETED: "đã xong",
  FAILED: "thất bại",
};

function asStr(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Một dòng nhãn → giá trị trong bảng chi tiết. */
function SheetRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 600, paddingTop: 1 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>{children}</div>
    </>
  );
}

const monoChip: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "1px 6px",
  userSelect: "all",
};

const linkChip: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--success)",
  textDecoration: "none",
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "2px 10px",
  background: "transparent",
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

/**
 * Bảng chi tiết 1 bút toán. Mọi thứ đủ để đối soát tay: mã bút toán + seq (khoá
 * sắp xếp thật của sổ cái), số dư trước → sau, mã hoá đơn, lệnh đã chạy, người bấm
 * nút, và cuối cùng là `meta` thô cho trường hợp dữ liệu cũ không khớp khuôn nào.
 */
function DetailSheet({ t }: { t: WalletTxnAdmin }) {
  const [rawOpen, setRawOpen] = useState(false);
  const meta = (t.meta ?? {}) as Record<string, unknown>;
  const providerTxn = asStr(meta.provider_txn_id);
  const reason = asStr(meta.reason);
  const note = asStr(meta.note);
  const before = t.balance_after - t.amount;
  const actor = t.actor_email ?? SYSTEM_ACTOR[t.kind] ?? "Hệ thống";
  const refStatus = t.ref_status ? (REF_STATUS_LABEL[t.ref_status] ?? t.ref_status) : null;

  return (
    <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "10px", padding: "12px 14px", marginTop: 2 }}>
      <div style={{ display: "grid", gridTemplateColumns: "112px minmax(0,1fr)", gap: "7px 12px", alignItems: "start" }}>
        <SheetRow label="Mã bút toán">
          <span style={monoChip}>{t.id}</span>
          {t.seq != null && <span style={{ color: "var(--ink-3)", marginLeft: 6 }}>seq {t.seq}</span>}
        </SheetRow>
        <SheetRow label="Loại">
          {TXN_KIND_LABEL[t.kind] ?? t.kind} <span style={{ ...monoChip, marginLeft: 4 }}>{t.kind}</span>
        </SheetRow>
        <SheetRow label="Số dư ví">
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {formatVnd(before)} → <b>{formatVnd(t.balance_after)}</b>
          </span>
          {t.held_after > 0 && (
            <span style={{ color: "var(--ink-3)" }}> · đang giữ {formatVnd(t.held_after)}</span>
          )}
        </SheetRow>
        <SheetRow label="Thời điểm">
          <span style={{ fontFamily: "var(--font-mono)" }}>{new Date(t.created_at).toLocaleString("vi-VN")}</span>
        </SheetRow>
        <SheetRow label="Người thực hiện">{actor}</SheetRow>
        {t.member_email && <SheetRow label="Thành viên">{t.member_email}</SheetRow>}
        {t.workspace_id && (
          <SheetRow label="Workspace">
            <Link to={`/workspaces/${t.workspace_id}/members`} style={linkChip}>
              {t.workspace_name ?? "Mở workspace"} ↗
            </Link>
          </SheetRow>
        )}
        {t.queue_item_id && (
          <SheetRow label="Lệnh đã chạy">
            <Link to={`/queue?item=${t.queue_item_id}`} style={linkChip}>
              {t.queue_item_type ?? "Mở trong Hàng đợi"} ↗
            </Link>
            {refStatus && <span style={{ color: "var(--ink-3)", marginLeft: 8 }}>{refStatus}</span>}
          </SheetRow>
        )}
        {t.ref_code && (
          <SheetRow label="Mã hoá đơn">
            <span style={monoChip}>{t.ref_code}</span>
            {refStatus && !t.queue_item_id && (
              <span style={{ color: "var(--ink-3)", marginLeft: 8 }}>{refStatus}</span>
            )}
          </SheetRow>
        )}
        {t.ref_id && (
          <SheetRow label="Tham chiếu">
            <span style={{ color: "var(--ink-3)" }}>{t.ref_type ?? "?"} · </span>
            <span style={monoChip}>{t.ref_id}</span>
          </SheetRow>
        )}
        {providerTxn && (
          <SheetRow label="Mã GD ngân hàng">
            <span style={monoChip}>{providerTxn}</span>
          </SheetRow>
        )}
        {meta.duplicate_invoice === true && (
          <SheetRow label="Cảnh báo">
            <span style={{ color: "var(--danger)", fontWeight: 600 }}>Trả trùng hoá đơn — tiền cộng thẳng vào ví</span>
          </SheetRow>
        )}
        {reason && <SheetRow label="Lý do">{reason}</SheetRow>}
        {note && <SheetRow label="Ghi chú">{note}</SheetRow>}
      </div>
      {t.meta && Object.keys(t.meta).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setRawOpen((v) => !v)}
            style={{ ...linkChip, color: "var(--ink-3)" }}
          >
            {rawOpen ? "Ẩn meta thô" : "Xem meta thô"}
          </button>
          {rawOpen && (
            <pre style={{ margin: "8px 0 0", padding: "10px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--ink)", overflowX: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(t.meta, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
