/**
 * Gom bút toán ví thành DÒNG LỊCH SỬ (hàm thuần, để test được không cần render).
 *
 * Vì sao phải gom: một thao tác ví sinh nhiều bút toán, hiện thô ra thì mỗi thao
 * tác nát thành 2–3 dòng ngược dấu ở những chỗ khác nhau.
 *
 *   • Rút tiền → hold/settle/refund: gộp theo `ref_id` thành 1 dòng + tiến trình.
 *   • Mời/gia hạn hàng loạt → 1 `order_topup` (nếu trả qua hoá đơn) + N phí, tất cả
 *     dùng chung `created_at` (now() là hằng trong 1 transaction) → gộp theo mốc đó.
 *   • MỜI HỎNG → `invite_fee` (−X, cờ `reversed`) rồi lát sau `invite_refund` (+X):
 *     cặp này TRIỆT TIÊU nhau, user không mất đồng nào. Trước đây hiện 2 dòng rời
 *     nhau, dòng phí còn gắn nhãn "✓ Thành công" dù lượt mời hỏng ⇒ phải tự ghép
 *     bằng mắt (user 2026-08-26: "khó nhìn khó hiểu"). Nay ghép sẵn thành dòng
 *     `voided` đặt đúng chỗ lượt mời, MẶC ĐỊNH ẨN ở trang Ví.
 *
 * Giữ nguyên thứ tự mới→cũ của API.
 */

import { TXN_KIND_LABEL } from "./wallet";
import type { WalletTxn } from "./wallet";

/** 1 lượt mời hỏng: phí đã trừ và bút toán hoàn lại tương ứng. */
export type VoidedPair = { fee: WalletTxn; refund: WalletTxn };

export type TxnRow =
  /** Một thao tác ví (cùng `created_at`) — có thể là 1 bút toán lẻ. */
  | {
      type: "group";
      key: string;
      txns: WalletTxn[];
      /** Tiền phí của các lượt hỏng CÙNG mốc này (đã tách ra dòng `voided`). */
      voidedTotal: number;
      /** Số email hỏng cùng mốc — dòng gộp nói "còn N email nữa hỏng, đã hoàn". */
      voidedCount: number;
      invoiceStranded: number;
    }
  /** Các lượt mời hỏng ĐÃ HOÀN đủ tại cùng một mốc — mặc định ẩn. */
  | { type: "voided"; key: string; pairs: VoidedPair[]; invoiceStranded: number }
  | { type: "withdraw"; id: string; txns: WalletTxn[] };

function emailOf(t: WalletTxn): string {
  const e = t.meta?.email;
  return typeof e === "string" ? e.toLowerCase() : "";
}

/**
 * Ghép `invite_fee` (reversed) với `invite_refund` của nó.
 *
 * Khoá chính là (ref_id = queue_item_id, email) — đúng cách backend ghi bút toán
 * hoàn (wallet_service.refund_invite). Bút toán cũ thiếu `meta.email` thì hạ xuống
 * ghép theo ref_id + đúng số tiền, mỗi bút toán hoàn chỉ dùng 1 lần.
 *
 * Phí `reversed` mà KHÔNG tìm được bút toán hoàn trong danh sách (bút toán hoàn rơi
 * sang trang khác) thì để nguyên dòng phí — thà hiện thừa còn hơn giấu mất một
 * khoản tiền không giải thích được.
 *
 * Trả map `fee.id → cặp`. Export vì trang Ví phía ADMIN (WalletAdmin) gom nhóm theo
 * cách riêng (có chip lọc, không gộp rút tiền) nhưng phải ghép cặp y hệt — luật
 * "thế nào là lượt mời hỏng đã triệt tiêu" chỉ được nằm ở MỘT chỗ.
 */
export function pairVoidedInvites(txns: WalletTxn[]): Map<string, VoidedPair> {
  const refunds = txns.filter((t) => t.kind === "invite_refund");
  const used = new Set<string>();
  const byKey = new Map<string, WalletTxn[]>();
  for (const r of refunds) {
    const key = `${r.ref_id ?? ""}|${emailOf(r)}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const pairs = new Map<string, VoidedPair>(); // fee.id → cặp
  for (const fee of txns) {
    if (fee.kind !== "invite_fee" || !fee.reversed) continue;
    const key = `${fee.ref_id ?? ""}|${emailOf(fee)}`;
    let refund = (byKey.get(key) ?? []).find((r) => !used.has(r.id));
    if (!refund) {
      refund = refunds.find(
        (r) => !used.has(r.id) && r.ref_id === fee.ref_id && r.amount === -fee.amount,
      );
    }
    if (!refund) continue;
    used.add(refund.id);
    pairs.set(fee.id, { fee, refund });
  }
  return pairs;
}

export function buildTxnRows(txns: WalletTxn[]): TxnRow[] {
  const pairs = pairVoidedInvites(txns);
  const hidden = new Set<string>();
  for (const [feeId, p] of pairs) {
    hidden.add(feeId);
    hidden.add(p.refund.id);
  }

  // Tiền hoá đơn của lượt hỏng Ở LẠI trong ví (không phải triệt tiêu): +X vào ví rồi
  // −X phí, hoàn thêm +X ⇒ ví dôi ra X. Ghi lại theo mốc để nói rõ trên giao diện.
  const invoiceAt = new Map<string, number>();
  const voidedAt = new Map<string, number>();
  const voidedCountAt = new Map<string, number>();
  for (const t of txns) {
    if (t.kind === "order_topup") invoiceAt.set(t.created_at, (invoiceAt.get(t.created_at) ?? 0) + t.amount);
  }
  for (const p of pairs.values()) {
    const at = p.fee.created_at;
    voidedAt.set(at, (voidedAt.get(at) ?? 0) - p.fee.amount);
    voidedCountAt.set(at, (voidedCountAt.get(at) ?? 0) + 1);
  }
  const strandedAt = (at: string): number =>
    Math.max(0, Math.min(invoiceAt.get(at) ?? 0, voidedAt.get(at) ?? 0));

  const rows: TxnRow[] = [];
  const wIndex = new Map<string, number>();
  const tIndex = new Map<string, number>();
  const vIndex = new Map<string, number>();
  for (const t of txns) {
    if (hidden.has(t.id)) {
      const pair = pairs.get(t.id);
      if (!pair) continue; // bút toán hoàn — đã kể trong dòng `voided` của phí
      const at = t.created_at;
      const at2 = vIndex.get(at);
      if (at2 != null) {
        (rows[at2] as { pairs: VoidedPair[] }).pairs.push(pair);
      } else {
        vIndex.set(at, rows.length);
        rows.push({ type: "voided", key: at, pairs: [pair], invoiceStranded: strandedAt(at) });
      }
      continue;
    }
    if (t.ref_type === "withdrawal" && t.ref_id) {
      const at = wIndex.get(t.ref_id);
      if (at != null) {
        (rows[at] as { txns: WalletTxn[] }).txns.push(t);
      } else {
        wIndex.set(t.ref_id, rows.length);
        rows.push({ type: "withdraw", id: t.ref_id, txns: [t] });
      }
    } else {
      const at = tIndex.get(t.created_at);
      if (at != null) {
        (rows[at] as { txns: WalletTxn[] }).txns.push(t);
      } else {
        tIndex.set(t.created_at, rows.length);
        rows.push({
          type: "group",
          key: t.created_at,
          txns: [t],
          voidedTotal: voidedAt.get(t.created_at) ?? 0,
          voidedCount: voidedCountAt.get(t.created_at) ?? 0,
          invoiceStranded: strandedAt(t.created_at),
        });
      }
    }
  }
  return rows;
}

/** Số LƯỢT mời hỏng đã hoàn đủ (để đếm trên nút "hiện/ẩn"). */
export function countVoidedInvites(rows: TxnRow[]): number {
  return rows.reduce((n, r) => (r.type === "voided" ? n + r.pairs.length : n), 0);
}

// ── Lọc/gom theo NGÀY cho giao diện Ví (mockup "Vi-standalone" 2026-08-26) ──
//
// Trang Ví mới xếp lịch sử theo từng ngày (mỗi ngày một tiêu đề kèm tổng Nạp/Chi/
// Seat) và cho lọc theo "tiền đi đường nào". Toàn bộ luật ở đây là hàm THUẦN để
// test được mà không cần render — cùng lý do với `buildTxnRows`.

/**
 * Tiền của một dòng đi đường nào:
 *   • `invoice` — mời/gia hạn trả THẲNG qua hoá đơn QR (có `order_topup` cùng mốc),
 *     số dư ví không đổi.
 *   • `wallet`  — trừ/cộng thẳng vào số dư ví (phí mời trừ ví, rút tiền, điều chỉnh âm).
 *   • `in`      — tiền VÀO ví (nạp chuyển khoản, hoàn phí lẻ, điều chỉnh dương).
 *   • `voided`  — lượt mời hỏng đã hoàn đủ: không phải dòng tiền, chỉ hiện khi bật.
 */
export type TxnChannel = "wallet" | "invoice" | "in" | "voided";

const FEE_KINDS = new Set(["invite_fee", "renew_fee"]);

export function rowChannel(row: TxnRow): TxnChannel {
  if (row.type === "voided") return "voided";
  if (row.type === "withdraw") return "wallet";
  const hasFee = row.txns.some((t) => FEE_KINDS.has(t.kind));
  if (hasFee) return row.txns.some((t) => t.kind === "order_topup") ? "invoice" : "wallet";
  // Không có phí: nạp/hoàn/hoá đơn đọng lại đều là tiền VÀO ví. Điều chỉnh âm là
  // tiền RA nên xếp về nhánh ví.
  const net = row.txns.reduce((s, t) => s + t.amount, 0);
  return net >= 0 ? "in" : "wallet";
}

/** Ngày (giờ Việt Nam) của một dòng, dạng YYYY-MM-DD — mốc mà báo cáo ngày dùng. */
export function vnDateKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * Số dư CHỐT CUỐI NGÀY của từng ngày VN — để lịch sử có một dòng tra soát ở mốc
 * 23:59:59 thay vì bắt người xem tự cộng trừ cả ngày. Ngày nạp 41.910.000đ mà ô
 * "đã tiêu" ghi 39.930.000đ thì phần chênh nằm lại trong ví, không nói ra thì
 * nhìn như thất thoát (user 2026-08-29).
 *
 * Lấy `balance_after` của bút toán MỚI NHẤT trong ngày. Dựa vào THỨ TỰ MẢNG (API
 * trả theo `seq` giảm dần) chứ không so `created_at`: một lượt mời hàng loạt ghi
 * cả chục bút toán dùng chung một mốc thời gian nên so mốc không biết cái nào
 * đứng sau. Ngày chỉ tải được một phần vẫn đúng vì lịch sử luôn tải từ mới về cũ.
 */
export function closingBalanceByDay(txns: WalletTxn[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of txns) {
    const date = vnDateKey(t.created_at);
    if (!out.has(date)) out.set(date, t.balance_after);
  }
  return out;
}

function rowAt(row: TxnRow): string {
  if (row.type === "voided") return row.pairs[0].fee.created_at;
  return row.txns[row.txns.length - 1].created_at;
}

/** THỰC CHI của một dòng (số dương). Lượt hỏng đã hoàn đủ ⇒ 0. */
export function rowSpend(row: TxnRow): number {
  if (row.type !== "group") return 0;
  return row.txns.reduce((s, t) => (FEE_KINDS.has(t.kind) ? s - t.amount : s), 0);
}

/** Số lượt `invite_fee` tính phí trong dòng — lượt lỗi mời không tính.
 *
 *  DỰ PHÒNG cho ô "New" ở tiêu đề ngày: số chính lấy từ `daily-summary` của server,
 *  vì cộng tại chỗ chỉ thấy phần lịch sử đã tải (100 bút toán/trang). Chỗ này cũng
 *  KHÔNG tách được email cũ hết hạn add lại — lượt đó cũng là `invite_fee` — nên khi
 *  rơi về đây con số có thể nhỉnh hơn số của server. */
export function rowNewSeats(row: TxnRow): number {
  if (row.type !== "group") return 0;
  return row.txns.filter((t) => t.kind === "invite_fee").length;
}

/** Số lượt `renew_fee` tính phí trong dòng. Tách khỏi mời mới vì gia hạn tốn tiền mà
 *  KHÔNG thêm email nào vào team — gộp chung làm số "Seat" lệch với thẻ "Mời hôm
 *  nay" mà không ai giải thích được (user 2026-08-26). Cũng là DỰ PHÒNG của ô
 *  "Renew" (xem `rowNewSeats`). */
export function rowRenewSeats(row: TxnRow): number {
  if (row.type !== "group") return 0;
  return row.txns.filter((t) => t.kind === "renew_fee").length;
}

/** Tiền NẠP qua chuyển khoản trong dòng (không tính tiền hoá đơn chảy thẳng vào phí). */
export function rowTopup(row: TxnRow): number {
  if (row.type !== "group") return 0;
  return row.txns.reduce((s, t) => (t.kind === "topup" ? s + t.amount : s), 0);
}

export type DayGroup = {
  /** YYYY-MM-DD theo giờ VN. */
  date: string;
  rows: TxnRow[];
  topup: number;
  spend: number;
  /** Suất mời MỚI (`invite_fee`). */
  newSeats: number;
  /** Suất GIA HẠN (`renew_fee`). */
  renewSeats: number;
};

/**
 * Lọc theo chip + ngày + công tắc "hiện lượt mời hỏng", rồi gom theo ngày VN.
 * `channel = null` ⇒ tất cả. `day = null` ⇒ mọi ngày. Giữ thứ tự mới→cũ của API.
 */
export function groupRowsByDay(
  rows: TxnRow[],
  opts: {
    channel?: TxnChannel | null;
    day?: string | null;
    showVoided?: boolean;
    /** Dòng đã TRIỆT TIÊU với dòng khác (tiền hoàn bị lượt sau tiêu hết) — ẩn cùng
     *  công tắc "hiện lượt hỏng" vì nó cũng là chuyện tiền có đi có về. */
    hidden?: ReadonlySet<TxnRow>;
  } = {},
): DayGroup[] {
  const { channel = null, day = null, showVoided = false, hidden } = opts;
  const groups: DayGroup[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    const ch = rowChannel(row);
    if (ch === "voided" && !showVoided) continue;
    if (hidden?.has(row) && !showVoided) continue;
    // Lượt hỏng không thuộc kênh tiền nào ⇒ chỉ hiện ở chip "Tất cả".
    if (channel && ch !== channel) continue;
    const date = vnDateKey(rowAt(row));
    if (day && date !== day) continue;
    let at = index.get(date);
    if (at == null) {
      at = groups.length;
      index.set(date, at);
      groups.push({ date, rows: [], topup: 0, spend: 0, newSeats: 0, renewSeats: 0 });
    }
    const g = groups[at];
    g.rows.push(row);
    g.topup += rowTopup(row);
    g.spend += rowSpend(row);
    g.newSeats += rowNewSeats(row);
    g.renewSeats += rowRenewSeats(row);
  }
  // Yêu cầu rút gối ngày (giữ hôm nay, duyệt hôm sau) được xếp theo mốc GIỮ nên có
  // thể rơi vào nhóm ngày cũ hơn dòng đứng trước ⇒ sắp lại nhóm mới→cũ cho chắc.
  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return groups;
}

/**
 * Số dòng đang bị CÔNG TẮC "hiện lượt lỗi mời" giấu đi trong đúng phạm vi đang xem
 * (chip kênh + ngày). Dùng cho lúc danh sách rỗng: ngày chỉ có lượt hỏng thì trước
 * đây trang in "Không có giao dịch trong ngày …" nghe như mất dữ liệu (user
 * 2026-08-27), trong khi thật ra dòng đó đang bị ẩn.
 *
 * Luật lọc phải khớp `groupRowsByDay`: dòng bị chip/ngày loại thì KHÔNG tính là
 * "đang ẩn" — nó nằm ngoài phạm vi, bật công tắc lên cũng không hiện.
 */
export function countHiddenRows(
  rows: TxnRow[],
  opts: {
    channel?: TxnChannel | null;
    day?: string | null;
    hidden?: ReadonlySet<TxnRow>;
  } = {},
): { voided: number; settled: number } {
  const { channel = null, day = null, hidden } = opts;
  let voided = 0;
  let settled = 0;
  for (const row of rows) {
    const ch = rowChannel(row);
    if (channel && ch !== channel) continue;
    if (day && vnDateKey(rowAt(row)) !== day) continue;
    if (ch === "voided") voided += row.type === "voided" ? row.pairs.length : 1;
    else if (hidden?.has(row)) settled += 1;
  }
  return { voided, settled };
}

// ── Xuất báo cáo CSV ────────────────────────────────────────────────────────

/** Nhãn "tiền đi đường nào" — dùng chung cho giao diện và báo cáo xuất ra. */
export const CHANNEL_LABEL: Record<TxnChannel, string> = {
  wallet: "Trừ số dư ví",
  invoice: "Thanh toán trực tiếp",
  in: "Tiền vào",
  voided: "Lỗi mời (đã hoàn phí)",
};

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV đối soát của ĐÚNG những dòng đang hiện (nút "Xuất báo cáo"): mỗi bút toán một
 * dòng, kèm kênh tiền và email liên quan. Excel bản Việt đọc CSV theo dấu `;` nên
 * dùng `;` làm ngăn cách và số giữ nguyên dấu chấm thập phân của JS (số nguyên VND
 * nên không có phần lẻ).
 */
export function buildTxnCsv(groups: DayGroup[]): string {
  const head = ["Ngày", "Giờ", "Loại", "Kênh", "Email", "Số tiền (đ)", "Số dư sau (đ)"];
  const lines = [head.join(";")];
  for (const g of groups) {
    for (const row of g.rows) {
      const channel = CHANNEL_LABEL[rowChannel(row)];
      const txns = row.type === "voided" ? row.pairs.map((p) => p.fee) : row.txns;
      for (const t of txns) {
        const at = new Date(t.created_at);
        const time = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Ho_Chi_Minh",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(at);
        // Lượt hỏng đã hoàn đủ ⇒ thực chi 0, ghi 0 thay vì số phí đã trừ rồi trả lại.
        const amount = row.type === "voided" ? 0 : t.amount;
        lines.push(
          [
            vnDateKey(t.created_at),
            time,
            TXN_KIND_LABEL[t.kind] ?? t.kind,
            channel,
            typeof t.meta?.email === "string" ? t.meta.email : "",
            amount,
            row.type === "voided" ? "" : t.balance_after,
          ]
            .map(csvCell)
            .join(";"),
        );
      }
    }
  }
  return lines.join("\n");
}

// ── Nguồn gốc tiền: lượt mời sau tiêu tiền hoàn của lượt mời hỏng trước ─────
//
// Mời hỏng mà lượt đó trả THẲNG qua hoá đơn QR thì tiền đã vào ví rồi Ở LẠI đó
// (phí bị trừ rồi hoàn về). Trước đây khoản ấy hiện thành "Nạp qua hoá đơn +X" —
// nghe như nạp mới, trong khi thực chất là TIỀN HOÀN. Lượt mời sau tiêu đúng
// khoản đó, nhưng dòng phí lại không nói tiền ở đâu ra (user 2026-08-26: "tiền sử
// dụng đều phải có nguồn gốc rõ ràng, từ đâu mà có để mà sử dụng").
//
// Ở đây lần theo FIFO (cũ → mới): mỗi khoản hoàn còn nằm trong ví là một "lô",
// mỗi lượt mời TRỪ VÍ về sau ăn dần các lô đó theo thứ tự cũ trước. Lô bị ăn hết
// ⇔ đã triệt tiêu với lượt mời sau, không còn là tiền chờ tiêu nữa.

/** Một phần tiền hoàn được lượt mời sau tiêu tới, kèm email đã hoàn nó. */
export type RefundSource = { email: string; amount: number };

export type RefundTrace = {
  /** Dòng phí trừ ví → các khoản hoàn mà nó tiêu (rỗng ⇒ tiêu tiền nạp thường). */
  funding: Map<TxnRow, RefundSource[]>;
  /** TỪNG lượt phí (`fee.id`) → khoản hoàn đã nuôi đúng lượt đó. Nhờ vậy chi tiết
   *  dòng mời viết được "hoàn của email A → email B" ngay trên một dòng, thay vì
   *  liệt kê email bị trừ ở một khối rồi email đã hoàn ở khối khác (user 2026-08-28:
   *  "tiền lấy từ các tài khoản sẽ → tài khoản đích nhận, không cần nhiều dòng"). */
  perFee: Map<string, RefundSource[]>;
  /** Dòng tiền hoàn → đã bị tiêu bao nhiêu trên tổng bao nhiêu, của email nào. */
  usage: Map<TxnRow, { used: number; total: number; emails: string[] }>;
};

/** Gộp nhiều lô cùng email thành một dòng nguồn gốc. */
function mergeSources(list: RefundSource[]): RefundSource[] {
  const out: RefundSource[] = [];
  for (const s of list) {
    const hit = out.find((o) => o.email === s.email);
    if (hit) hit.amount += s.amount;
    else out.push({ ...s });
  }
  return out;
}

export function traceRefundUsage(rows: TxnRow[]): RefundTrace {
  // Email của các lượt hỏng tại từng mốc — để biết khoản hoàn là của ai.
  const voidedEmailsAt = new Map<string, string[]>();
  for (const r of rows) {
    if (r.type !== "voided") continue;
    voidedEmailsAt.set(
      r.key,
      r.pairs.map((p) => (typeof p.fee.meta?.email === "string" ? p.fee.meta.email : "(không rõ email)")),
    );
  }

  const funding = new Map<TxnRow, RefundSource[]>();
  const perFee = new Map<string, RefundSource[]>();
  const usage = new Map<TxnRow, { used: number; total: number; emails: string[] }>();
  /** Hàng đợi tiền hoàn chưa tiêu, cũ đứng trước. */
  const lots: { row: TxnRow; email: string; remaining: number }[] = [];

  // API trả mới→cũ; dòng tiền phải lần theo chiều CŨ→MỚI mới đúng nhân quả.
  for (const row of [...rows].reverse()) {
    if (row.type !== "group") continue;

    // 1) Sinh lô tiền hoàn.
    const strandedInvoice = row.invoiceStranded;
    const loneRefund = row.txns.length === 1 && row.txns[0].kind === "invite_refund";
    if (strandedInvoice > 0 || loneRefund) {
      const emails = loneRefund
        ? [typeof row.txns[0].meta?.email === "string" ? row.txns[0].meta.email : "(không rõ email)"]
        : voidedEmailsAt.get(row.key) ?? ["(không rõ email)"];
      const total = loneRefund ? row.txns[0].amount : strandedInvoice;
      usage.set(row, { used: 0, total, emails });
      // Chia đều cho các email hỏng cùng mốc — phí mỗi lượt bằng nhau nên chia đều
      // là đúng, không phải ước lượng.
      const per = total / emails.length;
      for (const email of emails) lots.push({ row, email, remaining: per });
    }

    // 2) Lượt mời TRỪ VÍ ăn dần các lô, tính riêng TỪNG lượt phí để biết khoản hoàn
    //    nào chảy vào email nào. Lượt trả qua hoá đơn không đụng số dư nên không
    //    tiêu tiền hoàn.
    const viaInvoice = row.txns.some((t) => t.kind === "order_topup");
    if (viaInvoice) continue;
    const used: RefundSource[] = [];
    for (const fee of row.txns) {
      if (!FEE_KINDS.has(fee.kind)) continue;
      let need = -fee.amount;
      const mine: RefundSource[] = [];
      const self = emailOf(fee);

      const eat = (at: number) => {
        const lot = lots[at];
        const take = Math.min(need, lot.remaining);
        lot.remaining -= take;
        need -= take;
        const u = usage.get(lot.row);
        if (u) u.used += take;
        mine.push({ email: lot.email, amount: take });
      };

      // Tiền hoàn của CHÍNH email này được ưu tiên nuôi lại chính nó. Trước đây ăn
      // FIFO thuần nên mời lại a@ mà ví còn tiền hoàn của a@ vẫn bị ghi "tiêu tiền
      // hoàn của b@" chỉ vì lô của b@ vào trước — đọc lên như thể tiền chạy lung tung
      // giữa các khách (user 2026-08-30). Chỉ khi lô của chính nó đã hết thì mới ăn
      // sang lô người khác, và lúc đó nhãn "hoàn từ email khác" mới là sự thật.
      while (need > 0) {
        const at = lots.findIndex((l) => l.remaining > 0 && l.email.toLowerCase() === self);
        if (at < 0) break;
        eat(at);
      }
      while (need > 0) {
        const at = lots.findIndex((l) => l.remaining > 0);
        if (at < 0) break;
        eat(at);
      }
      for (let i = lots.length - 1; i >= 0; i--) if (lots[i].remaining <= 0) lots.splice(i, 1);

      if (mine.length === 0) continue;
      perFee.set(fee.id, mergeSources(mine));
      used.push(...mine);
    }
    if (used.length > 0) funding.set(row, mergeSources(used));
  }

  return { funding, perFee, usage };
}
