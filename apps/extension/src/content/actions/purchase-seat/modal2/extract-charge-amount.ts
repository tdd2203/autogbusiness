/**
 * Scrape tổng tiền "Tổng đến hạn hôm nay" / "Total due today" từ modal.
 * Best-effort cho audit log — không bắt buộc.
 */
export function extractChargeAmountFromModal(text: string): string | null {
  const patterns: RegExp[] = [
    /tổng\s*đến\s*hạn\s*hôm\s*nay\s*([₫đ]\s*[\d.,]+|\$\s*[\d.,]+)/i,
    /total\s*due\s*(?:today)?\s*([₫đ]\s*[\d.,]+|\$\s*[\d.,]+)/i,
    /(?:[₫đ]|\$)\s*([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}
