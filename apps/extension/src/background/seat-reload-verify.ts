/**
 * Phân xử "cú mua suất vừa rồi có đi qua không" bằng SỐ SUẤT đọc lại sau khi
 * background tải lại (F5) trang /admin/members.
 *
 * Vì sao cần: ChatGPT có ca in băng-rôn đỏ "Đã xảy ra sự cố khi cập nhật gói
 * đăng ký của bạn" rồi treo nguyên hộp xác nhận (ảnh user 2026-08-26). Băng-rôn
 * đó KHÔNG nói được tiền đã trừ hay chưa, mà hộp còn che thì đọc số suất ngay
 * trên trang cũng không được. F5 xong đọc lại là đường duy nhất còn lại.
 *
 * ⚠️ Chỗ này quyết định có TIÊU TIỀN LẦN NỮA hay không, nên mọi quy tắc dưới đây
 * đều lệch về phía "thà báo không rõ còn hơn mua đúp":
 *   - so bằng cặp số CÙNG THANG ĐO (số trang trước ↔ số trang sau) khi có;
 *   - bí lắm mới mượn bộ đếm hộp "Quản lý suất" làm mốc "trước";
 *   - nhích được một phần (0 < delta < qty) là KHÔNG rõ, không phải "chưa mua".
 *
 * Ghi chú về thang đo: bộ đếm hộp "Quản lý suất" ghim vào hàng suất TIÊU CHUẨN,
 * còn `total` của trang gộp mọi loại. Lấy `counter` so với `total` thì phần suất
 * Cao cấp (nếu có) làm delta PHỒNG lên — sai theo hướng "tưởng đã mua", tức là
 * không mua lại. Sai theo hướng ngược lại (tưởng chưa mua → mua đúp) không xảy
 * ra được, vì `total ≥ standard` nên delta đọc ra không bao giờ nhỏ hơn delta
 * thật của hàng Tiêu chuẩn.
 */

/** Cặp số suất đọc từ hàng thẻ trên trang Thành viên. */
export type SeatReadout = {
  /** Σ suất mọi loại. */
  total: number | null;
  /** Suất Tiêu chuẩn — loại duy nhất luồng mua đụng tới. */
  standard: number | null;
};

/** Mốc "trước" đã dùng để so — ghi vào kết quả task cho admin truy ngược. */
export type SeatVerifyBasis =
  | "page_standard"
  | "page_total"
  | "counter_standard"
  | "counter_total";

/** Số đo của một lượt so — dùng chung cho hai phán quyết "có số để nói". */
type SeatMove = {
  basis: SeatVerifyBasis;
  before: number;
  after: number;
  delta: number;
};

export type SeatPurchaseVerdict =
  | ({ kind: "purchased" } & SeatMove)
  | ({ kind: "not_purchased" } & SeatMove)
  | { kind: "unclear"; reason: string };

type Pair = { basis: SeatVerifyBasis; before: number; after: number };

/**
 * Chọn cặp số cùng thang đo để so. Ưu tiên: số TRANG in trước khi mua (cùng
 * nguồn, cùng cách đọc) → mới tới bộ đếm hộp.
 */
function pickPair(
  pageBefore: SeatReadout | null,
  counterBefore: number | null,
  after: SeatReadout,
): Pair | null {
  if (pageBefore?.standard != null && after.standard != null) {
    return { basis: "page_standard", before: pageBefore.standard, after: after.standard };
  }
  if (pageBefore?.total != null && after.total != null) {
    return { basis: "page_total", before: pageBefore.total, after: after.total };
  }
  if (counterBefore != null && after.standard != null) {
    return { basis: "counter_standard", before: counterBefore, after: after.standard };
  }
  if (counterBefore != null && after.total != null) {
    return { basis: "counter_total", before: counterBefore, after: after.total };
  }
  return null;
}

export function judgeSeatsAfterReload(input: {
  /** Số suất task này định mua. */
  qty: number;
  /** Bộ đếm hộp "Quản lý suất" TRƯỚC khi bấm "+" (= tổng suất Tiêu chuẩn lúc đó). */
  counterBefore: number | null;
  /** Số suất trang in ra TRƯỚC khi bấm mua. */
  pageBefore: SeatReadout | null;
  /** Số suất trang in ra SAU khi tải lại. */
  after: SeatReadout;
  /**
   * Câu hộp xác nhận nói thay đổi chỉ có hiệu lực từ kỳ gia hạn sau ("Có hiệu
   * lực vào 25 tháng 9, 2026" — ảnh user 26/8/2026), null nếu hộp không nói gì.
   *
   * Có câu này thì số suất HÔM NAY đúng ra không nhích dù ChatGPT đã ghi nhận
   * giao dịch ⇒ tuyệt đối không được kết luận "chưa mua" từ nó.
   */
  effectiveLaterText?: string | null;
}): SeatPurchaseVerdict {
  const { qty, counterBefore, pageBefore, after } = input;
  const effectiveLaterText = input.effectiveLaterText ?? null;
  if (qty < 1) return { kind: "unclear", reason: `số suất cần mua không hợp lệ (${qty})` };

  const pair = pickPair(pageBefore, counterBefore, after);
  if (!pair) {
    return {
      kind: "unclear",
      reason:
        "không có cặp số nào cùng thang đo để so (trang vừa tải lại đọc ra " +
        `tổng=${after.total ?? "?"}, Tiêu chuẩn=${after.standard ?? "?"}; ` +
        `mốc trước: trang=${pageBefore ? (pageBefore.standard ?? pageBefore.total ?? "?") : "không có"}, ` +
        `bộ đếm=${counterBefore ?? "không có"})`,
    };
  }

  const delta = pair.after - pair.before;
  if (delta >= qty) {
    return { kind: "purchased", basis: pair.basis, before: pair.before, after: pair.after, delta };
  }
  if (delta <= 0) {
    if (effectiveLaterText) {
      return {
        kind: "unclear",
        reason:
          `số suất chưa nhích (${pair.before} → ${pair.after}) NHƯNG hộp xác nhận nói ` +
          `"${effectiveLaterText}" — thay đổi chỉ có hiệu lực từ kỳ gia hạn sau, nên số suất ` +
          "hôm nay không nói lên được điều gì",
      };
    }
    return { kind: "not_purchased", basis: pair.basis, before: pair.before, after: pair.after, delta };
  }
  return {
    kind: "unclear",
    reason:
      `số suất mới nhích ${delta}/${qty} sau khi tải lại trang ` +
      `(${pair.before} → ${pair.after}, mốc "${pair.basis}") — không đủ để nói đã mua xong, ` +
      "cũng không thể coi là chưa mua",
  };
}
