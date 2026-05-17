/**
 * Scrape thông tin billing từ ChatGPT Business admin /admin/billing.
 *
 * Cần lấy:
 *   - plan: "business" | "enterprise" | "team" | ...
 *   - seat_total: tổng số ghế đã thanh toán (vd 8)
 *   - seat_used:  số ghế đang dùng (vd 6)
 *   - billing_status: PAID | UNPAID
 *   - renewal_date: kỳ hạn tiếp theo
 *
 * Trang hiện hiển thị (tiếng Việt):
 *   "Suất sử dụng ChatGPT  ...  Đang dùng 6/8 giấy phép"
 *   "Gói Business" (hoặc Enterprise/Team)
 *   "Chu kỳ hiện tại: 11 thg 5 - 11 thg 6"
 *
 * Vì OpenAI thay đổi UI thường xuyên, mọi field optional + nhiều regex fallback.
 * KHÔNG đoán DOM — chỉ trust text content visible trên trang.
 */

export type ScrapedInvoice = {
  /** ISO date (UTC midnight) — vd "2026-05-17T00:00:00.000Z". */
  date: string;
  /** Amount tiền VND (đã trim ký tự ₫ và dấu chấm phân cách hàng nghìn). */
  amount_vnd: number;
  /** "paid" | "unpaid" | "unknown". */
  status: string;
};

export type ScrapedBilling = {
  plan: string | null;
  seat_total: number | null;
  seat_used: number | null;
  billing_status: "PAID" | "UNPAID" | "UNKNOWN" | null;
  renewal_date: string | null; // ISO 8601
  /** Lịch sử hoá đơn — list các transactions trên trang /admin/billing. */
  invoices: ScrapedInvoice[];
};

const SEAT_TOTAL_MAX = 999;

/**
 * Regex match "Đang dùng X/Y giấy phép" (vi) / "Using X/Y seats" (en) /
 * "X / Y licenses" / "X of Y seats".
 *
 * Pattern phải tránh false-match từ "5/16/2026" (date). Vì vậy ta yêu cầu
 * từ khoá xung quanh: dùng|using|seat|license|ghế|giấy phép|chỗ ngồi.
 */
const SEAT_RATIO_PATTERNS: RegExp[] = [
  // "Đang dùng 6/8 giấy phép" / "Using 6/8 seats" / "正在使用 6/8"
  /(?:dùng|sử\s*dụng|using|正在使用|使用中|使用)\s*[:：]?\s*(\d{1,3})\s*\/\s*(\d{1,3})/i,
  // "6/8 giấy phép" / "6/8 seats" / "6/8 个席位" / "6/8 个许可证"
  /(\d{1,3})\s*\/\s*(\d{1,3})\s*(?:giấy\s*phép|chỗ\s*ngồi|seats?|licenses?|个\s*席位|个\s*许可证|席位|许可证)/i,
  // "6 of 8 seats" / "6 trên 8 giấy phép"
  /(\d{1,3})\s*(?:of|trên)\s*(\d{1,3})\s*(?:giấy\s*phép|chỗ\s*ngồi|seats?|licenses?)/i,
];

function parseSeatRatio(text: string): { used: number; total: number } | null {
  for (const re of SEAT_RATIO_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const used = Number(m[1]);
    const total = Number(m[2]);
    if (
      Number.isFinite(used) &&
      Number.isFinite(total) &&
      used >= 0 &&
      total >= 0 &&
      total <= SEAT_TOTAL_MAX &&
      used <= total
    ) {
      return { used, total };
    }
  }
  return null;
}

const PLAN_KEYWORDS: Array<{ re: RegExp; plan: string }> = [
  { re: /\bgói\s*enterprise\b|\benterprise\s*plan\b|\benterprise\b/i, plan: "enterprise" },
  { re: /\bgói\s*business\b|\bbusiness\s*plan\b|\bbusiness\b/i, plan: "business" },
  { re: /\bgói\s*team\b|\bteam\s*plan\b|\bteam\b/i, plan: "team" },
];

function parsePlan(text: string): string | null {
  for (const { re, plan } of PLAN_KEYWORDS) {
    if (re.test(text)) return plan;
  }
  return null;
}

const UNPAID_RE = /chưa\s*thanh\s*toán|quá\s*hạn|unpaid|past\s*due|overdue|payment\s*required|未\s*付款|未支付|逾期/i;
const PAID_RE = /đã\s*thanh\s*toán|active|paid|hoạt\s*động|已\s*付款|已支付|活跃/i;

function parseBillingStatus(text: string): "PAID" | "UNPAID" | "UNKNOWN" | null {
  if (UNPAID_RE.test(text)) return "UNPAID";
  if (PAID_RE.test(text)) return "PAID";
  return null;
}

// Match cụm "11 thg 5 - 11 thg 6", "11 月 5 日 - 11 月 6 日", "May 11 - Jun 11"
const VI_MONTH_RE =
  /(\d{1,2})\s*(?:thg|th\.|tháng)\s*(\d{1,2})\s*[-–—~]\s*(\d{1,2})\s*(?:thg|th\.|tháng)\s*(\d{1,2})/i;
// Chinese: "2026年5月11日 - 2026年6月11日" or "5月11日 - 6月11日"
const ZH_MONTH_RE =
  /(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*[-–—~]\s*(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/;

function parseRenewalDateVi(text: string): string | null {
  // Try ZH format first (more specific)
  const zh = text.match(ZH_MONTH_RE);
  if (zh) {
    const endMonth = Number(zh[3]);
    const endDay = Number(zh[4]);
    const now = new Date();
    let year = now.getFullYear();
    if (endMonth < now.getMonth() + 1) year += 1;
    const d = new Date(Date.UTC(year, endMonth - 1, endDay));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const m = text.match(VI_MONTH_RE);
  if (!m) return null;
  const endDay = Number(m[3]);
  const endMonth = Number(m[4]);
  const now = new Date();
  let year = now.getFullYear();
  // Nếu tháng end < tháng hiện tại → sang năm sau
  if (endMonth < now.getMonth() + 1) year += 1;
  const d = new Date(Date.UTC(year, endMonth - 1, endDay));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Match cụm date format đa ngôn ngữ:
 *   vi: "17 thg 5, 2026" / "17 tháng 5, 2026"
 *   zh: "2026年5月17日" / "5月17日 2026"
 *   en: "May 17, 2026" / "17 May 2026"
 */
const INVOICE_DATE_VI_RE = /^(\d{1,2})\s+(?:thg|tháng)\s+(\d{1,2}),\s+(\d{4})$/i;
const INVOICE_DATE_ZH_RE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/;
const INVOICE_DATE_EN_RE =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2}),?\s+(\d{4})$/i;
const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Match số tiền đa currency:
 *   VND: "230.535 ₫" / "573.100 đ" — chấm = thousands sep, không decimal
 *   USD: "$25.00" / "$1,234.56" — dấu phẩy = thousands, chấm = decimal
 *   CNY: "¥123.45" / "￥123" / "RMB 123"
 *
 * Trả về integer "đơn vị tiền tệ nhỏ nhất" (VND/yuan integer; USD cents).
 * Để simple: USD và CNY round int (bỏ decimal); VND giữ nguyên.
 */
const CURRENCY_RE_LIST: Array<{ re: RegExp; kind: "vnd" | "usd" | "cny" }> = [
  // VND: "230.535 ₫"
  { re: /^([\d.,]+)\s*[₫đ]$/i, kind: "vnd" },
  // USD: "$25.00" or "$1,234.56"
  { re: /^\$\s*([\d,.]+)$/i, kind: "usd" },
  // CNY: "¥25.00" / "￥25" / "RMB 25"
  { re: /^[¥￥]\s*([\d,.]+)$/i, kind: "cny" },
  { re: /^rmb\s+([\d,.]+)$/i, kind: "cny" },
];

function parseCurrencyAmount(text: string): number | null {
  const trimmed = text.trim();
  for (const { re, kind } of CURRENCY_RE_LIST) {
    const m = trimmed.match(re);
    if (!m) continue;
    if (kind === "vnd") {
      const digits = m[1].replace(/[.,\s]/g, "");
      const n = parseInt(digits, 10);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
      return n;
    }
    // USD / CNY: chấm là decimal, phẩy là thousands. Bỏ decimal (round).
    // Convert sang VND equivalent? Không — giữ giá trị nguyên, lưu kèm currency
    // không cần thiết cho display admin. Multiply USD/CNY ×1 để admin tự
    // hiểu đơn vị qua context. Round to int.
    const cleaned = m[1].replace(/,/g, "");
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
    // Multiply by 100 nếu USD/CNY để tránh mất decimal (lưu cents/fen)
    return Math.round(n * 100);
  }
  return null;
}

function parseInvoiceDate(text: string): string | null {
  const t = text.trim();
  // VI
  const vi = t.match(INVOICE_DATE_VI_RE);
  if (vi) {
    return toIsoDate(parseInt(vi[3], 10), parseInt(vi[2], 10), parseInt(vi[1], 10));
  }
  // ZH
  const zh = t.match(INVOICE_DATE_ZH_RE);
  if (zh) {
    return toIsoDate(parseInt(zh[1], 10), parseInt(zh[2], 10), parseInt(zh[3], 10));
  }
  // EN
  const en = t.match(INVOICE_DATE_EN_RE);
  if (en) {
    const month = EN_MONTHS[en[1].toLowerCase()];
    if (month) return toIsoDate(parseInt(en[3], 10), month, parseInt(en[2], 10));
  }
  return null;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Scrape danh sách invoices từ bảng "Hoá đơn" trên /admin/billing.
 *
 * Heuristic: tìm các leaf element chứa VND amount → walk up tới row → trong
 * cùng row tìm leaf chứa date format. Không yêu cầu cấu trúc table chính xác
 * vì ChatGPT có thể dùng flexbox row layout.
 */
function scrapeInvoices(): ScrapedInvoice[] {
  const out: ScrapedInvoice[] = [];
  const seen = new Set<string>(); // dedup theo date+amount

  const leaves = document.querySelectorAll<HTMLElement>("*");
  for (const el of Array.from(leaves)) {
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? "").trim();
    const amount = parseCurrencyAmount(text);
    if (amount === null) continue;

    // Walk up tìm row chứa cả date
    let row: HTMLElement = el;
    let date: string | null = null;
    let status = "unknown";

    for (let i = 0; i < 6 && row.parentElement; i++) {
      // Tìm date leaf trong row hiện tại
      const innerLeaves = row.querySelectorAll<HTMLElement>("*");
      for (const inner of Array.from(innerLeaves)) {
        if (inner.children.length > 0) continue;
        const innerText = (inner.textContent ?? "").trim();
        const d = parseInvoiceDate(innerText);
        if (d) {
          date = d;
        } else if (/đã\s*thanh\s*toán|paid/i.test(innerText)) {
          status = "paid";
        } else if (/chưa\s*thanh\s*toán|unpaid|past\s*due/i.test(innerText)) {
          status = "unpaid";
        }
      }
      if (date) break;
      row = row.parentElement;
    }

    if (!date) continue;
    const key = `${date}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, amount_vnd: amount, status });
  }
  return out;
}

export function scrapeBillingFromDom(): ScrapedBilling {
  // Toàn bộ text visible của main content. Đơn giản nhưng đủ cho regex.
  const main =
    document.querySelector("main") ??
    document.querySelector("[role='main']") ??
    document.body;
  const text = main?.textContent ?? "";

  const ratio = parseSeatRatio(text);
  const plan = parsePlan(text);
  const billing_status = parseBillingStatus(text);
  const renewal_date = parseRenewalDateVi(text);
  const invoices = scrapeInvoices();

  return {
    plan,
    seat_total: ratio?.total ?? null,
    seat_used: ratio?.used ?? null,
    billing_status,
    renewal_date,
    invoices,
  };
}

// Export pure helpers để test
export const __internal = {
  parseSeatRatio,
  parsePlan,
  parseBillingStatus,
  parseRenewalDateVi,
};
