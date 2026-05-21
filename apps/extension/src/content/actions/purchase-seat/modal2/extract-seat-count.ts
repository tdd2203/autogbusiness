/**
 * Đọc số "X suất ... bổ sung" / "X additional seats" từ modal text. Trả null
 * nếu không match (caller skip sanity check).
 */
export function extractAdditionalSeatCountFromModal(text: string): number | null {
  const patterns: RegExp[] = [
    /(\d{1,3})\s*suất.{0,30}bổ\s*sung/i,
    /(\d{1,3})\s*additional\s*(?:seat|user|license)/i,
    /add\s*(\d{1,3})\s*(?:seat|user|license)/i,
    /添加?\s*(\d{1,3})\s*(?:个\s*)?(?:用户|席位|许可)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0 && n <= 999) return n;
    }
  }
  return null;
}
