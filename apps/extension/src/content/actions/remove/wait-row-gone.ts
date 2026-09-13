import type { PaidSeatOutcome } from "../dialog-commit";

/**
 * BẤM XOÁ XONG THÌ CHỜ DÒNG ĐÓ BIẾN MẤT, rồi mới tra lại.
 *
 * Luật user chốt 11/9/2026: *"xoá xong chờ nó biến mất rồi tìm kiếm đúng 1 lần
 * cho chắc chắn. như thế là nó xoá rồi"*.
 *
 * Vì sao không chờ theo đồng hồ nữa: ChatGPT giữ hộp xác nhận quay tới khi server
 * gỡ xong, rồi mới bồi hộp "Gỡ suất trả phí?" — cả khúc đó thường mất chục giây
 * trở lên. Bản chờ tối đa 3 giây hết giờ đúng lúc hộp còn quay, ESC cho khuất rồi
 * gõ ô lọc ngay khi ChatGPT chưa gỡ xong, nên lần tra nào cũng còn thấy dòng: mọi
 * lệnh gỡ có bấm nút đều báo `REMOVE_VERIFY_FAILED`, lượt sau mới ra đã vắng.
 * Bản trước đó chờ hộp tắt hẳn thì lệnh nào cũng xong ngay lượt đầu.
 *
 * DÒNG MẤT RỒI VẪN NÁN LẠI CHỜ HỘP SUẤT (13/9/2026): hai lệnh gỡ 12–13/9 đều ghi
 * `row_gone: true, dialog_stuck: false, paid_seat: none`, nhưng ảnh user chụp ngay
 * sau đó hộp "Remove the paid seat?" vẫn nằm trên trang chưa ai bấm. Tức ChatGPT
 * vẽ lại danh sách (dòng rời đi) TRƯỚC, rồi mới bồi hộp suất — hộp đó phải chờ
 * tính xong hoá đơn trước/sau mới hiện. Bản cũ thấy dòng vắng 4 nhịp là đi tra ô
 * lọc ngay nên lần nào cũng hụt hộp: giữa kỳ thì hộp nằm lì trên trang, còn ngày
 * chốt thì suất KHÔNG được trả. Nay dòng mất rồi, chưa gặp hộp suất thì nán thêm
 * một quãng `PAID_SEAT_GRACE_TICKS`; hộp hiện là trả lời rồi đi tiếp ngay, hết
 * quãng mà không có hộp thì thôi (ChatGPT không hỏi).
 *
 * Tách khỏi DOM để khoá bằng test; đếm theo NHỊP, không theo `Date.now()`.
 */

/** Một lượt soi trang sau khi bấm xác nhận. */
export type AfterConfirmSnapshot = {
  /** Còn hộp thoại đang sống (hộp xác nhận, hộp suất, hộp lạ). */
  dialog: boolean;
  /** Hộp thoại đang quay — ChatGPT chưa trả lời. */
  busy: boolean;
  /** Hộp đang mở là hộp "Gỡ suất trả phí?". */
  paidSeat: boolean;
  /** Dòng của email còn trong danh sách đang lọc. */
  row: boolean;
};

/** Đang chờ gì — để câu báo nhịp nói đúng việc. */
export type RowGoneStage = "row" | "paid_seat";

export type RowGoneDeps = {
  read: () => AfterConfirmSnapshot;
  /** Trả lời hộp "Gỡ suất trả phí?" — giữ giữa kỳ, gỡ trong ngày chốt chu kỳ. */
  answerPaidSeat: () => Promise<PaidSeatOutcome>;
  /** Báo một nhịp tiến độ, kẻo background đọc quãng chờ là lệnh treo. */
  beat: (waitedMs: number, stage: RowGoneStage) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export type RowGoneVerdict = {
  /** Dòng đã rời danh sách đang lọc. */
  gone: boolean;
  /** Kết quả trả lời hộp suất trong lúc chờ; `none` = chưa gặp hộp đó. */
  paidSeat: PaidSeatOutcome;
  /** Từ lúc bấm xác nhận tới lúc dòng được tính là mất (hoặc hết trần). */
  waitedMs: number;
  /** Nán lại sau khi dòng mất để chờ hộp suất — 0 nếu hộp đã được trả lời trước đó. */
  graceMs: number;
};

export const GONE_POLL_MS = 300;
/**
 * Dòng phải vắng bấy nhiêu nhịp LIÊN TIẾP (~1,2s) mới tính là mất — danh sách
 * nháy trống giữa hai lần vẽ không tính.
 */
export const GONE_STABLE_TICKS = 4;
/**
 * Hộp còn báo đang quay mà dòng đã vắng ngần này nhịp thì vẫn tính là mất. Lúc
 * hộp xác nhận thật sự còn quay thì danh sách phía sau đứng im, dòng không tự rơi
 * ra được; chặn này chỉ để một nút bị khoá sẵn trong hộp không bắt lệnh ngồi hết
 * trần.
 */
export const GONE_BUSY_TICKS = 10;
/**
 * Trần chờ (~45s) — hộp xác nhận từng quay gần 30s mới tắt. Hết trần thì vẫn tra
 * lại một lần như thường: ô tìm kiếm mới là nơi phân xử, trần chỉ để không chờ vô
 * hạn.
 */
export const GONE_MAX_TICKS = 150;
/**
 * Dòng mất rồi, nán thêm tối đa ~15s chờ hộp "Gỡ suất trả phí?" hiện muộn. Hộp
 * hiện là đi tiếp ngay nên quãng này chỉ tốn trọn khi ChatGPT không hỏi gì; hụt
 * hộp trong ngày chốt là mất nguyên một tháng tiền ghế, nên chờ rộng tay.
 */
export const PAID_SEAT_GRACE_TICKS = 50;
/** Báo nhịp ~9s/lần trong lúc chờ. */
export const GONE_BEAT_TICKS = 30;

/**
 * Chờ tới khi dòng của email rời danh sách đang lọc, rồi nán lại chờ hộp suất nếu
 * chưa gặp.
 *
 * Trong lúc chờ KHÔNG ESC gì cả: ESC giữa lúc hộp xác nhận còn quay chính là cách
 * bản 3 giây tự bắn vào chân. Hộp "Gỡ suất trả phí?" hiện ra thì trả lời MỘT lần
 * (nó chỉ hiện khi ChatGPT đã gỡ xong người); còn hộp nào nằm lại sau khi dòng đã
 * mất thì để caller dẹp trước khi gõ ô lọc.
 */
export async function waitForRowGone(deps: RowGoneDeps): Promise<RowGoneVerdict> {
  let paidSeat: PaidSeatOutcome = "none";
  let absentTicks = 0;
  /** Nhịp mà dòng được tính là mất; `null` = còn đang chờ dòng. */
  let goneTick: number | null = null;
  for (let tick = 1; tick <= GONE_MAX_TICKS + PAID_SEAT_GRACE_TICKS; tick++) {
    const s = deps.read();
    // Chỉ bấm khi hộp thôi quay, và không bấm lại: hộp còn nằm đó sau cú bấm
    // (ChatGPT hỏi thêm một lượt?) thì caller ghi nguyên văn rồi ESC, chứ không
    // bấm tiếp theo phỏng đoán. `none` = lúc bấm hộp đã không còn → thử nhịp sau.
    if (s.dialog && s.paidSeat && !s.busy && paidSeat === "none") {
      paidSeat = await deps.answerPaidSeat();
    }
    if (goneTick === null) {
      absentTicks = s.row ? 0 : absentTicks + 1;
      if (absentTicks >= (s.busy ? GONE_BUSY_TICKS : GONE_STABLE_TICKS)) {
        goneTick = tick;
      } else if (tick >= GONE_MAX_TICKS) {
        return { gone: false, paidSeat, waitedMs: GONE_MAX_TICKS * GONE_POLL_MS, graceMs: 0 };
      }
    }
    if (goneTick !== null) {
      // Dòng đã mất: hộp suất đã được trả lời (hoặc đã thử) thì đi tiếp ngay; chưa
      // gặp hộp thì nán lại chờ nó hiện muộn, hết quãng thì thôi.
      const graceTicks = tick - goneTick;
      if (paidSeat !== "none" || graceTicks >= PAID_SEAT_GRACE_TICKS) {
        return {
          gone: true,
          paidSeat,
          waitedMs: (goneTick - 1) * GONE_POLL_MS,
          graceMs: graceTicks * GONE_POLL_MS,
        };
      }
    }
    if (tick % GONE_BEAT_TICKS === 0) {
      await deps.beat(tick * GONE_POLL_MS, goneTick === null ? "row" : "paid_seat");
    }
    await deps.sleep(GONE_POLL_MS);
  }
  // Không tới được đây: nhánh dòng mất luôn thoát trong quãng nán, nhánh dòng lì
  // thoát ở trần. Giữ cho TypeScript và cho một lần đổi hằng số sai.
  return { gone: goneTick !== null, paidSeat, waitedMs: GONE_MAX_TICKS * GONE_POLL_MS, graceMs: 0 };
}
