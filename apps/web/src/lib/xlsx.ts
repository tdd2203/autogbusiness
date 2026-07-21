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
