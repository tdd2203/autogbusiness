/**
 * Chức năng: Parse & validate danh sách email dán vào (paste) — PURE LOGIC.
 *
 * ⚠️ ĐỌC `emailParser.md` (cùng thư mục) TRƯỚC KHI SỬA FILE NÀY.
 *
 * Tách từ `components/InviteMemberModal.tsx` — không phụ thuộc React state.
 * Dùng để: tách textarea (1 email/dòng hoặc cách nhau bởi , ;) thành các nhóm:
 *   - validUnique  : email hợp lệ, lowercase, đã dedup
 *   - validRaw     : email hợp lệ giữ nguyên hoa/thường, dedup theo lowercase
 *   - invalid      : token không khớp regex email
 *   - duplicates   : email hợp lệ nhưng trùng (đã có ở validUnique)
 */

/** Regex validate 1 email (case-insensitive). */
export const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

export function parseEmailsFromText(raw: string): {
  validUnique: string[]; // lowercase, dedup
  validRaw: string[]; // original case, dedup
  invalid: string[];
  duplicates: string[];
} {
  const tokens = raw
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const validUnique: string[] = [];
  const validRaw: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const tok of tokens) {
    if (!EMAIL_RE.test(tok)) {
      invalid.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    if (seen.has(lower)) {
      duplicates.push(tok);
      continue;
    }
    seen.add(lower);
    validUnique.push(lower);
    validRaw.push(tok);
  }
  return { validUnique, validRaw, invalid, duplicates };
}
