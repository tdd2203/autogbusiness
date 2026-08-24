/**
 * Hai đường QUYẾT ĐỊNH DÍNH TỚI TIỀN của luồng mời, tách khỏi DOM để test thẳng:
 *
 *   1. `headroomWithoutModal` — có được BỎ QUA hộp "Quản lý suất" mà mời thẳng
 *      không. Sai về phía rộng = mời khi thiếu suất ⇒ ChatGPT bật hộp "Mua suất
 *      người dùng và gửi lời mời": mua ghế bằng tiền thật trong một cú bấm, số
 *      tiền do ChatGPT tự quyết, không ai duyệt.
 *   2. `canDeriveTotalAfterPurchase` — mua bù xong có được SUY RA tổng suất mới
 *      từ bộ đếm của hộp mua thay vì mở lại hộp đọc kiểm không. Sai về phía rộng
 *      dẫn tới đúng cái hộp mua-kèm-mời ở trên, chỉ muộn hơn một bước.
 *
 * Số liệu trong test lấy từ production 24/8/2026: GPT1 `148/151 đã gán` + 1 lời
 * mời chờ; CHATGPT PRO `60/60 đã gán` + 1 lời mời chờ (hết sạch suất trống).
 */
import { describe, expect, it } from "vitest";
import {
  canDeriveTotalAfterPurchase,
  headroomWithoutModal,
  type SeatHint,
} from "./ensure-seats";

/** GPT1 lúc 04:44 24/8/2026: 151 suất, 148 active + 1 chờ = 149 chưa bị gỡ. */
const GPT1: SeatHint = { total: 151, occupied: 149 };

describe("headroomWithoutModal — có dám bỏ qua hộp 'Quản lý suất' không", () => {
  it("thừa rõ ràng → mời thẳng", () => {
    // 151 − 149 = 2 trống, cần 1, đòi dư 1 ⇒ vừa đủ điều kiện.
    const r = headroomWithoutModal(1, GPT1, 148);
    expect(r.enough).toBe(true);
    expect(r.total).toBe(151);
    expect(r.occupied).toBe(149);
    expect(r.free).toBe(2);
  });

  it("vừa khít KHÔNG tính là thừa — phải còn dư 1 suất mới dám", () => {
    // 2 trống, cần đúng 2 → không còn dư ⇒ mở hộp đếm tận nơi.
    expect(headroomWithoutModal(2, GPT1, 148).enough).toBe(false);
  });

  it("dashboard chưa biết tổng suất → không kết luận gì, mở hộp", () => {
    const r = headroomWithoutModal(1, { total: null, occupied: 149 }, 148);
    expect(r.enough).toBe(false);
    expect(r.free).toBeNull();
  });

  it("không có hint (backend cũ chưa gửi) → mở hộp", () => {
    expect(headroomWithoutModal(1, undefined, 148).enough).toBe(false);
  });

  it("số đang chiếm lấy bên LỚN HƠN: trang cao hơn DB", () => {
    // DB sót người vào ChatGPT bằng đường khác → tin số trên trang.
    const r = headroomWithoutModal(1, { total: 151, occupied: 140 }, 149);
    expect(r.occupied).toBe(149);
    expect(r.free).toBe(2);
  });

  it("số đang chiếm lấy bên LỚN HƠN: DB cao hơn trang", () => {
    // Trang chỉ đếm người ĐÃ tham gia, không thấy lời mời chờ → tin số DB.
    const r = headroomWithoutModal(1, GPT1, 148);
    expect(r.occupied).toBe(149);
  });

  it("không đọc được số trên trang → vẫn dùng được số DB", () => {
    const r = headroomWithoutModal(1, GPT1, null);
    expect(r.enough).toBe(true);
    expect(r.occupied).toBe(149);
  });

  it("cả hai nguồn đều nói 0 người → số vô lý, không tin", () => {
    // Workspace 151 suất mà 0 người là dấu hiệu đọc hỏng, không phải thừa 151 chỗ.
    const r = headroomWithoutModal(1, { total: 151, occupied: 0 }, null);
    expect(r.enough).toBe(false);
    expect(r.occupied).toBeNull();
  });

  it("CHATGPT PRO hết sạch suất → không bao giờ đi đường tắt", () => {
    // 60/60 đã gán + 1 lời mời chờ ⇒ occupied 61 > total 60, trống âm.
    const r = headroomWithoutModal(1, { total: 60, occupied: 61 }, 60);
    expect(r.enough).toBe(false);
    expect(r.free).toBe(-1);
  });

  it("mời lô lớn: dư 5 thì mời được 4, không mời được 5", () => {
    const hint: SeatHint = { total: 151, occupied: 146 };
    expect(headroomWithoutModal(4, hint, null).enough).toBe(true);
    expect(headroomWithoutModal(5, hint, null).enough).toBe(false);
  });
});

describe("canDeriveTotalAfterPurchase — có dám tin bộ đếm hộp mua không", () => {
  /** Ca chuẩn: đang có 150 suất, mua bù 1, hộp xác nhận đã đóng. */
  const OK = {
    charge_modal_dismissed: true,
    initial_seat: 150,
    target_seat: 151,
  };

  it("cả ba khớp → suy ra được, khỏi mở lại hộp", () => {
    expect(canDeriveTotalAfterPurchase(OK, 150, 1)).toBe(true);
  });

  it("hộp xác nhận CHƯA đóng → chưa chắc giao dịch đã đi qua, đọc lại", () => {
    expect(
      canDeriveTotalAfterPurchase({ ...OK, charge_modal_dismissed: false }, 150, 1),
    ).toBe(false);
    const { charge_modal_dismissed: _drop, ...missing } = OK;
    expect(canDeriveTotalAfterPurchase(missing, 150, 1)).toBe(false);
  });

  it("cờ đóng hộp là chuỗi 'true' → KHÔNG nhận, phải đúng boolean", () => {
    expect(
      canDeriveTotalAfterPurchase(
        { ...OK, charge_modal_dismissed: "true" },
        150,
        1,
      ),
    ).toBe(false);
  });

  it("bộ đếm khởi điểm lệch tổng vừa đọc → hai bên đọc khác nhau, đọc lại", () => {
    // Đúng ca GPT1: hộp đọc ra 151 mà bộ đếm khởi điểm 150.
    expect(canDeriveTotalAfterPurchase(OK, 151, 1)).toBe(false);
  });

  it("điểm đến thiếu so với số cần mua → đọc lại", () => {
    // Cần bù 2 mà bộ đếm chỉ nhích lên 1 ⇒ mời tiếp là thiếu suất.
    expect(canDeriveTotalAfterPurchase(OK, 150, 2)).toBe(false);
  });

  it("điểm đến THỪA cũng không nhận — so bằng, không so 'đủ lớn'", () => {
    expect(
      canDeriveTotalAfterPurchase({ ...OK, target_seat: 152 }, 150, 1),
    ).toBe(false);
  });

  it("bộ đếm không đọc được (thiếu / null / chuỗi / số lẻ) → đọc lại", () => {
    expect(canDeriveTotalAfterPurchase({ ...OK, initial_seat: null }, 150, 1)).toBe(
      false,
    );
    expect(canDeriveTotalAfterPurchase({ ...OK, target_seat: "151" }, 150, 1)).toBe(
      false,
    );
    expect(
      canDeriveTotalAfterPurchase({ ...OK, target_seat: 151.5 }, 150, 1),
    ).toBe(false);
    expect(canDeriveTotalAfterPurchase({ charge_modal_dismissed: true }, 150, 1)).toBe(
      false,
    );
  });

  it("payload rỗng → đọc lại", () => {
    expect(canDeriveTotalAfterPurchase({}, 150, 1)).toBe(false);
  });
});
