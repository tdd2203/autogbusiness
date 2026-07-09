/**
 * Scrape CHÍNH XÁC trang chi tiết hoá đơn Stripe (invoice.stripe.com).
 *
 * Thay cho việc đoán số seat bằng phép chia tổng tiền (bug với workspace >10
 * seat / giá >400k). Panel "Xem chi tiết hoá đơn" (bản tiếng Việt) hiển thị:
 *   25 THÁNG 6 - 25 THÁNG 7, 2026
 *   ChatGPT Business Subscription (per seat)        9.117.500 đ
 *   Số lượng 35                       Mỗi 260.500 đ
 *   Tổng phụ                                        9.117.500 đ
 *   Tổng không bao gồm thuế                         9.117.500 đ
 *   VAT – Vietnam (10%)                               911.750 đ
 *   Số tiền đến hạn                              10.029.250 đ
 *   Số hoá đơn  MSNS6RGC-0024
 *
 * ⚠️ textContent nối các ô cạnh nhau KHÔNG có khoảng trắng ("Số lượng 35" +
 * line-total "9.117.500" → "Số lượng 359.117.500"), và có nhãn nhập nhằng
 * ("per" trong "(per seat)", "thuế" trong "không bao gồm thuế"). Vì vậy:
 *   - Đơn giá: neo nhãn "Mỗi" (KHÔNG dùng "per").
 *   - Subtotal/Total: neo nhãn riêng ("Tổng phụ", "Số tiền đến hạn").
 *   - Số lượng: SUY = subtotal ÷ unit_price (chính xác, tránh lỗi nối số).
 *   - VAT: = total − subtotal.
 * Fail an toàn (trả null) khi không đọc được thay vì đoán (Hiến pháp III).
 */

import type { ScrapedInvoiceDetail } from "../../shared/messages";

const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function toIso(year: number, month: number, day: number): string | null {
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Chuẩn hoá chuỗi số VND ("9.117.500") → integer 9117500 (bỏ . , khoảng trắng). */
function stripVnd(s: string): number | null {
  const n = parseInt(s.replace(/[.,\s]/g, ""), 10);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
  return n;
}

/**
 * Token tiền VND trong đoạn text ngắn. VND: dấu chấm = phân cách hàng nghìn,
 * KHÔNG thập phân, KHÔNG có khoảng trắng giữa chữ số → class chỉ digit + dấu chấm
 * để không nuốt lấn token kế. Trả integer hoặc null.
 */
function firstVndInWindow(win: string): number | null {
  const m = win.match(/([\d][\d.]*\d|\d)\s*[₫đ]/);
  return m ? stripVnd(m[1]) : null;
}

/** Số tiền VND xuất hiện NGAY SAU 1 nhãn (cửa sổ ~48 ký tự). */
function amountAfterLabel(text: string, labelRe: RegExp): number | null {
  const m = text.match(labelRe);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  return firstVndInWindow(text.slice(start, start + 48));
}

/**
 * Đơn giá/seat pre-VAT. Neo nhãn KHÔNG nhập nhằng:
 *   vi: "Mỗi 260.500 đ" · en: "260,500 each" / "… /seat" · zh: "每 260.500".
 * KHÔNG dùng "per" (nuốt nhầm "(per seat)").
 */
function parseUnitPrice(text: string): number | null {
  const vi = text.match(/(?:mỗi|每)\s*([\d][\d.]*\d|\d)\s*[₫đ]/i);
  if (vi) return stripVnd(vi[1]);
  const en = text.match(/([\d][\d.,]*\d|\d)\s*[₫đ$]?\s*(?:each|\/\s*seat)/i);
  if (en) return stripVnd(en[1]);
  return null;
}

/**
 * Số seat trên hoá đơn TRUE-UP (điều chỉnh seat giữa kỳ, prorated). Các dòng
 * dạng "Remaining time on 148 × ChatGPT Business Subscription after 22 Jun 2026"
 * (mô tả bằng tiếng Anh kể cả trên trang VI). Lấy N LỚN NHẤT ở dòng "Remaining
 * time on N ×" = số seat mới nhất/hiện tại sau true-up. Bỏ qua dòng "Unused
 * time on N" (credit — số seat CŨ).
 */
function parseSeatsFromTrueUp(text: string): number | null {
  const re = /remaining\s+time\s+on\s+(\d{1,6})\s*[×xX*]/gi;
  let m: RegExpExecArray | null;
  let max: number | null = null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * Số lượng seat của hoá đơn:
 *   1. Hoá đơn gia hạn/mua đơn giản: SUY = subtotal ÷ unit_price (chính xác).
 *   2. Hoá đơn true-up: số seat = 'Remaining time on N ×' lớn nhất.
 *   3. Fallback: 'Số lượng N' đơn (chặn dính chữ số).
 */
function parseQuantity(
  text: string,
  subtotal: number | null,
  unitPrice: number | null,
): number | null {
  if (subtotal !== null && unitPrice && unitPrice > 0) {
    const q = Math.round(subtotal / unitPrice);
    if (q > 0 && q <= 1_000_000 && Math.abs(q * unitPrice - subtotal) <= unitPrice) {
      return q;
    }
  }
  const trueUp = parseSeatsFromTrueUp(text);
  if (trueUp !== null) return trueUp;
  const m = text.match(
    /(?:số\s*lượng|quantity|qty|数量)\s*[:：]?\s*(\d{1,6})(?![\d.,])/i,
  );
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 1_000_000) return n;
  }
  return null;
}

/** Subtotal pre-VAT: "Tổng phụ" (ưu tiên) hoặc "Tổng không bao gồm thuế". */
function parseSubtotal(text: string): number | null {
  return (
    amountAfterLabel(text, /tổng\s*phụ|subtotal|小计/i) ??
    amountAfterLabel(
      text,
      /tổng\s*không\s*bao\s*gồm\s*thuế|total\s*excluding\s*tax|不含税/i,
    )
  );
}

/** Tổng đến hạn: "Số tiền đến hạn" hoặc "Số tiền đã thanh toán". */
function parseTotal(text: string): number | null {
  return (
    amountAfterLabel(
      text,
      /số\s*tiền\s*đến\s*hạn|amount\s*due|应付金额/i,
    ) ??
    amountAfterLabel(
      text,
      /số\s*tiền\s*đã\s*thanh\s*toán|amount\s*paid|已付金额/i,
    )
  );
}

/** Khoảng chu kỳ dịch vụ trên hoá đơn → {period_start, period_end} ISO. */
function parsePeriod(text: string): { start: string | null; end: string | null } {
  // VI: "25 THÁNG 6 - 25 THÁNG 7, 2026" (năm ở cuối; /i để khớp THÁNG hoa)
  const vi = text.match(
    /(\d{1,2})\s*(?:thg|tháng)\s*(\d{1,2})\s*[-–—~]\s*(\d{1,2})\s*(?:thg|tháng)\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?/i,
  );
  if (vi) {
    const [d1, m1, d2, m2] = [Number(vi[1]), Number(vi[2]), Number(vi[3]), Number(vi[4])];
    const year = vi[5] ? Number(vi[5]) : new Date().getUTCFullYear();
    const startYear = m1 > m2 ? year - 1 : year;
    return { start: toIso(startYear, m1, d1), end: toIso(year, m2, d2) };
  }
  // EN month-first: "Jun 25 - Jul 25, 2026"
  const en = text.match(
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2})\s*[-–—~]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/i,
  );
  if (en) {
    const m1 = EN_MONTHS[en[1].toLowerCase()];
    const m2 = EN_MONTHS[en[3].toLowerCase()];
    const year = en[5] ? Number(en[5]) : new Date().getUTCFullYear();
    const startYear = m1 > m2 ? year - 1 : year;
    return { start: toIso(startYear, m1, Number(en[2])), end: toIso(year, m2, Number(en[4])) };
  }
  // ZH: "2026年6月25日 - 2026年7月25日"
  const zh = text.match(
    /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*[-–—~至]\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/,
  );
  if (zh) {
    const endYear = zh[4] ? Number(zh[4]) : zh[1] ? Number(zh[1]) : new Date().getUTCFullYear();
    const m1 = Number(zh[2]);
    const m2 = Number(zh[5]);
    const startYear = zh[1] ? Number(zh[1]) : m1 > m2 ? endYear - 1 : endYear;
    return { start: toIso(startYear, m1, Number(zh[3])), end: toIso(endYear, m2, Number(zh[6])) };
  }
  return { start: null, end: null };
}

/**
 * Số hoá đơn dạng "MSNS6RGC-0024". Bắt token CHỮ HOA/số + dash + CHỈ chữ số
 * (case-sensitive để không nuốt "Ng" của "Ngày" đứng liền sau).
 */
function parseInvoiceNumber(text: string): string | null {
  const m = text.match(/\b([A-Z0-9]{4,}-\d{3,6})\b/);
  return m ? m[1] : null;
}

function parseStatus(text: string): ScrapedInvoiceDetail["status"] {
  if (/void|đã\s*hu[ỷỵ]|đã\s*hủy|cancell?ed|作废|已作废/i.test(text)) return "void";
  if (/chưa\s*thanh\s*toán|unpaid|past\s*due|overdue|quá\s*hạn|未\s*付款|未支付|逾期/i.test(text)) {
    return "unpaid";
  }
  if (/hoá\s*đơn\s*đã\s*thanh\s*toán|đã\s*thanh\s*toán|\bpaid\b|已\s*付款|已支付/i.test(text)) {
    return "paid";
  }
  return "unknown";
}

/**
 * Scrape toàn bộ trường chi tiết từ DOM trang hoá đơn Stripe hiện tại (panel
 * "Xem chi tiết hoá đơn" phải đang mở).
 */
export function scrapeInvoiceDetailFromDom(): ScrapedInvoiceDetail {
  const raw = document.body?.textContent ?? "";
  const text = raw.replace(/\s+/g, " ").trim();

  const unit_price_vnd = parseUnitPrice(text);
  const subtotal_vnd = parseSubtotal(text);
  const total_vnd = parseTotal(text);
  const quantity = parseQuantity(text, subtotal_vnd, unit_price_vnd);
  // VAT = total − subtotal (chắc chắn hơn parse nhãn "thuế" nhập nhằng).
  const vat_vnd =
    total_vnd !== null && subtotal_vnd !== null && total_vnd >= subtotal_vnd
      ? total_vnd - subtotal_vnd
      : amountAfterLabel(text, /vat\s*[–\-—]?\s*[a-zà-ỹ]*\s*\(?\d+%\)?/i);
  const { start: period_start, end: period_end } = parsePeriod(text);
  const invoice_number = parseInvoiceNumber(text);
  const status = parseStatus(text);

  return {
    quantity,
    unit_price_vnd,
    subtotal_vnd,
    vat_vnd,
    total_vnd,
    period_start,
    period_end,
    invoice_number,
    status,
  };
}

/**
 * Đọc được đủ để coi là "detail_scraped" chưa? Chỉ cần SỐ SEAT (quantity):
 *   - Hoá đơn gia hạn: có cả quantity + unit_price.
 *   - Hoá đơn true-up: có quantity (từ 'Remaining time on N') nhưng unit_price=null.
 * Đơn giá null vẫn hợp lệ — giá/seat lấy từ hoá đơn gốc kỳ (billing-math phía web).
 */
export function isDetailUsable(d: ScrapedInvoiceDetail): boolean {
  return d.quantity !== null;
}

// Export pure helpers để test.
export const __internal = {
  parseUnitPrice,
  parseQuantity,
  parseSubtotal,
  parseTotal,
  parsePeriod,
  parseInvoiceNumber,
  parseStatus,
  firstVndInWindow,
  amountAfterLabel,
};
