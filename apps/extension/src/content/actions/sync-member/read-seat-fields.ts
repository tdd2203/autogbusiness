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

import { waitFor } from "../../human";
import { normalizeForMatch } from "../purchase-seat/modal2/money";
import {
  SEAT_CARDS_POLL_MS,
  SEAT_CARDS_WAIT_MS,
} from "../purchase-seat/constants";
import {
  describeSeatCards,
  readSeatCardsFromPage,
  type SeatCardsReading,
} from "../purchase-seat/read-seat-cards";

/**
 * Cặp số gắn vào `result.data` của task; rỗng = không đọc được, đừng ghi gì.
 *
 * `seat_cards_text` CHỈ có mặt khi đọc HỎNG: mẩu text quanh chữ "Đã gán" trên
 * trang lúc đó. Không có nó thì mỗi lần ChatGPT xếp lại hàng thẻ là phải nhờ
 * người mở ChatGPT nhìn tận mắt mới biết vì sao — đúng cái giá đã trả cho lần
 * hỏng 4/9 → 12/9/2026.
 */
export type SeatFields = {
  seat_total?: number;
  seat_assigned?: number;
  seat_cards_text?: string;
};

/** Tách khỏi phần đọc DOM để test được. */
export function seatFieldsOf(reading: SeatCardsReading | null): SeatFields {
  if (!reading || reading.total <= 0) return {};
  return { seat_total: reading.total, seat_assigned: reading.assigned };
}

/** Dài nhất của mẩu chẩn đoán — đủ nhìn ra hàng thẻ, không phình `result`. */
const PROBE_MAX = 240;

/** Chữ đánh dấu chỗ đáng nhìn nhất khi hàng thẻ đọc không ra. */
const SEAT_WORD_PROBE =
  /da\s*gan|assigned|已分配|kha\s*dung|con\s*trong|available|可用/;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Một mẩu text quanh chữ "Đã gán" của trang, đã xoá email và cắt ngắn.
 *
 * Không thấy chữ nào về suất thì trả đúng câu đó kèm độ dài trang — vừa là câu
 * trả lời rõ nhất ("hàng thẻ KHÔNG có trên trang"), vừa không kéo theo tên ai.
 */
export function seatTextProbe(raw: string): string {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "(trang trống)";
  // Bản thường hoá dài BẰNG ĐÚNG `collapsed` nên index khớp trên nó cắt thẳng
  // ra bản gốc còn dấu.
  const at = normalizeForMatch(collapsed).match(SEAT_WORD_PROBE)?.index;
  if (at === undefined) {
    return `(không có chữ nào về suất trong ${collapsed.length} ký tự)`;
  }
  const from = Math.max(0, at - PROBE_MAX / 2);
  return collapsed.slice(from, from + PROBE_MAX).replace(EMAIL_RE, "<email>");
}

/**
 * Đọc hàng thẻ suất trên trang đang mở. KHÔNG BAO GIỜ ném lỗi: đây là phần thêm
 * của lệnh đồng bộ, hỏng thì mẻ đồng bộ vẫn phải chạy tiếp bình thường.
 *
 * Chờ thêm `SEAT_CARDS_WAIT_MS` khi lượt đọc đầu chưa ra: hàng thẻ nằm ở đầu
 * trang nhưng vẫn là React dựng sau, mà lệnh đồng bộ đọc ngay khi vừa vào tab.
 */
export async function readSeatFields(log: string): Promise<SeatFields> {
  try {
    let reading = readSeatCardsFromPage();
    if (!reading) {
      try {
        reading = await waitFor(
          () => readSeatCardsFromPage(),
          SEAT_CARDS_WAIT_MS,
          SEAT_CARDS_POLL_MS,
        );
      } catch {
        reading = null;
      }
    }
    const fields = seatFieldsOf(reading);
    if (reading && fields.seat_total !== undefined) {
      console.log(`${log} suất đọc trên tab Người dùng: ${describeSeatCards(reading)}`);
      return fields;
    }
    const probe = seatTextProbe(
      document.body?.innerText || document.body?.textContent || "",
    );
    console.log(`${log} không đọc được hàng thẻ suất (bỏ qua, giữ số cũ): ${probe}`);
    return { seat_cards_text: probe };
  } catch (e) {
    console.warn(
      `${log} lỗi khi đọc hàng thẻ suất (bỏ qua): ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}
