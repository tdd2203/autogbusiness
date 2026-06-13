/**
 * Tìm row đầu tiên có trạng thái "Đến hạn" / "Due" / "Unpaid" trong bảng
 * /admin/billing?tab=invoices và extract:
 *   - URL Stripe từ anchor "Xem"
 *   - Số tiền (text + integer VND) từ cột "Số lượng" cùng row
 *
 * Bảng có cấu trúc 4 cột: Ngày, Số lượng, Trạng thái, Xem(link). "Đến hạn"
 * thường là row mới nhất (top). Trả null nếu không tìm thấy.
 */
export function findFirstUnpaidInvoice(): { url: string; amountText: string | null } | null {
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="invoice.stripe.com"]',
    ),
  );
  for (const a of anchors) {
    let row: HTMLElement | null = a;
    for (let i = 0; i < 6 && row; i++) {
      const rowText = (row.textContent ?? "").toLowerCase();
      if (
        /đến\s*hạn|đến\s*ngày|due|unpaid|past\s*due|chưa\s*thanh\s*toán|未\s*付款|未支付|逾期/i.test(
          rowText,
        ) &&
        !/đã\s*thanh\s*toán|paid|已\s*付款|已支付/i.test(rowText)
      ) {
        // Tìm cụm tiền trong row: "207.948 đ" / "207,948 đ" / "$25.00"
        const amountMatch = (row.textContent ?? "").match(
          /(\d{1,3}(?:[.,]\d{3}){1,3}(?:[.,]\d{1,2})?)\s*[₫đ]/i,
        );
        return {
          url: a.href,
          amountText: amountMatch ? amountMatch[0].trim() : null,
        };
      }
      row = row.parentElement;
    }
  }
  if (anchors.length > 0) {
    console.warn(
      "[autogpt-purchase-seat] không match được 'Đến hạn' — fallback anchor đầu tiên",
    );
    return { url: anchors[0].href, amountText: null };
  }
  return null;
}

/** Backward-compat alias để chain-handler cũ vẫn dùng được. */
export function findFirstUnpaidInvoiceStripeUrl(): string | null {
  return findFirstUnpaidInvoice()?.url ?? null;
}
