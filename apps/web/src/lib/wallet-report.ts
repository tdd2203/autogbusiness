/**
 * Báo cáo ví — dựng MÔ HÌNH báo cáo rồi đổ ra .xlsx / .csv (hàm thuần, test được
 * không cần render).
 *
 * Vì sao viết lại: bản cũ (`buildTxnCsv`) đổ thẳng mỗi bút toán một dòng CSV ngăn
 * cách `;`, số để trần `-330000`, không tổng ngày, không số dư đầu/cuối kỳ. Mở ra
 * là một khối chữ phẳng, muốn biết ngày hôm đó tiêu bao nhiêu phải tự cộng tay, mà
 * máy nào đặt dấu phân tách là `,` thì dồn hết vào cột A (user 2026-08-30: "khó
 * nhìn và không trực quan").
 *
 * Bốn sheet:
 *   • Tổng quan     — số dư đầu/cuối kỳ, tổng vào/ra (đầu + vào − ra = cuối, luôn
 *                     khớp), phân loại bút toán, bảng từng ngày.
 *   • Chi tiết lệnh — dải ngày → cụm lệnh → từng email, có cột Kết quả nên lệnh hỏng
 *                     nằm ngay cạnh lệnh chạy được, khỏi tách ra sheet riêng.
 *   • Theo email    — mỗi ngày một khối, mỗi người một dòng: mời mới, gia hạn, hỏng,
 *                     thực chi.
 *   • Email trong ngày — danh sách email có phát sinh tiền, ghép thêm dữ liệu thành
 *                     viên: trạng thái, hạn dùng, thu tiền, và chuỗi ĐỔI EMAIL.
 *
 * PHẠM VI: `items` đã được server cắt theo NGÀY đang xem nên mọi sheet cùng một kỳ.
 * Riêng chip lọc kênh + công tắc "hiện lượt hỏng" chỉ áp cho sheet Chi tiết lệnh —
 * các sheet kia luôn tính trên toàn bộ bút toán của kỳ, nếu không thì số dư đầu/cuối
 * kỳ không còn cộng trừ ra nhau được. Dòng đầu file nói rõ điều đó.
 *
 * Sheet "Email trong ngày" đi từ email CÓ PHÁT SINH TIỀN trong sổ ví rồi mới đối
 * chiếu sang danh sách thành viên (chốt user 2026-08-30). Nghĩa là email add tay hay
 * đổi email không tốn phí sẽ KHÔNG có mặt — đổi lại, mọi dòng trong sheet đều khớp
 * với phần tiền của báo cáo, không có dòng nào lơ lửng không giải thích được.
 */

import { TXN_KIND_LABEL } from "./wallet";
import type { WalletTxn } from "./wallet";
import { CHANNEL_LABEL, pairVoidedInvites, rowChannel, vnDateKey } from "./wallet-history";
import type { DayGroup, RefundTrace, TxnChannel, TxnRow } from "./wallet-history";
import { downloadBlob, downloadWorkbook, XSTYLE } from "./xlsx";
import type { XCell, XSheet } from "./xlsx";

const FEE_KINDS = new Set(["invite_fee", "renew_fee", "cycle_fee"]);

const WEEKDAY = ["chủ nhật", "thứ hai", "thứ ba", "thứ tư", "thứ năm", "thứ sáu", "thứ bảy"];

function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

/** "2026-08-30" → "30/08/2026". */
export function dmy(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

function vnTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

const str = (v: unknown): string => (typeof v === "string" && v ? v : "");
const vnd = (n: number): string => n.toLocaleString("vi-VN");

/* ── Dữ liệu thành viên ghép thêm ─────────────────────────────────────────── */

/** Phần dữ liệu thành viên mà báo cáo cần — `AddedMember` khớp sẵn hình dạng này. */
export type MemberInfo = {
  email: string;
  status: string;
  subscription_end_at: string | null;
  payment_status: string;
  removed_reason?: string | null;
  email_changed_to?: string[];
  workspace_name?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  active: "Đang dùng",
  pending: "Chờ vào đội",
  removed: "Đã rời đội",
};

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "Chưa thu",
  requested: "Chờ duyệt",
  paid: "Đã thu",
};

const REMOVED_LABEL: Record<string, string> = {
  expired: "Hết hạn",
  removed_by_admin: "Admin gỡ khỏi đội",
  invite_revoked: "Thu hồi lời mời",
  invite_failed: "Mời hỏng",
  sync_missing: "Đồng bộ không thấy trong đội",
  email_changed: "Đã đổi sang email khác",
  subscription_transferred: "Đã chuyển hạn sang email khác",
};

/* ── Mô hình báo cáo ───────────────────────────────────────────────────────── */

export type ReportEntry = {
  date: string;
  time: string;
  /** Nội dung ("Phí mời", "Nạp tiền"…). */
  label: string;
  /** "Thành công" / "Hỏng, đã hoàn phí" — chỉ dòng phí mới có. */
  outcome: string;
  channel: string;
  email: string;
  /** Tiền VÀO ví (0 nếu không). Tách hẳn khỏi tiền ra để Excel cộng được từng cột. */
  moneyIn: number;
  moneyOut: number;
  /** Số dư TRƯỚC bút toán — có cột này thì đọc một dòng là thấy tiền đi từ đâu tới
   *  đâu, khỏi phải dò ngược dòng trên. Lượt hỏng lấy dư trước của lần trừ phí và
   *  dư sau của lần hoàn ⇒ hai số bằng nhau, nhìn phát biết không mất đồng nào. */
  balanceBefore: number | null;
  balanceAfter: number | null;
  refCode: string;
  providerTxn: string;
  note: string;
  voided: boolean;
};

export type ReportCluster = {
  /** Số thứ tự lệnh do báo cáo tự đánh, chạy 0 → 99999 theo thứ tự đọc. Id thật của
   *  lệnh là UUID, in ra chẳng ai đối chiếu được. */
  no: number;
  /** Nhãn cụm ("Lệnh mời", "Lệnh gia hạn"). "" ⇔ dòng lẻ, không in dải cụm. */
  label: string;
  /** Loại lệnh, luôn có kể cả khi cụm chỉ 1 email (lúc đó `label` rỗng). */
  kind: string;
  refCode: string;
  /** Số email BỊ TÍNH PHÍ trong cụm (không kể lượt hỏng đã hoàn). */
  charged: number;
  voided: number;
  spend: number;
  viaInvoice: boolean;
  entries: ReportEntry[];
};

export type EmailStat = {
  email: string;
  newSeats: number;
  renewSeats: number;
  voided: number;
  spend: number;
  lastAt: string;
};

/** 1 dòng sheet "Email trong ngày": số của ví ghép với dữ liệu thành viên. */
export type RosterRow = {
  email: string;
  /** "Mời mới" / "Gia hạn" / "Mời mới, gia hạn". */
  service: string;
  outcome: string;
  spend: number;
  status: string;
  expiry: string;
  payment: string;
  workspace: string;
  /** Chuỗi đổi email "a@x → b@x". "" nếu email này không phải ca đổi. */
  changedTo: string;
  note: string;
};

export type ReportDay = {
  date: string;
  clusters: ReportCluster[];
  topup: number;
  spend: number;
  newSeats: number;
  renewSeats: number;
  moneyIn: number;
  moneyOut: number;
  /** Số dư chốt cuối ngày; null ⇔ ngày không có bút toán nào trong dữ liệu đã tải. */
  closing: number | null;
  emails: EmailStat[];
  roster: RosterRow[];
};

export type KindTotal = { label: string; count: number; moneyIn: number; moneyOut: number };

export type WalletReport = {
  owner: string;
  periodFrom: string;
  periodTo: string;
  filterLabel: string;
  generatedAt: string;
  opening: number;
  closing: number;
  /** Tiền vào/ra THỰC — đã trừ các cặp phí-bị-hoàn. Đây mới là con số đối chiếu
   *  được với sao kê ngân hàng. */
  moneyIn: number;
  moneyOut: number;
  /** Tổng THÔ (cộng cả tiền chạy vòng) — chỉ dùng ở bảng phân loại bút toán. */
  grossIn: number;
  grossOut: number;
  /** Tiền của các lượt lỗi đã triệt tiêu: trừ rồi trả lại, không phải dòng tiền. */
  voidedAmount: number;
  days: ReportDay[];
  kinds: KindTotal[];
  voidedCount: number;
  /** Có ghép được dữ liệu thành viên hay không — quyết định sheet email in gì. */
  hasMembers: boolean;
  /** Số chỗ `Dư sau` của dòng trên KHÔNG nối được `Dư trước` của dòng dưới. Khác 0 ⇒
   *  thiếu bút toán (chưa tải hết trang), sổ không dùng để đối soát được. */
  chainBreaks: number;
};

export type ReportInput = {
  /** Tên người sở hữu ví (username hoặc email). */
  owner: string;
  /** TOÀN BỘ bút toán đã tải của kỳ — nguồn của số dư đầu/cuối và các sheet tổng hợp. */
  items: WalletTxn[];
  /** Các dòng đã gom + lọc đúng như màn hình đang hiện — nguồn của sheet Chi tiết lệnh. */
  groups: DayGroup[];
  /** Số dư chốt cuối từng ngày (tính trên bút toán thô, chưa lọc). */
  closing: Map<string, number>;
  trace: RefundTrace;
  channel: TxnChannel | null;
  showVoided: boolean;
  /** Ngày đang xem; null ⇔ đang xem mọi ngày đã tải. */
  day: string | null;
  /** Danh sách email đã add của tài khoản, để ghép trạng thái + chuỗi đổi email.
   *  Thiếu (chưa tải kịp / không có quyền) thì sheet email chỉ có phần của ví. */
  members?: MemberInfo[];
  /** Mốc "xuất lúc" — truyền vào để test không phụ thuộc đồng hồ. */
  now: Date;
};

/* ── Mã hoá đơn theo CỤM ───────────────────────────────────────────────────
 *
 * Chỉ bút toán trỏ thẳng về topup_orders / payment_orders mới mang sẵn `ref_code`.
 * Phí mời/gia hạn trỏ về lệnh trong hàng đợi nên không có mã. Nhưng lượt trả qua
 * hoá đơn ghi `order_topup` + N phí trong CÙNG một transaction ⇒ chung `created_at`
 * (now() là hằng trong transaction Postgres). Lấy mã theo mốc đó là chắc, khỏi phải
 * ghép ở server bằng member_id/queue_id — một member có nhiều hoá đơn gia hạn, ghép
 * kiểu đó là ghép ẩu.
 */
function codesByMoment(items: WalletTxn[]): Map<string, { ref: string; provider: string }> {
  const out = new Map<string, { ref: string; provider: string }>();
  for (const t of items) {
    const ref = str(t.ref_code);
    const provider = str(t.provider_txn_id) || str(t.meta?.provider_txn_id);
    if (!ref && !provider) continue;
    const cur = out.get(t.created_at) ?? { ref: "", provider: "" };
    out.set(t.created_at, { ref: cur.ref || ref, provider: cur.provider || provider });
  }
  return out;
}

/* ── Dựng dòng chi tiết ────────────────────────────────────────────────────── */

const KIND_NOTE: Record<string, string> = {
  topup: "Nạp ví qua chuyển khoản",
  order_topup: "Tiền đã được cộng vào ví",
  withdraw_hold: "Giữ chờ duyệt",
  withdraw_settle: "Đã chi cho người rút",
  withdraw_refund: "Từ chối rút, trả lại ví",
};

/**
 * Lượt mời HỎNG rốt cuộc email có vào đội hay không — sổ ví KHÔNG trả lời được.
 *
 * Ví chỉ biết "đã trừ phí rồi hoàn lại". Có ca lời mời thật sự đã vào đội nhưng vòng
 * F5 đọc không kịp, `stale-invite-resolver` chốt hỏng sau 20 phút, hoàn tiền và xoá
 * bản ghi member; lần đồng bộ sau thấy email VẪN ở trong workspace nên dựng lại một
 * dòng member mới không mang ký ức gì về tiền. Kết quả: khách dùng trọn 30 ngày mà
 * cửa hàng thu 0đ (ca `sonvvng` 15/8/2026, mãi 26/8 mới lộ — xem
 * `_flag_refunded_while_in_team` ở members/reconcile.py).
 *
 * Vậy nên phải ĐỐI CHIẾU sang danh sách thành viên. Email đã rời đội vì `invite_failed`
 * / `invite_revoked` thì đúng là không vào được. Còn rời vì hết hạn, admin gỡ, đổi
 * email… nghĩa là nó ĐÃ TỪNG ở trong đội — tức dịch vụ đã giao mà tiền đã trả lại.
 */
const NOT_DELIVERED = new Set(["invite_failed", "invite_revoked"]);

export function voidedVerdict(
  email: string,
  members: Map<string, MemberInfo>,
  charged: ReadonlySet<string>,
): string {
  // Mời lỗi rồi MỜI LẠI ĐƯỢC là chuyện thường: lượt sau tính phí đàng hoàng nên email
  // nằm trong đội là đúng, chẳng ai nợ ai. Không xét điều này thì mỗi lần mời lại thành
  // công lại đẻ ra một dòng đòi truy thu oan (user 2026-08-30: "lỗi đã hoàn phí, và xác
  // nhận chưa mời thành công sao lại truy thu?").
  if (charged.has(email.toLowerCase())) return "Đã mời lại thành công sau đó.";
  const m = members.get(email.toLowerCase());
  if (!m) {
    return members.size === 0
      ? "Chưa đối chiếu được, thiếu danh sách thành viên."
      : "Đúng là chưa vào đội, không còn bản ghi thành viên.";
  }
  if (m.status === "active" || m.status === "pending") {
    return "Cần Truy Thu: đã hoàn phí, email vẫn trong đội mà kỳ này không có lượt nào tính phí.";
  }
  const reason = str(m.removed_reason);
  if (NOT_DELIVERED.has(reason) || !reason) return "Đúng là chưa vào đội.";
  return `Cần Kiểm: đã hoàn phí nhưng email từng ở trong đội, rời vì ${(REMOVED_LABEL[reason] ?? reason).toLowerCase()}.`;
}

function feeNote(t: WalletTxn, trace: RefundTrace): string {
  const src = trace.perFee.get(t.id);
  if (!src || src.length === 0) return "";
  return `Tiêu tiền hoàn của ${src.map((s) => s.email).join(", ")}`;
}

/** Phần đóng góp của MỘT `TxnRow` vào cụm của nó. */
type RowPart = {
  entries: ReportEntry[];
  charged: number;
  voided: number;
  spend: number;
  viaInvoice: boolean;
  kind: string;
};

function partOf(
  row: TxnRow,
  trace: RefundTrace,
  codes: Map<string, { ref: string; provider: string }>,
  members: Map<string, MemberInfo>,
  chargedEmails: ReadonlySet<string>,
): RowPart {
  const channel = CHANNEL_LABEL[rowChannel(row)];
  const entries: ReportEntry[] = [];
  let charged = 0;
  let voided = 0;
  let spend = 0;

  const codeAt = (t: WalletTxn) => {
    const ownRef = str(t.ref_code);
    const ownProvider = str(t.provider_txn_id) || str(t.meta?.provider_txn_id);
    const shared = codes.get(t.created_at) ?? { ref: "", provider: "" };
    return { ref: ownRef || shared.ref, provider: ownProvider || shared.provider };
  };

  if (row.type === "voided") {
    for (const p of [...row.pairs].reverse()) {
      const c = codeAt(p.fee);
      const email = str(p.fee.meta?.email);
      voided += 1;
      entries.push({
        date: vnDateKey(p.fee.created_at),
        time: vnTime(p.fee.created_at),
        label: "Phí mời - Đã hoàn",
        outcome: "Lỗi, đã hoàn phí",
        channel: "Đã hoàn đủ",
        email,
        moneyIn: p.refund.amount,
        moneyOut: -p.fee.amount,
        balanceBefore: p.fee.balance_after - p.fee.amount,
        balanceAfter: p.refund.balance_after,
        refCode: c.ref,
        providerTxn: c.provider,
        note: [
          "Thực chi 0",
          row.invoiceStranded > 0 ? "tiền hoá đơn ở lại ví" : null,
          voidedVerdict(email, members, chargedEmails),
        ]
          .filter(Boolean)
          .join(" · "),
        voided: true,
      });
    }
    return { entries, charged, voided, spend, viaInvoice: false, kind: "Lệnh mời" };
  }

  // Lượt trả THẲNG qua hoá đơn ghi 2 bút toán cùng lúc: `order_topup` (+X vào ví) rồi
  // `invite_fee` (−X ra ngay). Hiện thành 2 dòng thì một lượt mời đọc mất 2 dòng ngược
  // dấu mà số dư không nhúc nhích (user 2026-08-30: "thể hiện 1 dòng thôi"). Nay tiền
  // hoá đơn được gán THẲNG vào dòng phí mà nó trả, nguồn tiền ghi luôn ở cột Nội dung.
  const orderTotal = row.txns.reduce((n, t) => (t.kind === "order_topup" ? n + t.amount : n), 0);
  const feeTxns = row.txns.filter((t) => FEE_KINDS.has(t.kind));
  const merge = orderTotal > 0 && feeTxns.length > 0;
  let leftover = orderTotal;

  for (const t of [...row.txns].reverse()) {
    if (merge && t.kind === "order_topup") continue; // đã gán vào dòng phí bên dưới
    const c = codeAt(t);
    const isFee = FEE_KINDS.has(t.kind);
    // Hoá đơn trả đúng số phí của các suất trong mẻ, nên gán từng dòng đúng phí của
    // nó là khớp tuyệt đối, không phải chia ước lượng. Dư ra thì tách dòng riêng.
    let fromInvoice = 0;
    if (merge && isFee) {
      fromInvoice = Math.min(leftover, -t.amount);
      leftover -= fromInvoice;
    }
    if (isFee) {
      charged += 1;
      spend += -t.amount;
    }
    entries.push({
      date: vnDateKey(t.created_at),
      time: vnTime(t.created_at),
      label: isFee
        ? `${TXN_KIND_LABEL[t.kind] ?? t.kind} - ${fromInvoice > 0 ? "Hoá đơn" : "Số dư ví"}`
        : (TXN_KIND_LABEL[t.kind] ?? t.kind),
      outcome: isFee ? "Thành công" : "",
      channel,
      email: str(t.meta?.email),
      moneyIn: fromInvoice > 0 ? fromInvoice : t.amount > 0 ? t.amount : 0,
      moneyOut: t.amount < 0 ? -t.amount : 0,
      // Dòng gộp ôm CẢ HAI bút toán (tiền hoá đơn vào rồi phí ra ngay), nên "Dư trước"
      // phải là số dư TRƯỚC khoản hoá đơn — không thì nó không nối được dòng phía trên.
      balanceBefore: t.balance_after - t.amount - fromInvoice,
      balanceAfter: t.balance_after,
      refCode: c.ref,
      providerTxn: c.provider,
      note: isFee
        ? feeNote(t, trace)
        : str(t.meta?.reason) || str(t.meta?.note) || KIND_NOTE[t.kind] || "",
      voided: false,
    });
  }

  // Hoá đơn trả dư so với phí đã trừ (lượt trong mẻ hỏng hết chẳng hạn): khoản đó Ở LẠI
  // trong ví, phải hiện thành một dòng chứ không được nuốt mất.
  if (merge && leftover > 0) {
    const src = row.txns.find((t) => t.kind === "order_topup")!;
    const c = codeAt(src);
    entries.push({
      date: vnDateKey(src.created_at),
      time: vnTime(src.created_at),
      label: TXN_KIND_LABEL.order_topup,
      outcome: "",
      channel,
      email: "",
      moneyIn: leftover,
      moneyOut: 0,
      balanceBefore: src.balance_after - src.amount,
      balanceAfter: src.balance_after,
      refCode: c.ref,
      providerTxn: c.provider,
      note: "Tiền hoá đơn còn lại trong ví",
      voided: false,
    });
  }

  const kind = row.txns.some((t) => t.kind === "renew_fee" || t.kind === "cycle_fee")
    ? "Lệnh gia hạn"
    : row.txns.some((t) => t.kind === "invite_fee")
      ? "Lệnh mời"
      : "";
  return {
    entries,
    charged,
    voided,
    spend,
    viaInvoice: row.txns.some((t) => t.kind === "order_topup"),
    kind,
  };
}

/**
 * Khoá CỤM của một dòng. Cùng một lệnh mời/gia hạn ⇒ mọi bút toán dùng chung
 * `created_at` (now() là hằng trong một transaction Postgres), kể cả bút toán hoá
 * đơn và các lượt HỎNG đã hoàn — `buildTxnRows` tách lượt hỏng ra dòng riêng cho
 * giao diện, nhưng trong báo cáo chúng phải nằm cùng cụm với các email mời cùng mẻ
 * (user 2026-08-30: "những email nào mời chung cụm thì thể hiện chung cụm").
 */
function clusterKey(row: TxnRow): string {
  if (row.type === "withdraw") return `w:${row.id}`;
  if (row.type === "voided") return row.key;
  return row.key;
}

/** Gom các dòng của MỘT ngày thành cụm, giữ nguyên thứ tự xuất hiện. */
function clustersOf(
  rows: TxnRow[],
  trace: RefundTrace,
  codes: Map<string, { ref: string; provider: string }>,
  members: Map<string, MemberInfo>,
  chargedEmails: ReadonlySet<string>,
): ReportCluster[] {
  const out: ReportCluster[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    const part = partOf(row, trace, codes, members, chargedEmails);
    const key = clusterKey(row);
    const at = index.get(key);
    if (at != null) {
      const c = out[at];
      c.entries.push(...part.entries);
      c.charged += part.charged;
      c.voided += part.voided;
      c.spend += part.spend;
      c.viaInvoice = c.viaInvoice || part.viaInvoice;
      c.kind = c.kind || part.kind;
      c.refCode = c.refCode || (part.entries.find((e) => e.refCode)?.refCode ?? "");
      continue;
    }
    index.set(key, out.length);
    out.push({
      no: 0, // đánh số ở bước dựng báo cáo, theo đúng thứ tự đọc
      label: "",
      kind: part.kind,
      refCode: part.entries.find((e) => e.refCode)?.refCode ?? "",
      charged: part.charged,
      voided: part.voided,
      spend: part.spend,
      viaInvoice: part.viaInvoice,
      entries: part.entries,
    });
  }
  // Chỉ gọi là CỤM khi có từ 2 email trở lên — một email lẻ mà cũng kẻ dải riêng thì
  // bảng lại rối đúng như cái đang muốn sửa.
  for (const c of out) {
    const emails = c.entries.filter((e) => e.email).length;
    c.label = emails >= 2 ? c.kind : "";
  }
  return out;
}

/* ── Tổng hợp ──────────────────────────────────────────────────────────────── */

function kindTotals(items: WalletTxn[]): KindTotal[] {
  const map = new Map<string, KindTotal>();
  for (const t of items) {
    const label = TXN_KIND_LABEL[t.kind] ?? t.kind;
    const cur = map.get(label) ?? { label, count: 0, moneyIn: 0, moneyOut: 0 };
    cur.count += 1;
    if (t.amount > 0) cur.moneyIn += t.amount;
    else cur.moneyOut += -t.amount;
    map.set(label, cur);
  }
  return [...map.values()].sort((a, b) => b.moneyIn + b.moneyOut - (a.moneyIn + a.moneyOut));
}

/** Gom bút toán của MỘT ngày thành thống kê theo email. */
function emailStatsOf(dayTxns: WalletTxn[]): EmailStat[] {
  const map = new Map<string, EmailStat>();
  for (const t of dayTxns) {
    const email = str(t.meta?.email);
    if (!email) continue;
    const key = email.toLowerCase();
    const cur =
      map.get(key) ?? { email, newSeats: 0, renewSeats: 0, voided: 0, spend: 0, lastAt: "" };
    if (t.kind === "invite_fee") {
      if (t.reversed) cur.voided += 1;
      else {
        cur.newSeats += 1;
        cur.spend += -t.amount;
      }
    } else if (t.kind === "renew_fee" || t.kind === "cycle_fee") {
      cur.renewSeats += 1;
      cur.spend += -t.amount;
    }
    if (t.created_at > cur.lastAt) cur.lastAt = t.created_at;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend || a.email.localeCompare(b.email));
}

/** Ghép thống kê email của ngày với dữ liệu thành viên (trạng thái, hạn, đổi email). */
function rosterOf(
  stats: EmailStat[],
  members: Map<string, MemberInfo>,
  charged: ReadonlySet<string>,
): RosterRow[] {
  return stats.map((s) => {
    const m = members.get(s.email.toLowerCase());
    const service = [s.newSeats ? "Mời mới" : "", s.renewSeats ? "Gia hạn" : ""]
      .filter(Boolean)
      .join(", ");
    const outcome =
      s.newSeats + s.renewSeats > 0
        ? s.voided
          ? `Thành công (${s.voided} lượt lỗi đã hoàn)`
          : "Thành công"
        : s.voided
          ? `Lỗi, đã hoàn phí. ${voidedVerdict(s.email, members, charged)}`
          : "";
    const chain = m?.email_changed_to ?? [];
    return {
      email: s.email,
      service: service || "—",
      outcome: outcome || "—",
      spend: s.spend,
      status: m ? (STATUS_LABEL[m.status] ?? m.status) : "",
      expiry: m?.subscription_end_at
        ? dmy(vnDateKey(m.subscription_end_at))
        : m
          ? m.status === "removed"
            ? "—"
            : "Vô thời hạn"
          : "",
      payment: m ? (PAYMENT_LABEL[m.payment_status] ?? m.payment_status) : "",
      workspace: str(m?.workspace_name),
      changedTo: chain.length ? [s.email, ...chain].join(" → ") : "",
      note: m?.removed_reason ? (REMOVED_LABEL[m.removed_reason] ?? m.removed_reason) : "",
    };
  });
}

const CHANNEL_FILTER_LABEL: Record<TxnChannel, string> = {
  wallet: "chỉ dòng trừ số dư ví",
  invoice: "chỉ dòng thanh toán trực tiếp",
  in: "chỉ dòng tiền vào",
  voided: "chỉ lượt mời hỏng",
};

export function buildWalletReport(input: ReportInput): WalletReport {
  const { items, groups, closing, trace, channel, showVoided, day, now, owner } = input;
  const codes = codesByMoment(items);
  const memberMap = new Map<string, MemberInfo>();
  for (const m of input.members ?? []) memberMap.set(m.email.toLowerCase(), m);

  // Số dư đầu kỳ = số dư TRƯỚC bút toán cũ nhất đã tải (API trả mới→cũ nên nó nằm
  // cuối mảng). Lấy hiệu số ngay trên sổ cái, khỏi cộng dồn cả kỳ rồi lệch vì làm tròn.
  const oldest = items[items.length - 1];
  const opening = oldest ? oldest.balance_after - oldest.amount : 0;
  const closingBalance = items[0]?.balance_after ?? opening;

  // Lượt mời LỖI bị trừ phí rồi hoàn lại đủ là tiền CHẠY VÒNG, không phải dòng tiền:
  // cộng cả hai chiều vào tổng thì báo cáo phình lên gấp mấy lần số thật và không
  // còn khớp với đối soát ngân hàng (user 2026-08-30: ví hdh2102 ngày 30/8 thực chỉ
  // 4.620.000 vào–ra mà khối chỉ số ghi 16.500.000). Bỏ ĐÚNG CẢ CẶP nên hiệu
  // vào − ra không đổi, đẳng thức đầu + vào − ra = cuối vẫn nguyên.
  const paired = pairVoidedInvites(items);
  const churn = new Set<string>();
  let voidedAmount = 0;
  for (const [feeId, pair] of paired) {
    churn.add(feeId);
    churn.add(pair.refund.id);
    voidedAmount += -pair.fee.amount;
  }

  let moneyIn = 0;
  let moneyOut = 0;
  let grossIn = 0;
  let grossOut = 0;
  const byDate = new Map<string, WalletTxn[]>();
  for (const t of items) {
    if (t.amount > 0) {
      grossIn += t.amount;
      if (!churn.has(t.id)) moneyIn += t.amount;
    } else {
      grossOut += -t.amount;
      if (!churn.has(t.id)) moneyOut += -t.amount;
    }
    const d = vnDateKey(t.created_at);
    const list = byDate.get(d);
    if (list) list.push(t);
    else byDate.set(d, [t]);
  }

  // Báo cáo xếp theo chiều CŨ → MỚI, ngược với màn hình.
  //
  // Trên trang Ví thì mới-trước là đúng: mở ra phải thấy việc vừa xảy ra. Nhưng file
  // xuất ra có cột số dư chạy, mà đọc mới-trước thì số dư TĂNG dần từ trên xuống
  // trong khi thực tế đang tiêu tiền, và dòng cuối cùng lại là số dư đầu chứ không
  // phải số dư chốt (user 2026-08-30: "sắp xếp ngược à, cuối cùng lệnh trừ số dư ví
  // phải bằng 0"). Xuôi thời gian thì Dư trước → Dư sau nối liền mạch xuống tận dòng
  // cuối, và dòng cộng ngày đặt ngay sau đó chốt đúng con số ấy.
  // Email nào ĐÃ bị tính phí thành công trong kỳ (phí không bị hoàn lại).
  const chargedEmails = new Set<string>();
  for (const t of items) {
    if (!FEE_KINDS.has(t.kind) || t.reversed) continue;
    const e = str(t.meta?.email).toLowerCase();
    if (e) chargedEmails.add(e);
  }

  let no = 0;
  const days: ReportDay[] = [...groups].reverse().map((g) => {
    const clusters = clustersOf([...g.rows].reverse(), trace, codes, memberMap, chargedEmails);
    for (const c of clusters) {
      if (!c.label) continue;
      c.no = no;
      no = (no + 1) % 100_000;
    }
    let dIn = 0;
    let dOut = 0;
    for (const c of clusters) {
      for (const e of c.entries) {
        if (e.voided) continue; // trừ rồi hoàn lại — không phải tiền vào cũng không phải tiền ra
        dIn += e.moneyIn;
        dOut += e.moneyOut;
      }
    }
    const stats = emailStatsOf(byDate.get(g.date) ?? []);
    return {
      date: g.date,
      clusters,
      topup: g.topup,
      spend: g.spend,
      newSeats: g.newSeats,
      renewSeats: g.renewSeats,
      moneyIn: dIn,
      moneyOut: dOut,
      closing: closing.get(g.date) ?? null,
      emails: stats,
      roster: rosterOf(stats, memberMap, chargedEmails),
    };
  });

  // Sổ tiền chỉ dùng được khi các dòng NỐI được vào nhau. Đứt mạch ⇒ thiếu bút toán,
  // và số dư sẽ nhảy vô cớ giữa hai dòng. Đếm ra để nói thẳng trên đầu file thay vì
  // để người đọc tự phát hiện (như ca ví hdh2102 ngày 30/8).
  let chainBreaks = 0;
  let prev: number | null = null;
  for (const d of days) {
    for (const c of d.clusters) {
      for (const e of c.entries) {
        if (prev !== null && e.balanceBefore !== null && e.balanceBefore !== prev) chainBreaks += 1;
        if (e.balanceAfter !== null) prev = e.balanceAfter;
      }
    }
  }

  const dates = [...byDate.keys()].sort();
  const filterBits = [
    channel ? CHANNEL_FILTER_LABEL[channel] : "tất cả kênh tiền",
    showVoided ? "gồm cả lượt mời hỏng" : "ẩn lượt mời hỏng đã hoàn",
  ];

  return {
    owner,
    periodFrom: dates[0] ?? day ?? "",
    periodTo: dates[dates.length - 1] ?? day ?? "",
    filterLabel: filterBits.join(" · "),
    generatedAt: `${dmy(vnDateKey(now.toISOString()))} ${vnTime(now.toISOString())}`,
    opening,
    closing: closingBalance,
    moneyIn,
    moneyOut,
    grossIn,
    grossOut,
    voidedAmount,
    days,
    kinds: kindTotals(items),
    voidedCount: items.filter((t) => t.kind === "invite_fee" && t.reversed).length,
    hasMembers: memberMap.size > 0,
    chainBreaks,
  };
}

/* ── Đổ ra .xlsx ───────────────────────────────────────────────────────────── */

const cell = (v: string | number | null, s?: keyof typeof XSTYLE, span?: number): XCell => ({
  v,
  s,
  span,
});
const blank = (n: number): XCell[] => Array.from({ length: n }, () => null);

/** Dải ngày dùng chung cho mọi sheet — "30/08/2026 — thứ bảy · nạp … · chi … · N mời
 *  mới, M gia hạn". Báo cáo nhiều ngày thì mỗi sheet cứ theo khối ngày mà đọc. */
function dayBand(d: ReportDay): string {
  const seats = [d.newSeats ? `${d.newSeats} mời mới` : "", d.renewSeats ? `${d.renewSeats} gia hạn` : ""]
    .filter(Boolean)
    .join(", ");
  return `${dmy(d.date)} — ${weekdayOf(d.date)} · tiền vào ${vnd(d.moneyIn)} · chi ${vnd(d.moneyOut)}${seats ? ` · ${seats}` : ""}`;
}

function overviewSheet(r: WalletReport): XSheet {
  const rows: XCell[][] = [];
  rows.push([cell("Báo cáo ví — đối soát giao dịch", "title", 6)]);
  rows.push([
    cell(
      `Chủ ví ${r.owner} · kỳ ${dmy(r.periodFrom)} → ${dmy(r.periodTo)} · xuất lúc ${r.generatedAt}`,
      "meta",
      6,
    ),
  ]);
  rows.push([
    cell(
      "Mọi sheet tính trên TOÀN BỘ bút toán của kỳ, không theo bộ lọc đang xem trên trang Ví.",
      "meta",
      6,
    ),
  ]);
  if (r.chainBreaks > 0) {
    rows.push([
      cell(
        `Cảnh báo: có ${r.chainBreaks} chỗ số dư không nối được giữa hai dòng liền nhau — kỳ này thiếu bút toán, đừng dùng để đối soát.`,
        "kpiNumOut",
        6,
      ),
    ]);
  }
  rows.push(blank(6));

  rows.push([
    cell("Số dư đầu kỳ", "kpiLabel"),
    cell("Tiền vào", "kpiLabel"),
    cell("Tiền ra", "kpiLabel"),
    cell("Số dư cuối kỳ", "kpiLabel"),
    null,
    null,
  ]);
  rows.push([
    cell(r.opening, "kpiNum"),
    cell(r.moneyIn, "kpiNumIn"),
    cell(r.moneyOut, "kpiNumOut"),
    cell(r.closing, "kpiNum"),
    null,
    null,
  ]);
  rows.push([
    cell(
      `Đối chiếu: ${vnd(r.opening)} + ${vnd(r.moneyIn)} − ${vnd(r.moneyOut)} = ${vnd(r.opening + r.moneyIn - r.moneyOut)}`,
      "meta",
      6,
    ),
  ]);
  if (r.voidedAmount > 0) {
    rows.push([
      cell(
        `Đã loại ${vnd(r.voidedAmount)} của ${r.voidedCount} lượt mời lỗi (trừ phí rồi hoàn lại đủ) — tiền chạy vòng, không phải dòng tiền vào ra.`,
        "meta",
        6,
      ),
    ]);
  }
  rows.push(blank(6));

  rows.push([
    cell("Phân loại bút toán", "th"),
    cell("Số lượt", "thRight"),
    cell("Tiền vào", "thRight"),
    cell("Tiền ra", "thRight"),
    cell("", "th", 2),
  ]);
  for (const k of r.kinds) {
    rows.push([
      cell(k.label, "text"),
      cell(k.count, "num"),
      cell(k.moneyIn || null, "numIn"),
      cell(k.moneyOut || null, "numOut"),
      cell("", "text", 2),
    ]);
  }
  // Bảng trên đếm TỪNG bút toán nên có cả phí bị hoàn lẫn khoản hoàn của nó. Hai dòng
  // dưới kéo nó về đúng con số ở khối chỉ số, khỏi phải tự nhẩm vì sao lệch.
  if (r.voidedAmount > 0) {
    rows.push([
      cell("Trừ lượt mời lỗi đã hoàn", "text"),
      cell(r.voidedCount, "num"),
      cell(-r.voidedAmount, "numOut"),
      cell(-r.voidedAmount, "numOut"),
      cell("", "text", 2),
    ]);
  }
  rows.push([
    cell("Thực trong kỳ", "totalText"),
    cell(null, "totalNum"),
    cell(r.moneyIn, "totalNumIn"),
    cell(r.moneyOut, "totalNumOut"),
    cell("", "totalText", 2),
  ]);
  rows.push(blank(6));

  rows.push([
    cell("Ngày", "th"),
    cell("Tiền vào", "thRight"),
    cell("Chi", "thRight"),
    cell("Mời mới", "thRight"),
    cell("Gia hạn", "thRight"),
    cell("Dư cuối ngày", "thRight"),
  ]);
  for (const d of r.days) {
    rows.push([
      cell(`${dmy(d.date)} — ${weekdayOf(d.date)}`, "text"),
      cell(d.moneyIn || null, "numIn"),
      cell(d.moneyOut || null, "numOut"),
      cell(d.newSeats || null, "num"),
      cell(d.renewSeats || null, "num"),
      cell(d.closing, "num"),
    ]);
  }
  const sum = (pick: (d: ReportDay) => number) => r.days.reduce((s, d) => s + pick(d), 0);
  rows.push([
    cell("Cộng kỳ", "totalText"),
    cell(sum((d) => d.moneyIn), "totalNumIn"),
    cell(sum((d) => d.moneyOut), "totalNumOut"),
    cell(sum((d) => d.newSeats), "totalNum"),
    cell(sum((d) => d.renewSeats), "totalNum"),
    cell(r.closing, "totalNum"),
  ]);

  return { name: "Tổng quan", cols: [30, 16, 16, 12, 12, 17], rows };
}

/** Dải cụm: "Lệnh mời · lệnh #12 · hoá đơn ORD… · trả qua hoá đơn QR 990.000". */
function clusterBand(c: ReportCluster): string {
  const bits = [c.label, `lệnh #${c.no}`];
  if (c.refCode) bits.push(`hoá đơn ${c.refCode}`);
  bits.push(
    c.charged === 0 && c.voided > 0
      ? "cả mẻ lỗi, đã hoàn đủ phí"
      : c.viaInvoice
        ? `trả qua hoá đơn QR ${vnd(c.spend)}`
        : `trừ số dư ví ${vnd(c.spend)}`,
  );
  return bits.join(" · ");
}

const DETAIL_COLS = 12;

function detailSheet(r: WalletReport): XSheet {
  const rows: XCell[][] = [];
  rows.push([
    cell("Ngày", "th"),
    cell("Giờ", "th"),
    cell("Nội dung", "th"),
    cell("Kết quả", "th"),
    cell("Email", "th"),
    cell("Tiền vào", "thRight"),
    cell("Tiền ra", "thRight"),
    cell("Dư trước", "thRight"),
    cell("Dư sau", "thRight"),
    cell("Mã hoá đơn", "th"),
    cell("Mã GD SePay", "th"),
    cell("Ghi chú", "th"),
  ]);

  for (const d of r.days) {
    rows.push([cell(dayBand(d), "band", DETAIL_COLS)]);

    for (const c of d.clusters) {
      if (c.label) rows.push([cell(clusterBand(c), "subText", DETAIL_COLS)]);
      for (const e of c.entries) {
        const text = e.voided ? "textMuted" : "text";
        rows.push([
          cell(dmy(e.date).slice(0, 5), text),
          cell(e.time, "textMuted"),
          cell(e.label, text),
          cell(e.outcome || "—", text),
          cell(e.email || "—", text),
          cell(e.moneyIn || null, e.voided ? "numMuted" : "numIn"),
          cell(e.moneyOut || null, e.voided ? "numMuted" : "numOut"),
          cell(e.balanceBefore, e.voided ? "numMuted" : "num"),
          cell(e.balanceAfter, e.voided ? "numMuted" : "num"),
          cell(e.refCode || "—", e.voided ? "codeMuted" : "code"),
          cell(e.providerTxn || "—", e.voided ? "codeMuted" : "code"),
          cell(c.label ? [`Lệnh #${c.no}`, e.note].filter(Boolean).join(" · ") : e.note, "textMuted"),
        ]);
      }
      if (c.label) {
        rows.push([
          cell(
            `Cộng lệnh #${c.no} — ${c.charged} email tính phí${c.voided ? `, ${c.voided} lỗi` : ""}`,
            "subText",
            5,
          ),
          cell(null, "subText"),
          cell(c.spend, "subNum"),
          cell("", "subText", 5),
        ]);
      }
    }

    rows.push([
      cell(`Cộng ngày ${dmy(d.date)}`, "totalText", 5),
      cell(d.moneyIn, "totalNumIn"),
      cell(d.moneyOut, "totalNumOut"),
      cell(null, "totalNum"),
      cell(d.closing, "totalNum"),
      cell("chốt cuối ngày", "totalText", 3),
    ]);
  }

  return {
    name: "Chi tiết lệnh",
    freeze: 1,
    cols: [8, 10, 24, 30, 32, 14, 14, 15, 15, 22, 16, 34],
    rows,
  };
}

function emailSheet(r: WalletReport): XSheet {
  const rows: XCell[][] = [];
  rows.push([
    cell("Email", "th"),
    cell("Mời mới", "thRight"),
    cell("Gia hạn", "thRight"),
    cell("Lượt hỏng", "thRight"),
    cell("Thực chi", "thRight"),
    cell("Lần cuối", "th"),
  ]);
  for (const d of r.days) {
    if (d.emails.length === 0) continue;
    rows.push([cell(dayBand(d), "band", 6)]);
    for (const e of d.emails) {
      rows.push([
        cell(e.email, "text"),
        cell(e.newSeats || null, "num"),
        cell(e.renewSeats || null, "num"),
        cell(e.voided || null, "num"),
        cell(e.spend || null, "numOut"),
        cell(e.lastAt ? vnTime(e.lastAt).slice(0, 5) : "", "textMuted"),
      ]);
    }
    const sum = (pick: (e: EmailStat) => number) => d.emails.reduce((s, e) => s + pick(e), 0);
    rows.push([
      cell(`Tổng ${d.emails.length} email`, "totalText"),
      cell(sum((e) => e.newSeats), "totalNum"),
      cell(sum((e) => e.renewSeats), "totalNum"),
      cell(sum((e) => e.voided), "totalNum"),
      cell(sum((e) => e.spend), "totalNumOut"),
      cell("", "totalText"),
    ]);
  }
  return { name: "Theo email", freeze: 1, cols: [34, 11, 11, 12, 16, 12], rows };
}

const ROSTER_COLS = 9;

function rosterSheet(r: WalletReport): XSheet {
  const rows: XCell[][] = [];
  if (!r.hasMembers) {
    rows.push([
      cell(
        "Không tải được danh sách email đã add nên sheet này chỉ có phần của ví: trạng thái, hạn dùng và chuỗi đổi email để trống.",
        "meta",
        ROSTER_COLS,
      ),
    ]);
  }
  rows.push([
    cell("Email", "th"),
    cell("Dịch vụ trong ngày", "th"),
    cell("Kết quả", "th"),
    cell("Thực chi", "thRight"),
    cell("Trạng thái", "th"),
    cell("Hạn dùng", "th"),
    cell("Thu tiền", "th"),
    cell("Đổi email", "th"),
    cell("Ghi chú", "th"),
  ]);
  for (const d of r.days) {
    if (d.roster.length === 0) continue;
    rows.push([cell(dayBand(d), "band", ROSTER_COLS)]);
    for (const m of d.roster) {
      rows.push([
        cell(m.email, "text"),
        cell(m.service, "text"),
        cell(m.outcome, "text"),
        cell(m.spend || null, "numOut"),
        cell(m.status || "—", "text"),
        cell(m.expiry || "—", "text"),
        cell(m.payment || "—", "text"),
        cell(m.changedTo || "—", m.changedTo ? "text" : "textMuted"),
        cell(m.note, "textMuted"),
      ]);
    }
    rows.push([
      cell(`Tổng ${d.roster.length} email trong ngày`, "totalText", 3),
      cell(d.roster.reduce((s, m) => s + m.spend, 0), "totalNumOut"),
      cell("", "totalText", 5),
    ]);
  }
  return {
    name: "Email trong ngày",
    freeze: 1,
    cols: [34, 20, 26, 15, 15, 14, 12, 40, 26],
    rows,
  };
}

export function reportSheets(r: WalletReport): XSheet[] {
  return [overviewSheet(r), detailSheet(r), emailSheet(r), rosterSheet(r)];
}

/* ── Đổ ra .csv ────────────────────────────────────────────────────────────── */

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV PHẲNG cùng bộ cột với sheet Chi tiết lệnh, thêm cột "Lệnh" mang số cụm để nạp
 * vào phần mềm kế toán vẫn gom lại được. Không có dải ngày / dòng cộng: CSV là để
 * MÁY đọc, người xem thì mở bản .xlsx.
 *
 * Ngăn cách `;` vì Excel bản Việt đọc CSV theo dấu đó; số giữ nguyên dấu chấm thập
 * phân của JS (VND là số nguyên nên không có phần lẻ).
 */
export function reportCsv(r: WalletReport): string {
  const head = [
    "Ngày",
    "Giờ",
    "Lệnh",
    "Nội dung",
    "Kết quả",
    "Email",
    "Tiền vào (đ)",
    "Tiền ra (đ)",
    "Số dư trước (đ)",
    "Số dư sau (đ)",
    "Mã hoá đơn",
    "Mã GD SePay",
    "Ghi chú",
  ];
  const lines = [head.join(";")];
  for (const d of r.days) {
    for (const c of d.clusters) {
      for (const e of c.entries) {
        lines.push(
          [
            e.date,
            e.time,
            c.label ? `#${c.no}` : "",
            e.label,
            e.outcome,
            e.email,
            e.moneyIn || 0,
            e.moneyOut || 0,
            e.balanceBefore,
            e.balanceAfter,
            e.refCode,
            e.providerTxn,
            e.note,
          ]
            .map(csvCell)
            .join(";"),
        );
      }
    }
  }
  return lines.join("\n");
}

/* ── Tải về ────────────────────────────────────────────────────────────────── */

export function reportFilename(r: WalletReport, ext: "xlsx" | "csv"): string {
  const range =
    r.periodFrom && r.periodFrom !== r.periodTo ? `${r.periodFrom}_${r.periodTo}` : r.periodFrom;
  return `bao-cao-vi-${range || "toan-ky"}.${ext}`;
}

export function downloadReportXlsx(r: WalletReport): void {
  downloadWorkbook(reportFilename(r, "xlsx"), reportSheets(r));
}

export function downloadReportCsv(r: WalletReport): void {
  // BOM để Excel nhận UTF-8, không thì tiếng Việt ra ký tự lạ.
  downloadBlob(
    reportFilename(r, "csv"),
    new Blob([`﻿${reportCsv(r)}`], { type: "text/csv;charset=utf-8" }),
  );
}
