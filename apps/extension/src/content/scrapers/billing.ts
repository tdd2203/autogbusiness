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
 *
 * QUAN TRỌNG: KHÔNG reject case `used > total` (over-limit). ChatGPT cho phép
 * dùng vượt seat plan (vd 14/13) — đó là state hợp lệ cần dashboard biết.
 * Trước v0.4.19 reject case này → scraper bỏ qua "14/13" → pick nhầm ratio
 * khác trên page (vd 11/12 từ invoice / plan section).
 */
const SEAT_RATIO_PATTERNS: RegExp[] = [
  // "Đang dùng 6/8 giấy phép" / "Using 6/8 seats" / "正在使用 6/8"
  /(?:đang\s*dùng|đang\s*sử\s*dụng|sử\s*dụng|using|正在使用|使用中|已\s*使用|使用)\s*[:：]?\s*(\d{1,3})\s*\/\s*(\d{1,3})/i,
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
      used <= SEAT_TOTAL_MAX
      // KHÔNG còn check used <= total — over-limit là state hợp lệ
    ) {
      return { used, total };
    }
  }
  return null;
}

const PLAN_KEYWORDS: Array<{ re: RegExp; plan: string }> = [
  { re: /\bgói\s*enterprise\b|\benterprise\s*plan\b|\benterprise\b|企业版|企业/i, plan: "enterprise" },
  { re: /\bgói\s*business\b|\bbusiness\s*plan\b|\bbusiness\b|商业版|商务/i, plan: "business" },
  { re: /\bgói\s*team\b|\bteam\s*plan\b|\bteam\b|团队版|团队/i, plan: "team" },
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

/**
 * Từ khoá neo cho ngày gia hạn dạng ĐƠN (khi trang KHÔNG hiển thị dạng khoảng).
 * vi: "gia hạn", "thanh toán/đợt/kỳ … tiếp theo"; en: "renews", "next billing/
 * payment/invoice"; zh: "续订/续期/下次…".
 */
const RENEWAL_KEYWORD_RE =
  /gia\s*hạn|tái\s*tục|(?:thanh\s*toán|đợt|kỳ|chu\s*kỳ)[^.]{0,14}tiếp\s*theo|renew|next\s*(?:billing|payment|invoice|charge|bill)|续订|续期|下次(?:付款|扣款|续费|结算)?/i;

/**
 * Suy ISO date từ (month, day[, year]). Year thiếu → suy: nếu (month,day) đã qua
 * trong năm nay → sang năm sau (renewal luôn là tương lai).
 */
function isoFromMonthDay(
  month: number,
  day: number,
  year?: number,
): string | null {
  if (
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const now = new Date();
  let y = year ?? now.getFullYear();
  if (year === undefined) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (Date.UTC(y, month - 1, day) < today.getTime()) y += 1;
  }
  const d = new Date(Date.UTC(y, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Bắt 1 ngày ĐƠN (vi/zh/en, year optional) trong 1 đoạn text ngắn. */
function extractSingleDate(s: string): string | null {
  // ZH: "2026年7月11日" / "7月11日"
  const zh = s.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (zh) {
    const iso = isoFromMonthDay(
      Number(zh[2]),
      Number(zh[3]),
      zh[1] ? Number(zh[1]) : undefined,
    );
    if (iso) return iso;
  }
  // VI: "11 thg 7, 2026" / "11 tháng 7 năm 2026" / "11 thg 7" (year optional)
  const vi = s.match(
    /(\d{1,2})\s*(?:thg|th\.|tháng)\s*(\d{1,2})(?:\s*(?:,|năm)?\s*(\d{4}))?/i,
  );
  if (vi) {
    const iso = isoFromMonthDay(
      Number(vi[2]),
      Number(vi[1]),
      vi[3] ? Number(vi[3]) : undefined,
    );
    if (iso) return iso;
  }
  // EN month-first: "Jul 11, 2026" / "July 11 2026"
  const enMD = s.match(
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/i,
  );
  if (enMD) {
    const month = EN_MONTHS[enMD[1].toLowerCase()];
    const iso = month
      ? isoFromMonthDay(month, Number(enMD[2]), enMD[3] ? Number(enMD[3]) : undefined)
      : null;
    if (iso) return iso;
  }
  // EN day-first: "11 Jul 2026"
  const enDM = s.match(
    /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*(?:\s+(\d{4}))?/i,
  );
  if (enDM) {
    const month = EN_MONTHS[enDM[2].toLowerCase()];
    const iso = month
      ? isoFromMonthDay(month, Number(enDM[1]), enDM[3] ? Number(enDM[3]) : undefined)
      : null;
    if (iso) return iso;
  }
  return null;
}

/** Ngày renew dạng ĐƠN: neo theo từ khoá renew rồi bắt ngày trong cửa sổ ~80 ký tự. */
function parseRenewalSingleDate(rawText: string): string | null {
  const text = rawText.replace(/\s+/g, " ");
  const kw = text.match(RENEWAL_KEYWORD_RE);
  if (!kw || kw.index === undefined) return null;
  const start = Math.max(0, kw.index - 12);
  const win = text.slice(start, kw.index + 80);
  return extractSingleDate(win);
}

function parseRenewalDateVi(text: string): string | null {
  // 1) Dạng KHOẢNG "X - Y" → lấy ngày END (= renewal). ZH trước (đặc trưng hơn).
  const zh = text.match(ZH_MONTH_RE);
  if (zh) {
    const iso = isoFromMonthDay(Number(zh[3]), Number(zh[4]));
    if (iso) return iso;
  }
  const m = text.match(VI_MONTH_RE);
  if (m) {
    const iso = isoFromMonthDay(Number(m[4]), Number(m[3]));
    if (iso) return iso;
  }
  // 2) Fallback: ngày ĐƠN neo theo từ khoá renew (vd "gia hạn vào 11 thg 7, 2026",
  //    "Renews on Jul 11, 2026", "下次续订 2026年7月11日"). Một số plan KHÔNG hiển
  //    thị dạng khoảng chu kỳ → trước đây renewal về null → dashboard giá "—".
  return parseRenewalSingleDate(text);
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

/** Chỉ parse VND — field DB là `amount_vnd`. USD/CNY parse nhầm scale (×100 cents). */
function parseVndAmount(text: string): number | null {
  const trimmed = text.trim();
  const m = trimmed.match(CURRENCY_RE_LIST[0].re);
  if (!m) return null;
  const digits = m[1].replace(/[.,\s]/g, "");
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n) || n < 10_000 || n > 1_000_000_000) return null;
  return n;
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

  const root =
    document.querySelector("main") ??
    document.querySelector("[role='main']") ??
    document.body;
  const leaves = root.querySelectorAll<HTMLElement>("*");
  for (const el of Array.from(leaves)) {
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? "").trim();
    const amount = parseVndAmount(text);
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
        } else if (
          // Check UNPAID/VOID TRƯỚC "paid": chuỗi "unpaid" chứa substring "paid"
          // nên nếu check /paid/ trước sẽ gán nhầm "đã thanh toán". "void" =
          // hoá đơn bị huỷ/không hợp lệ (vd add-seat huỷ giữa kỳ) → coi như
          // CHƯA thanh toán; dashboard chỉ tính giá trên hoá đơn paid.
          /chưa\s*thanh\s*toán|unpaid|past\s*due|overdue|void|đã\s*hủy|đã\s*huỷ|cancell?ed|未\s*付款|未支付|逾期|作废|已作废/i.test(
            innerText,
          )
        ) {
          status = "unpaid";
        } else if (/đã\s*thanh\s*toán|\bpaid\b|已\s*付款|已支付/i.test(innerText)) {
          status = "paid";
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

export function scrapeBillingFromDom(options?: { includeInvoices?: boolean }): ScrapedBilling {
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
  const includeInvoices = options?.includeInvoices !== false;
  const invoices = includeInvoices ? scrapeInvoices() : [];

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
