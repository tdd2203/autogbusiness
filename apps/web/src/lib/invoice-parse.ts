/**
 * Parse text CHI TIẾT HOÁ ĐƠN Stripe do người dùng DÁN vào (popup "Cập nhật giá").
 *
 * Khác với scraper trong extension (đọc từ DOM — các ô số DÍNH liền nhau, vd
 * "Số lượng 4611.983.000"), text DÁN có xuống dòng → sau khi gộp khoảng trắng các
 * số TÁCH nhau ("Số lượng 46 11.983.000 ₫"). Vì vậy parseQuantity ở đây thử NHIỀU
 * cách để chắc chắn lấy đúng số seat của dòng "(per seat)":
 *   1. Tách chuỗi dính "Số lượng {seat}{line-total}" (nếu dán từ nguồn dính).
 *   2. "Số lượng N" ngay sau "(per seat)" (text dán có khoảng trắng).
 *   3. Số tiền chia HẾT cho đơn giá (line-total dòng trọn tháng = seat×đơn giá).
 *   4. subtotal ÷ đơn giá (hoá đơn đơn giản, không proration).
 * Fail an toàn: trả null từng field khi không đọc được.
 */

const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export type ParsedInvoice = {
  quantity: number | null;
  unit_price_vnd: number | null;
  subtotal_vnd: number | null;
  vat_vnd: number | null;
  total_vnd: number | null;
  period_start: string | null;
  period_end: string | null;
  invoice_number: string | null;
  status: string;
  /** Ngày thanh toán (ISO) — từ "Đã thanh toán vào ngày …" / "Ngày thanh toán …". */
  date: string | null;
  /** = total_vnd (số tiền hoá đơn, gồm VAT) — cho danh sách hoá đơn. */
  amount_vnd: number | null;
};

function toIso(year: number, month: number, day: number): string | null {
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stripVnd(s: string): number | null {
  const n = parseInt(s.replace(/[.,\s]/g, ""), 10);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
  return n;
}

function firstVndInWindow(win: string): number | null {
  const m = win.match(/([\d][\d.]*\d|\d)\s*[₫đ]/);
  return m ? stripVnd(m[1]) : null;
}

function amountAfterLabel(text: string, labelRe: RegExp): number | null {
  const m = text.match(labelRe);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  return firstVndInWindow(text.slice(start, start + 48));
}

/** Đơn giá/seat pre-VAT từ nhãn "Mỗi" / "每" / "each" / "/seat". */
function parseUnitPrice(text: string): number | null {
  const vi = text.match(/(?:mỗi|每)\s*([\d][\d.]*\d|\d)\s*[₫đ]/i);
  if (vi) return stripVnd(vi[1]);
  const en = text.match(/([\d][\d.,]*\d|\d)\s*[₫đ$]?\s*(?:each|\/\s*seat)/i);
  if (en) return stripVnd(en[1]);
  return null;
}

/** Subtotal: "Tổng phụ" (ưu tiên) hoặc "Tổng không bao gồm thuế". */
function parseSubtotal(text: string): number | null {
  return (
    amountAfterLabel(text, /tổng\s*phụ|subtotal|小计/i) ??
    amountAfterLabel(
      text,
      /tổng\s*không\s*bao\s*gồm\s*thuế|total\s*excluding\s*tax|不含税/i,
    )
  );
}

/** Tổng đến hạn: "Số tiền đến hạn" / "Số tiền đã thanh toán". */
function parseTotal(text: string): number | null {
  return (
    amountAfterLabel(text, /số\s*tiền\s*đến\s*hạn|amount\s*due|应付金额/i) ??
    amountAfterLabel(
      text,
      /số\s*tiền\s*đã\s*thanh\s*toán|amount\s*paid|已付金额/i,
    )
  );
}

/** Số seat true-up: 'Remaining time on N ×' lớn nhất. */
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

/** Tách chuỗi DÍNH "Số lượng {seat}{line-total}" (nguồn DOM). */
function parseFullMonthSeatGlued(text: string, unit: number | null): number | null {
  if (!unit || unit <= 0) return null;
  const re = /(?:số\s*lượng|quantity|数量)\s*[:：]?\s*(\d[\d.]*\d|\d)/gi;
  let m: RegExpExecArray | null;
  let best: number | null = null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1].replace(/\./g, "");
    for (let k = 1; k < digits.length; k++) {
      const seat = Number(digits.slice(0, k));
      const rest = Number(digits.slice(k));
      if (seat > 0 && seat <= 100_000 && rest === seat * unit) {
        best = seat;
        break;
      }
    }
  }
  return best;
}

/** "Số lượng N" ngay sau "(per seat)" (text dán có khoảng trắng). */
function parseSeatNearPerSeat(text: string): number | null {
  const idx = text.search(/\(?\s*per\s*seat\s*\)?/i);
  if (idx < 0) return null;
  const win = text.slice(idx, idx + 90);
  const m = win.match(/(?:số\s*lượng|quantity|数量)\s*[:：]?\s*(\d{1,6})(?!\d)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= 100_000 ? n : null;
}

/** Số tiền LỚN NHẤT (≠ đơn giá) chia HẾT cho đơn giá = line-total dòng trọn tháng
 * → seat = line-total ÷ đơn giá. Dùng cho text dán (số tiền tách, không dính). */
function parseSeatByDivisibleAmount(text: string, unit: number | null): number | null {
  if (!unit || unit <= 0) return null;
  const amounts = [...text.matchAll(/([\d][\d.]*\d|\d)\s*[₫đ]/g)]
    .map((m) => stripVnd(m[1]))
    .filter((n): n is number => n !== null);
  let best: number | null = null;
  for (const a of amounts) {
    if (a === unit) continue; // bỏ chính dòng "Mỗi {đơn giá}"
    if (a % unit !== 0) continue;
    const seat = a / unit;
    if (seat >= 1 && seat <= 100_000 && (best === null || a > best * unit)) {
      best = seat;
    }
  }
  return best;
}

function parseQuantity(
  text: string,
  subtotal: number | null,
  unitPrice: number | null,
): number | null {
  return (
    parseFullMonthSeatGlued(text, unitPrice) ??
    parseSeatNearPerSeat(text) ??
    parseSeatByDivisibleAmount(text, unitPrice) ??
    (() => {
      if (subtotal !== null && unitPrice && unitPrice > 0) {
        const q = Math.round(subtotal / unitPrice);
        if (q > 0 && q <= 1_000_000 && Math.abs(q * unitPrice - subtotal) <= unitPrice) {
          return q;
        }
      }
      return null;
    })() ??
    parseSeatsFromTrueUp(text) ??
    (() => {
      const m = text.match(
        /(?:số\s*lượng|quantity|qty|数量)\s*[:：]?\s*(\d{1,6})(?![\d.,])/i,
      );
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0 && n <= 1_000_000) return n;
      }
      return null;
    })()
  );
}

type Period = { start: string | null; end: string | null };

function parseAllPeriods(text: string): Period[] {
  const out: Period[] = [];
  const curYear = new Date().getUTCFullYear();

  const viRe =
    /(\d{1,2})\s*(?:thg|tháng)\s*(\d{1,2})\s*[-–—~]\s*(\d{1,2})\s*(?:thg|tháng)\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?/gi;
  for (const m of text.matchAll(viRe)) {
    const [d1, mo1, d2, mo2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    const year = m[5] ? Number(m[5]) : curYear;
    const startYear = mo1 > mo2 ? year - 1 : year;
    out.push({ start: toIso(startYear, mo1, d1), end: toIso(year, mo2, d2) });
  }

  const enRe =
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2})\s*[-–—~]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/gi;
  for (const m of text.matchAll(enRe)) {
    const mo1 = EN_MONTHS[m[1].toLowerCase()];
    const mo2 = EN_MONTHS[m[3].toLowerCase()];
    const year = m[5] ? Number(m[5]) : curYear;
    const startYear = mo1 > mo2 ? year - 1 : year;
    out.push({ start: toIso(startYear, mo1, Number(m[2])), end: toIso(year, mo2, Number(m[4])) });
  }

  const zhRe =
    /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*[-–—~至]\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
  for (const m of text.matchAll(zhRe)) {
    const endYear = m[4] ? Number(m[4]) : m[1] ? Number(m[1]) : curYear;
    const mo1 = Number(m[2]);
    const mo2 = Number(m[5]);
    const startYear = m[1] ? Number(m[1]) : mo1 > mo2 ? endYear - 1 : endYear;
    out.push({ start: toIso(startYear, mo1, Number(m[3])), end: toIso(endYear, mo2, Number(m[6])) });
  }

  return out;
}

/** Chu kỳ dịch vụ CHÍNH = khoảng có END MUỘN NHẤT (dòng "(per seat)" trọn tháng). */
function parsePeriod(text: string): Period {
  const ranges = parseAllPeriods(text);
  let best: Period = { start: null, end: null };
  for (const r of ranges) {
    if (r.end && (best.end === null || r.end > best.end)) best = r;
  }
  return best;
}

function parseInvoiceNumber(text: string): string | null {
  const m = text.match(/\b([A-Z0-9]{4,}-\d{3,6})\b/);
  return m ? m[1] : null;
}

function parseStatus(text: string): string {
  if (/void|đã\s*hu[ỷỵ]|đã\s*hủy|cancell?ed|作废|已作废/i.test(text)) return "void";
  if (/chưa\s*thanh\s*toán|unpaid|past\s*due|overdue|quá\s*hạn|未\s*付款|未支付|逾期/i.test(text)) {
    return "unpaid";
  }
  if (/đã\s*thanh\s*toán|\bpaid\b|已\s*付款|已支付/i.test(text)) return "paid";
  return "unknown";
}

/** Ngày thanh toán: "Đã thanh toán vào ngày 25 thg 7, 2026" / "Ngày thanh toán 25 tháng 7, 2026". */
function parsePaidDate(text: string): string | null {
  // Neo theo từ khoá thanh toán rồi bắt 1 ngày trong cửa sổ ~40 ký tự.
  const kw = text.match(/(?:đã\s*thanh\s*toán\s*vào\s*ngày|ngày\s*thanh\s*toán|paid\s*on|payment\s*date)/i);
  const scope = kw && kw.index !== undefined ? text.slice(kw.index, kw.index + 50) : text;
  // VI "25 thg 7, 2026" / "25 tháng 7, 2026"
  const vi = scope.match(/(\d{1,2})\s*(?:thg|tháng)\s*(\d{1,2})\s*,?\s*(\d{4})/i);
  if (vi) return toIso(Number(vi[3]), Number(vi[2]), Number(vi[1]));
  // EN "Jul 25, 2026"
  const en = scope.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (en) { const mo = EN_MONTHS[en[1].toLowerCase()]; if (mo) return toIso(Number(en[3]), mo, Number(en[2])); }
  // ZH "2026年7月25日"
  const zh = scope.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/);
  if (zh) return toIso(Number(zh[1]), Number(zh[2]), Number(zh[3]));
  return null;
}

/**
 * Parse toàn bộ text chi tiết hoá đơn dán vào → ParsedInvoice.
 * VAT = total − subtotal (chắc chắn hơn parse nhãn "thuế").
 */
export function parseInvoiceText(raw: string): ParsedInvoice {
  const text = raw.replace(/\s+/g, " ").trim();
  const unit_price_vnd = parseUnitPrice(text);
  const subtotal_vnd = parseSubtotal(text);
  const total_vnd = parseTotal(text);
  const quantity = parseQuantity(text, subtotal_vnd, unit_price_vnd);
  const vat_vnd =
    total_vnd !== null && subtotal_vnd !== null && total_vnd >= subtotal_vnd
      ? total_vnd - subtotal_vnd
      : amountAfterLabel(text, /vat\s*[–\-—]?\s*[a-zà-ỹ]*\s*\(?\d+%\)?/i);
  const { start: period_start, end: period_end } = parsePeriod(text);
  const invoice_number = parseInvoiceNumber(text);
  const status = parseStatus(text);
  const date = parsePaidDate(text);

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
    date,
    amount_vnd: total_vnd,
  };
}

/** Đọc đủ để LƯU chưa? Cần tối thiểu: số seat + tổng tiền + chu kỳ. */
export function isParsedInvoiceUsable(p: ParsedInvoice): boolean {
  return (
    p.quantity !== null &&
    p.total_vnd !== null &&
    p.period_end !== null
  );
}

export const __invoiceParseInternal = {
  parseUnitPrice,
  parseSubtotal,
  parseTotal,
  parseQuantity,
  parsePeriod,
  parseInvoiceNumber,
  parseStatus,
  parsePaidDate,
  parseSeatByDivisibleAmount,
  parseSeatNearPerSeat,
};
