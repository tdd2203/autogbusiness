/**
 * Date keyword match — đa ngôn ngữ:
 *   vi: "17 thg 5, 2026" / "17 tháng 5, 2026"
 *   zh: "2026年5月17日"
 *   en: "May 17, 2026"
 */
export const DATE_RE =
  /^(?:\d{1,2}\s+(?:thg|tháng)\s+\d{1,2},\s+\d{4}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+\d{1,2},?\s+\d{4})$/i;

const EN_MONTHS_SYNC: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function buildIso(year: number, month: number, day: number): string | null {
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseDateMulti(text: string): string | null {
  // VI: "17 thg 5, 2026"
  let m = text.match(/^(\d{1,2})\s+(?:thg|tháng)\s+(\d{1,2}),\s+(\d{4})$/i);
  if (m) return buildIso(+m[3], +m[2], +m[1]);
  // ZH: "2026年5月17日"
  m = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
  if (m) return buildIso(+m[1], +m[2], +m[3]);
  // EN: "May 17, 2026"
  m = text.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+(\d{1,2}),?\s+(\d{4})$/i,
  );
  if (m) {
    const month = EN_MONTHS_SYNC[m[1].toLowerCase()];
    if (month) return buildIso(+m[3], month, +m[2]);
  }
  return null;
}

/**
 * Tìm "Ngày thêm" — walk text nodes trong row tìm format "DD thg M, YYYY".
 * Trả ISO date string hoặc null.
 */
export function findJoinedAtInRow(row: HTMLElement): string | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? "").trim();
    if (!DATE_RE.test(text)) continue;
    const iso = parseDateMulti(text);
    if (iso) return iso;
  }
  return null;
}
