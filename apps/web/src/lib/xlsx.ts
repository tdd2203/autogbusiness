/**
 * Trình sinh file .xlsx TỐI GIẢN, KHÔNG phụ thuộc thư viện ngoài.
 *
 * Vì sao không xuất CSV: CSV double-click mở bằng Excel bị lệ thuộc "dấu phân
 * tách danh sách" theo locale máy (nhiều máy VN/macOS dùng dấu `;` chứ không phải
 * `,`) → toàn bộ dữ liệu dồn vào cột A. Ngoài ra CSV luôn kèm cảnh báo "Possible
 * Data Loss". File .xlsx thật không có 2 vấn đề đó: cột tách chuẩn, không cảnh báo.
 *
 * Cách làm: .xlsx là 1 file ZIP chứa vài XML (OOXML SpreadsheetML). Ta tự đóng gói
 * ZIP bằng phương thức STORE (không nén) + CRC32 thủ công — đủ để Excel/Numbers/
 * Google Sheets mở. Mọi ô đều là inlineStr (chuỗi) → không cần sharedStrings,
 * không cần serialize kiểu ngày (ngày giữ nguyên dạng text như bảng đang hiển thị).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/** Đóng gói ZIP (STORE — không nén). date/time để 0, Excel vẫn mở bình thường. */
function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = concatBytes([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // compression = STORE
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(size), // compressed
      u32(size), // uncompressed
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
      f.data,
    ]);
    locals.push(local);
    centrals.push(
      concatBytes([
        u32(0x02014b50), // central dir header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // compression
        u16(0), // mod time
        u16(0), // mod date
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        nameBytes,
      ]),
    );
    offset += local.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centrals) centralSize += c.length;

  const eocd = concatBytes([
    u32(0x06054b50), // end of central dir signature
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(centralStart),
    u16(0), // comment length
  ]);

  return concatBytes([...locals, ...centrals, eocd]);
}

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Chỉ số cột (0-based) → tên cột Excel: 0→A, 25→Z, 26→AA… */
function colName(index: number): string {
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * Sinh nội dung .xlsx từ header + rows (đều là chuỗi) và trả về Blob.
 * @param sheetName tên tab (Excel giới hạn 31 ký tự, không chứa []:*?/\\).
 */
export function buildXlsxBlob(
  header: string[],
  rows: string[][],
  sheetName = "Sheet1",
): Blob {
  const enc = new TextEncoder();
  const allRows = [header, ...rows];
  const sheetRows = allRows
    .map((cells, r) => {
      const cellsXml = cells
        .map(
          (val, c) =>
            `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val ?? "")}</t></is></c>`,
        )
        .join("");
      return `<row r="${r + 1}">${cellsXml}</row>`;
    })
    .join("");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;

  const safeSheet = xmlEscape(sheetName.replace(/[[\]:*?/\\]/g, " ").slice(0, 31));

  const files = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: enc.encode(sheetXml),
    },
  ];

  // concatBytes trả về Uint8Array trên ArrayBuffer khít kích thước → dùng .buffer
  // làm BlobPart (né lỗi typing typed-array generic của TS 5.7 với Uint8Array).
  const bytes = zipStore(files);
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** Tiện ích: build .xlsx rồi kích hoạt tải xuống bằng anchor tạm. */
export function downloadXlsx(
  filename: string,
  header: string[],
  rows: string[][],
  sheetName = "Sheet1",
): void {
  const blob = buildXlsxBlob(header, rows, sheetName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ── Workbook CÓ ĐỊNH DẠNG (nhiều sheet) ────────────────────────────────────
 *
 * Phần trên chỉ sinh được một bảng chữ trơn. Báo cáo ví cần hơn thế: số phải là SỐ
 * thật (bôi đen là Excel cộng ra ngay, không phải chuỗi), tiền có dấu phân cách
 * nghìn, dòng tiêu đề đóng băng khi cuộn, dải ngày và dòng cộng nổi bật lên. Nếu
 * không thì file mở ra vẫn là một khối chữ phẳng như CSV cũ, chỉ khác cái đuôi.
 *
 * Bảng style được ĐÚC SẴN dưới đây (styles.xml tĩnh) thay vì sinh động: báo cáo chỉ
 * dùng chừng hai chục kiểu, đúc sẵn thì không phải quản lý vòng đời font/fill/border
 * và file luôn nhỏ. Thêm kiểu mới = thêm một dòng vào CELL_XFS + một tên vào XSTYLE.
 */

/** Tên kiểu ô — khớp thứ tự với CELL_XFS bên dưới. */
export const XSTYLE = {
  none: 0,
  title: 1,
  meta: 2,
  th: 3,
  thRight: 4,
  text: 5,
  textMuted: 6,
  num: 7,
  numIn: 8,
  numOut: 9,
  numMuted: 10,
  band: 11,
  totalText: 12,
  totalNum: 13,
  kpiLabel: 14,
  kpiNum: 15,
  kpiNumIn: 16,
  kpiNumOut: 17,
  totalNumIn: 18,
  totalNumOut: 19,
  code: 20,
  codeMuted: 21,
  subText: 22,
  subNum: 23,
} as const;

export type XStyleName = keyof typeof XSTYLE;

/** Một ô: giá trị trần, hoặc kèm kiểu + số cột gộp. */
export type XCell =
  | string
  | number
  | null
  | { v: string | number | null; s?: XStyleName; span?: number };

export type XSheet = {
  name: string;
  /** Độ rộng từng cột (đơn vị "ký tự" của Excel). */
  cols?: number[];
  /** Đóng băng bấy nhiêu dòng đầu (0 = không đóng băng). */
  freeze?: number;
  rows: XCell[][];
};

// Font: 0 thường · 1 tiêu đề · 2 xám · 3 đậm · 4 xanh · 5 đỏ · 6 số lớn ·
//       7 số lớn xanh · 8 số lớn đỏ · 9 đậm xanh · 10 đậm đỏ · 11 mono
const FONTS = [
  '<font><sz val="11"/><name val="Calibri"/></font>',
  '<font><b/><sz val="15"/><name val="Calibri"/></font>',
  '<font><sz val="10.5"/><color rgb="FF6E6C66"/><name val="Calibri"/></font>',
  '<font><b/><sz val="11"/><name val="Calibri"/></font>',
  '<font><sz val="11"/><color rgb="FF0F6E56"/><name val="Calibri"/></font>',
  '<font><sz val="11"/><color rgb="FFA32D2D"/><name val="Calibri"/></font>',
  '<font><b/><sz val="14"/><name val="Calibri"/></font>',
  '<font><b/><sz val="14"/><color rgb="FF0F6E56"/><name val="Calibri"/></font>',
  '<font><b/><sz val="14"/><color rgb="FFA32D2D"/><name val="Calibri"/></font>',
  '<font><b/><sz val="11"/><color rgb="FF0F6E56"/><name val="Calibri"/></font>',
  '<font><b/><sz val="11"/><color rgb="FFA32D2D"/><name val="Calibri"/></font>',
  '<font><sz val="10"/><color rgb="FF44443F"/><name val="Consolas"/></font>',
].join("");

// Fill: 0/1 bắt buộc theo chuẩn OOXML · 2 xám nhạt (tiêu đề, dòng cộng) ·
//       3 xanh nhạt (dải ngày) · 4 kem (khối chỉ số) · 5 xám rất nhạt (dải cụm)
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF1EFE8"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE6F1FB"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF7F5EF"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF8F7F4"/><bgColor indexed="64"/></patternFill></fill>',
].join("");

const BORDERS = [
  "<border><left/><right/><top/><bottom/><diagonal/></border>",
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FFDCD9D0"/></bottom><diagonal/></border>',
].join("");

/** numFmtId 3 = `#,##0` (dựng sẵn trong Excel, không cần khai báo numFmts). */
const M = 3;
const xf = (font: number, fill: number, border: number, fmt = 0, align = "") =>
  `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" applyFont="1" applyFill="1" applyBorder="1"${fmt ? ' applyNumberFormat="1"' : ""}${align ? ` applyAlignment="1">${align}</xf>` : "/>"}`;
const RIGHT = '<alignment horizontal="right"/>';
const LEFT = '<alignment horizontal="left" vertical="center"/>';

const CELL_XFS = [
  xf(0, 0, 0), // none
  xf(1, 0, 0), // title
  xf(2, 0, 0), // meta
  xf(3, 2, 1, 0, LEFT), // th
  xf(3, 2, 1, 0, RIGHT), // thRight
  xf(0, 0, 1), // text
  xf(2, 0, 1), // textMuted
  xf(0, 0, 1, M, RIGHT), // num
  xf(4, 0, 1, M, RIGHT), // numIn
  xf(5, 0, 1, M, RIGHT), // numOut
  xf(2, 0, 1, M, RIGHT), // numMuted
  xf(3, 3, 1, 0, LEFT), // band
  xf(3, 2, 1, 0, LEFT), // totalText
  xf(3, 2, 1, M, RIGHT), // totalNum
  xf(2, 4, 0, 0, LEFT), // kpiLabel
  xf(6, 4, 0, M, RIGHT), // kpiNum
  xf(7, 4, 0, M, RIGHT), // kpiNumIn
  xf(8, 4, 0, M, RIGHT), // kpiNumOut
  xf(9, 2, 1, M, RIGHT), // totalNumIn
  xf(10, 2, 1, M, RIGHT), // totalNumOut
  xf(11, 0, 1), // code
  xf(11, 5, 1), // codeMuted
  xf(2, 5, 1, 0, LEFT), // subText
  xf(3, 5, 1, M, RIGHT), // subNum
].join("");

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="12">${FONTS}</fonts><fills count="6">${FILLS}</fills><borders count="2">${BORDERS}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${Object.keys(XSTYLE).length}">${CELL_XFS}</cellXfs></styleSheet>`;

function sheetXmlOf(sheet: XSheet): string {
  const merges: string[] = [];
  const body = sheet.rows
    .map((cells, r) => {
      let col = 0;
      const xml = cells
        .map((raw) => {
          const cell =
            raw !== null && typeof raw === "object" ? raw : { v: raw as string | number | null };
          const style = "s" in cell && cell.s ? XSTYLE[cell.s] : 0;
          const span = ("span" in cell && cell.span) || 1;
          const ref = `${colName(col)}${r + 1}`;
          if (span > 1) merges.push(`${ref}:${colName(col + span - 1)}${r + 1}`);
          col += span;
          const attrs = `r="${ref}"${style ? ` s="${style}"` : ""}`;
          // Ô bị gộp vẫn phải TỒN TẠI, nếu không nền của dải ngày/cụm chỉ tô đúng ô
          // đầu rồi hết, phần còn lại trắng bệch giữa bảng.
          let filler = "";
          for (let k = 1; k < span; k++) {
            filler += `<c r="${colName(col - span + k)}${r + 1}"${style ? ` s="${style}"` : ""}/>`;
          }
          if (cell.v === null || cell.v === "") return `<c ${attrs}/>${filler}`;
          if (typeof cell.v === "number") return `<c ${attrs}><v>${cell.v}</v></c>${filler}`;
          return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>${filler}`;
        })
        .join("");
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join("");

  const freeze = sheet.freeze
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";
  const cols = sheet.cols?.length
    ? `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${body}</sheetData>${mergeXml}</worksheet>`;
}

/** Sinh .xlsx nhiều sheet có định dạng. Tên sheet trùng nhau bị đánh số cho khác. */
export function buildWorkbookBlob(sheets: XSheet[]): Blob {
  const enc = new TextEncoder();
  const used = new Set<string>();
  const names = sheets.map((s, i) => {
    let name = s.name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name)) name = `${name.slice(0, 29)}_${i + 1}`;
    used.add(name);
    return name;
  });

  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const sheetTags = names
    .map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  const relTags = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("");
  const styleRel = `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;

  const files = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags}${styleRel}</Relationships>`,
      ),
    },
    { name: "xl/styles.xml", data: enc.encode(STYLES_XML) },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(sheetXmlOf(s)),
    })),
  ];

  const bytes = zipStore(files);
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** Tải file về máy bằng anchor tạm. Dùng chung cho .xlsx và .csv. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadWorkbook(filename: string, sheets: XSheet[]): void {
  downloadBlob(
    filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`,
    buildWorkbookBlob(sheets),
  );
}
