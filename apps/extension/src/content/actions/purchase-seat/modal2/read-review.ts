import { extractAdditionalSeatCountFromModal } from "./extract-seat-count";
import {
  extractChargeAmountFromModal,
  extractSalesTax,
  extractMonthlyBills,
  extractProrationSubtotal,
  parseVndAmount,
  type MonthlyBills,
} from "./money";

export type PurchaseReview = {
  /** textContent thô (đã gộp whitespace) — giữ để log khi sanity check fail. */
  rawText: string;
  /** Số suất modal NÓI là sẽ thêm. Null = không đọc được. */
  seatCount: number | null;
  /**
   * "Tổng phải trả hôm nay" — khoản prorate bị trừ NGAY. ĐÃ gồm thuế bán hàng,
   * nhưng CHƯA gồm phí ngân hàng / phí quy đổi ngoại tệ.
   */
  todayText: string | null;
  todayVnd: number | null;
  /** "Thuế bán hàng (10,001%)" — số tiền thuế + tỷ lệ. */
  taxText: string | null;
  taxVnd: number | null;
  taxPercent: string | null;
  /**
   * "Tạm tính theo tỷ lệ" (chưa gồm thuế) — phần prorate của khoản tăng hằng
   * tháng, tính theo GIÁ THẬT sau giảm giá chứ không theo giá niêm yết.
   */
  prorationText: string | null;
  prorationVnd: number | null;
  /** Hoá đơn hằng tháng trước/sau + mức tăng cố định mỗi tháng. */
  monthly: MonthlyBills;
};

/**
 * Đọc TOÀN BỘ số liệu tiền của modal "Xem lại giao dịch mua" trong MỘT lần
 * chạm DOM.
 *
 * ⚠️ Gọi hàm này NGAY TRƯỚC khi bấm xác nhận, và chỉ gọi MỘT lần.
 *
 * Lý do: "Tạm tính theo tỷ lệ" (và do đó cả tổng hôm nay) được ChatGPT tính lại
 * theo thời gian còn lại của chu kỳ thanh toán, nên ĐỔI ở mỗi lần mở modal —
 * user mở 3 lần liên tiếp ra 27.311đ / 27.191đ / 27.168đ. Vì vậy:
 *   - KHÔNG cache kết quả để dùng lại ở lần chạy sau;
 *   - KHÔNG so sánh số tiền giữa 2 lần đọc rồi coi lệch là bất thường —
 *     lệch là CHUYỆN BÌNH THƯỜNG, chặn theo kiểu đó là chặn oan mọi lần mua.
 *
 * Con số dùng để CHẶN là số suất (`seatCount`) và mức tăng hằng tháng
 * (`monthly.deltaVnd`) — hai thứ này ổn định trong cùng một lần mua.
 */
export function readPurchaseReview(modal: HTMLElement): PurchaseReview {
  const rawText = (modal.textContent ?? "").replace(/\s+/g, " ").trim();
  const todayText = extractChargeAmountFromModal(rawText);
  const proration = extractProrationSubtotal(rawText);
  const tax = extractSalesTax(rawText);
  return {
    rawText,
    seatCount: extractAdditionalSeatCountFromModal(rawText),
    todayText,
    todayVnd: parseVndAmount(todayText),
    prorationText: proration,
    prorationVnd: parseVndAmount(proration),
    taxText: tax.text,
    taxVnd: parseVndAmount(tax.text),
    taxPercent: tax.percent,
    monthly: extractMonthlyBills(rawText),
  };
}
