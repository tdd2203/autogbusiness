/**
 * DÃY SUẤT của trang "Mời thành viên" — cột Không gian đọc DỌC theo danh sách đang
 * dán chứ không lặp lại cùng một con số ở mọi dòng (chốt user 2026-09-06).
 *
 * Mỗi email chiếm 1 suất MỚI của không gian đích, nên số suất tụt dần từ trên
 * xuống: dòng ĐẦU của mỗi không gian hiện số suất đang có, các dòng giữa chỉ còn
 * mũi tên, dòng CUỐI hiện số còn lại sau khi mời hết mẻ. Dán đúng 1 email thì gộp
 * thành một dòng "2 → 1" cho gọn.
 *
 * Email đang giữ suất ở CHÍNH không gian đó (gia hạn / mời lại chỗ cũ) KHÔNG làm dãy
 * tụt — nó đã nằm trong `seat_used` rồi, đếm thêm là doạ thiếu suất oan.
 *
 * Chỉ dòng thật sự không còn chỗ mới mang `kind: "none"` (nhãn đỏ "hết suất"). Email
 * lấy nốt suất cuối (1 → 0) vẫn mời được nên là `end` bình thường — trước đây cả mẻ
 * cùng ăn nhãn đỏ ngay khi số còn lại về 0, đại lý tưởng lệnh sắp hỏng.
 *
 * Hàm thuần, không biết i18n: chỗ gọi tự dịch từng `kind` ra chữ.
 */

/** 1 dòng email trong danh sách đang dán. */
export type SeatRunEntry = {
  /** Email (chưa cần lowercase — hàm tự chuẩn hoá khi làm khoá). */
  email: string;
  /** Không gian ĐÍCH của dòng này. `undefined` = chưa resolve được → bỏ qua. */
  workspaceId: string | undefined;
  /** Dòng này có ăn thêm 1 suất mới của không gian đó không. */
  takesSeat: boolean;
};

export type SeatRunCell =
  /** Chưa đồng bộ tổng suất → không biết còn bao nhiêu, đừng đoán. */
  | { kind: "unknown" }
  /** Dòng này không còn chỗ: mời tiếp là phải mua thêm suất bằng tiền thật. */
  | { kind: "none" }
  /** Cả không gian chỉ có 1 dòng → gộp "from → to". */
  | { kind: "single"; from: number; to: number }
  /** Dòng đầu của không gian: số suất đang có. */
  | { kind: "start"; value: number }
  /** Dòng giữa: chỉ mũi tên, số không đổi ở đây. */
  | { kind: "arrow" }
  /** Dòng cuối của không gian: số còn lại sau khi mời hết mẻ. */
  | { kind: "end"; value: number };

/**
 * @param entries danh sách đang dán, ĐÚNG thứ tự hiển thị.
 * @param seatLeft số suất còn trống của 1 không gian; `null` = chưa biết.
 * @returns map email (lowercase) → ô suất của dòng đó.
 */
export function buildSeatRun(
  entries: SeatRunEntry[],
  seatLeft: (workspaceId: string) => number | null,
): Map<string, SeatRunCell> {
  const order = new Map<string, string[]>();
  const left = new Map<string, number | null>();
  const used = new Map<string, number>();
  const rows: { key: string; wsId: string; remaining: number | null }[] = [];

  for (const e of entries) {
    const wsId = e.workspaceId;
    if (!wsId) continue;
    const key = e.email.toLowerCase();
    if (!left.has(wsId)) left.set(wsId, seatLeft(wsId));
    const spent = (used.get(wsId) ?? 0) + (e.takesSeat ? 1 : 0);
    used.set(wsId, spent);
    order.set(wsId, [...(order.get(wsId) ?? []), key]);
    const start = left.get(wsId) ?? null;
    rows.push({ key, wsId, remaining: start === null ? null : start - spent });
  }

  const out = new Map<string, SeatRunCell>();
  for (const r of rows) {
    const start = left.get(r.wsId) ?? null;
    if (start === null || r.remaining === null) {
      out.set(r.key, { kind: "unknown" });
      continue;
    }
    if (r.remaining < 0) {
      out.set(r.key, { kind: "none" });
      continue;
    }
    const list = order.get(r.wsId) ?? [];
    if (list.length === 1) {
      out.set(r.key, { kind: "single", from: start, to: r.remaining });
    } else if (list[0] === r.key) {
      out.set(r.key, { kind: "start", value: start });
    } else if (list[list.length - 1] === r.key) {
      out.set(r.key, { kind: "end", value: r.remaining });
    } else {
      out.set(r.key, { kind: "arrow" });
    }
  }
  return out;
}
