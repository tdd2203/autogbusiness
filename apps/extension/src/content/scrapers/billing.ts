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
  // "Đang dùng 6/8 giấy phép"  /  "đang sử dụng 6/8"  /  "dùng 6 / 8"
  /(?:dùng|sử\s*dụng|using)\s+(\d{1,3})\s*\/\s*(\d{1,3})/i,
  // "6/8 giấy phép" / "6/8 chỗ ngồi" / "6/8 seats" / "6/8 licenses"
  /(\d{1,3})\s*\/\s*(\d{1,3})\s*(?:giấy\s*phép|chỗ\s*ngồi|seats?|licenses?)/i,
  // "6 of 8 seats" / "6 trên 8"
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

const UNPAID_RE = /chưa\s*thanh\s*toán|quá\s*hạn|unpaid|past\s*due|overdue|payment\s*required/i;
const PAID_RE = /đã\s*thanh\s*toán|active|paid|hoạt\s*động/i;

function parseBillingStatus(text: string): "PAID" | "UNPAID" | "UNKNOWN" | null {
  if (UNPAID_RE.test(text)) return "UNPAID";
  if (PAID_RE.test(text)) return "PAID";
  return null;
}

// Match cụm "11 thg 5 - 11 thg 6", "May 11 - Jun 11", "11/5 - 11/6"
const VI_MONTH_RE =
  /(\d{1,2})\s*(?:thg|th\.|tháng)\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:thg|th\.|tháng)\s*(\d{1,2})/i;

function parseRenewalDateVi(text: string): string | null {
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
 * Match cụm date format vi đầy đủ: "DD thg M, YYYY" (vd "17 thg 5, 2026").
 * Khác với VI_MONTH_RE: yêu cầu có năm + dấu phẩy.
 */
const INVOICE_DATE_RE = /^(\d{1,2})\s+(?:thg|tháng)\s+(\d{1,2}),\s+(\d{4})$/i;

/**
 * Match số tiền VND: "230.535 ₫" / "573.100 đ" / "1,234,567 ₫" / "230535₫".
 * Dấu chấm/phẩy là phân cách hàng nghìn (vi format).
 */
const VND_RE = /^([\d.,]+)\s*[₫đ]$/i;

function parseVnd(text: string): number | null {
  const m = text.trim().match(VND_RE);
  if (!m) return null;
  // Loại dấu chấm/phẩy phân cách hàng nghìn (vi không dùng decimal cho VND)
  const digits = m[1].replace(/[.,\s]/g, "");
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
  return n;
}

function parseInvoiceDate(text: string): string | null {
  const m = text.trim().match(INVOICE_DATE_RE);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (year < 2020 || year > 2100) return null;
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
    const amount = parseVnd(text);
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
