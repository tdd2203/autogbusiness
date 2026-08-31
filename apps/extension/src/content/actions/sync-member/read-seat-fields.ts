/**
 * Nhặt số suất trên tab "Người dùng" trong lúc đồng bộ lời mời — KHÔNG tốn thêm
 * cú bấm nào.
 *
 * Vì sao (user 2026-08-31): lệnh "Đồng bộ lời mời" đã đứng sẵn ở tab "Người
 * dùng", nơi ChatGPT in sẵn hàng thẻ "Suất Tiêu chuẩn · Đã gán 288/302". Trước
 * đây mẻ đồng bộ chỉ đọc danh sách email rồi đi, nên `workspace.seat_total` chỉ
 * tươi khi chạy SYNC_BILLING hoặc khi có lệnh mời — dashboard ôm số cũ hàng
 * tuần dù vừa đồng bộ xong (31/8/2026: DB ghi 288 suất đã gán trong khi đã có
 * 291 người trong nhóm). Cùng một công đứng đó thì đọc luôn.
 *
 * CHỈ ĐỌC BẢN IN SẴN. Không mở hộp "Quản lý suất" như `checkSeatAvailability`:
 * hộp đó tốn tới ~28s và là chỗ hỏng nhiều nhất của luồng mời — đổi lấy một con
 * số phụ thì không đáng. Đọc không được thì trả object rỗng, backend giữ nguyên
 * số cũ (`_absorb_seat_reading`, queue/completion.py).
 *
 * ⚠️ Ô "Đã gán" đếm người ĐÃ THAM GIA, không kể lời mời đang chờ — xem
 * `read-seat-cards.ts`. Backend ghi thẳng cặp số này vào workspace, còn số suất
 * đang chiếm mà dashboard hiển thị vẫn đếm lại trong DB (`services/seats.py`).
 */

import {
  describeSeatCards,
  readSeatCardsFromPage,
  type SeatCardsReading,
} from "../purchase-seat/read-seat-cards";

/** Cặp số gắn vào `result.data` của task; rỗng = không đọc được, đừng ghi gì. */
export type SeatFields = { seat_total?: number; seat_assigned?: number };

/** Tách khỏi phần đọc DOM để test được. */
export function seatFieldsOf(reading: SeatCardsReading | null): SeatFields {
  if (!reading || reading.total <= 0) return {};
  return { seat_total: reading.total, seat_assigned: reading.assigned };
}

/**
 * Đọc hàng thẻ suất trên trang đang mở. KHÔNG BAO GIỜ ném lỗi: đây là phần thêm
 * của lệnh đồng bộ, hỏng thì mẻ đồng bộ vẫn phải chạy tiếp bình thường.
 */
export function readSeatFields(log: string): SeatFields {
  try {
    const reading = readSeatCardsFromPage();
    const fields = seatFieldsOf(reading);
    if (reading && fields.seat_total !== undefined) {
      console.log(`${log} suất đọc trên tab Người dùng: ${describeSeatCards(reading)}`);
    } else {
      console.log(`${log} không đọc được hàng thẻ suất (bỏ qua, giữ số cũ)`);
    }
    return fields;
  } catch (e) {
    console.warn(
      `${log} lỗi khi đọc hàng thẻ suất (bỏ qua): ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}
