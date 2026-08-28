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
  headroomFromPage,
  headroomWithoutModal,
  totalFromPageCardsAfterPurchase,
  type SeatHint,
} from "./ensure-seats";
import { parseSeatCards } from "../purchase-seat/read-seat-cards";

/**
 * ══ LUỒNG ĐÃ CHỐT — TEST KHOÁ, ĐỪNG SỬA NẾU CHƯA HỎI USER (28/8/2026) ═══════
 *
 * Ảnh user gửi 28/8/2026 (GPT1):
 *   tiêu đề       "Business · 253 thành viên"
 *   thẻ suất      Suất Tiêu chuẩn 270, Đã gán 253/270 · Suất Cao cấp 0, Đã gán 0/0
 *   tab Lời mời   7 dòng, tất cả loại "Tiêu chuẩn"
 *
 * Kết luận user chốt: 253 + 7 = 260 đang chiếm trên 270 suất ⇒ CÒN 10 CHỖ ⇒
 * mời thêm được, KHÔNG mua gì.
 *
 * Đổi bất kỳ vế nào của phép tính này là đổi chỗ TIÊU TIỀN THẬT.
 */
const GPT1_28_8 = parseSeatCards(
  "Suất Tiêu chuẩn Đã gán 253/270 270 Suất Cao cấp Đã gán 0/0 0",
);
/** Số in ở tiêu đề trang cùng thời điểm. */
const GPT1_28_8_MEMBERS = 253;
/** Số dòng đếm được ở tab "Lời mời đang chờ xử lý". */
const GPT1_28_8_PENDING = 7;

describe("headroomFromPage — LUỒNG CHỐT: thành viên + thẻ suất + tab Lời mời", () => {
  it("ẢNH USER 28/8/2026: 253 đã gán + 7 lời mời chờ / 270 suất ⇒ còn 10, mời không mua", () => {
    const r = headroomFromPage(
      1,
      GPT1_28_8,
      GPT1_28_8_MEMBERS,
      GPT1_28_8_PENDING,
    );
    expect(r.total).toBe(270);
    expect(r.assigned).toBe(253);
    expect(r.pending).toBe(7);
    expect(r.free).toBe(10);
    expect(r.enough).toBe(true);
  });

  it("mời được ĐÚNG 10 người, người thứ 11 phải mua bù", () => {
    const at = (need: number) =>
      headroomFromPage(need, GPT1_28_8, GPT1_28_8_MEMBERS, GPT1_28_8_PENDING)
        .enough;
    expect(at(10)).toBe(true);
    expect(at(11)).toBe(false);
  });

  it("KHÔNG đòi dư thêm 1 suất: mọi số đều vừa đọc trên ChatGPT", () => {
    // Khác `headroomWithoutModal` (đòi dư 1 vì `seat_total` của DB có thể cũ).
    const tight = parseSeatCards("Suất Tiêu chuẩn Đã gán 269/270 270");
    expect(headroomFromPage(1, tight, 269, 0).free).toBe(1);
    expect(headroomFromPage(1, tight, 269, 0).enough).toBe(true);
  });

  it("lời mời đang chờ LÀ NỢ SUẤT — trừ đúng như người đã tham gia", () => {
    // Bỏ quên 7 lời mời chờ thì tưởng còn 17 chỗ. Ca CHATGPT PRO 24/8/2026 cho
    // thấy chiều ngược lại: "60/60 đã gán" mà vẫn treo 1 lời mời chưa ai nhận.
    expect(headroomFromPage(1, GPT1_28_8, 253, 0).free).toBe(17);
    expect(headroomFromPage(17, GPT1_28_8, 253, 7).enough).toBe(false);
  });

  it("suất Cao cấp CỘNG GỘP vào tổng (user chốt 28/8/2026)", () => {
    const mixed = parseSeatCards(
      "Suất Tiêu chuẩn Đã gán 250/250 250 Suất Cao cấp Đã gán 3/20 20",
    );
    const r = headroomFromPage(1, mixed, 253, 0);
    expect(r.total).toBe(270);
    expect(r.assigned).toBe(253);
    expect(r.free).toBe(17);
  });

  it("đã gán lấy bên LỚN HƠN giữa thẻ suất và số thành viên ở tiêu đề", () => {
    // Một bên vừa được vẽ lại trước bên kia → lấy bên lớn, thà mở hộp thừa.
    expect(headroomFromPage(1, GPT1_28_8, 258, 7).assigned).toBe(258);
    expect(headroomFromPage(1, GPT1_28_8, 258, 7).free).toBe(5);
    expect(headroomFromPage(1, GPT1_28_8, null, 7).assigned).toBe(253);
  });

  it("KHÔNG đếm được lời mời chờ → không kết luận gì, caller phải rơi về lưới đỡ", () => {
    const r = headroomFromPage(1, GPT1_28_8, GPT1_28_8_MEMBERS, null);
    expect(r.enough).toBe(false);
    expect(r.free).toBeNull();
  });

  it("KHÔNG đọc được thẻ suất → không kết luận gì", () => {
    const r = headroomFromPage(1, null, GPT1_28_8_MEMBERS, 7);
    expect(r.enough).toBe(false);
    expect(r.free).toBeNull();
  });

  it("workspace ÂM CHỖ → chỗ trống kẹp sàn 0, không bao giờ nói 'đủ'", () => {
    // CHATGPT PRO 24/8/2026: 60/60 đã gán + 1 lời mời chờ.
    const full = parseSeatCards("Suất Tiêu chuẩn Đã gán 60/60 60");
    const r = headroomFromPage(1, full, 60, 1);
    expect(r.free).toBe(0);
    expect(r.enough).toBe(false);
  });
});

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

describe("headroomWithoutModal — khi trang IN SẴN số suất (UI mới 26/8/2026)", () => {
  /** "Suất Tiêu chuẩn · Đã gán 148/151" — số THẬT ChatGPT đang hiển thị. */
  const CARDS_151 = parseSeatCards("Suất Tiêu chuẩn Đã gán 148/151 151");

  it("tổng lấy theo THẺ TRÊN TRANG, không lấy số DB đang cũ", () => {
    // DB còn ghi 148 suất (cũ) trong khi ChatGPT đã 151 → đường tắt cũ thấy
    // 148 − 149 < 0 nên bỏ lỡ, phải mở hộp. Có thẻ thì thấy đúng 151.
    const stale: SeatHint = { total: 148, occupied: 149 };
    expect(headroomWithoutModal(1, stale, 148).enough).toBe(false);
    const r = headroomWithoutModal(1, stale, 148, CARDS_151);
    expect(r.enough).toBe(true);
    expect(r.total).toBe(151);
    expect(r.source).toBe("page_cards");
  });

  it("số đang chiếm vẫn lấy bên LỚN NHẤT — kể cả 'đã gán' của thẻ", () => {
    // Thẻ nói đã gán 148, DB mới biết 140 → phải tin 148.
    const r = headroomWithoutModal(1, { total: 151, occupied: 140 }, null, CARDS_151);
    expect(r.occupied).toBe(148);
    expect(r.free).toBe(3);
  });

  it("KHÔNG có hint thì vẫn đi đường đầy đủ, dù đọc được thẻ", () => {
    // `hint.occupied` là nguồn duy nhất ở đường tắt biết tới LỜI MỜI ĐANG CHỜ —
    // thẻ chỉ đếm người đã tham gia. Thiếu nó thì phải đi đếm tận nơi.
    const r = headroomWithoutModal(1, undefined, 148, CARDS_151);
    expect(r.enough).toBe(false);
    expect(r.source).toBeNull();
  });

  it("hết suất theo thẻ → không đường tắt nào cả", () => {
    const full = parseSeatCards("Suất Tiêu chuẩn Đã gán 60/60 60");
    const r = headroomWithoutModal(1, { total: 62, occupied: 60 }, 60, full);
    expect(r.enough).toBe(false);
    expect(r.free).toBe(0);
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

/**
 * Đường xác nhận MỚI (user 2026-08-26): luồng mua tự chờ thẻ "Suất Tiêu chuẩn"
 * trên trang nhích lên rồi mới trả về. Có nó thì luồng mời không phải mở lại hộp
 * "Quản lý suất" — kể cả khi hộp thanh toán chưa đóng sạch.
 */
describe("totalFromPageCardsAfterPurchase — tin số suất in trên trang", () => {
  /** Ảnh user 26/8: đang 66 suất, mua bù 2, trang hiện 68. */
  const OK = { seat_page_verified: true, seat_page_total_after: 68 };

  it("trang xác nhận đủ → lấy luôn số của trang", () => {
    expect(totalFromPageCardsAfterPurchase(OK, 66, 2)).toBe(68);
  });

  it("hộp thanh toán chưa đóng vẫn nhận — số suất đã lên là giao dịch đã đi qua", () => {
    expect(
      totalFromPageCardsAfterPurchase(
        { ...OK, charge_modal_dismissed: false },
        66,
        2,
      ),
    ).toBe(68);
  });

  it("admin khác vừa mua thêm → tổng cao hơn vẫn nhận, lấy đúng số thật", () => {
    expect(
      totalFromPageCardsAfterPurchase({ ...OK, seat_page_total_after: 70 }, 66, 2),
    ).toBe(70);
  });

  it("trang chưa xác nhận → null, quay về đường đọc kiểm", () => {
    expect(totalFromPageCardsAfterPurchase({ seat_page_total_after: 68 }, 66, 2)).toBeNull();
    expect(
      totalFromPageCardsAfterPurchase(
        { ...OK, seat_page_verified: false },
        66,
        2,
      ),
    ).toBeNull();
    expect(
      totalFromPageCardsAfterPurchase({ ...OK, seat_page_verified: "true" }, 66, 2),
    ).toBeNull();
  });

  it("tổng mới THIẾU so với số cần mua → null, không mời liều", () => {
    expect(
      totalFromPageCardsAfterPurchase({ ...OK, seat_page_total_after: 67 }, 66, 2),
    ).toBeNull();
  });

  it("không có số sau khi mua → null", () => {
    expect(
      totalFromPageCardsAfterPurchase({ seat_page_verified: true }, 66, 2),
    ).toBeNull();
    expect(
      totalFromPageCardsAfterPurchase(
        { ...OK, seat_page_total_after: "68" },
        66,
        2,
      ),
    ).toBeNull();
  });
});
