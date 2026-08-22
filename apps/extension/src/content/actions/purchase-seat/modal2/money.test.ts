/**
 * Text mẫu lấy từ ảnh chụp modal "Xem lại giao dịch mua" của user 2026-08-22
 * (ChatGPT Business, locale vi, workspace 47 ghế Tiêu chuẩn).
 *
 * Bản cũ đọc tiền bằng nhãn "Tổng đến hạn hôm nay" + kiểu `đ` đứng TRƯỚC số, và
 * có fallback "lấy cụm tiền đầu tiên gặp trong text". Với UI mới, fallback đó
 * trả `649.000 đ` (đơn giá 1 suất/tháng) trong khi tiền thật vừa bị trừ là
 * `27.168 đ` → audit sai ~24 lần. Các test dưới khoá cả 2 lỗi đó lại.
 */
import { describe, expect, it } from "vitest";
import {
  extractChargeAmountFromModal,
  extractSalesTax,
  extractMonthlyBills,
  extractProrationSubtotal,
  parseVndAmount,
} from "./money";
import { extractAdditionalSeatCountFromModal } from "./extract-seat-count";

/** textContent của modal — các node dính liền nhau, KHÔNG có space chen giữa. */
const MODAL_VI =
  "Xem lại giao dịch mua" +
  "Các suất mới được tính phí theo tỷ lệ đến chu kỳ thanh toán tiếp theo." +
  "Thêm 1 suất Tiêu chuẩn" +
  "Có hiệu lực ngay lập tức" +
  "+ 649.000 đ/tháng" +
  "Hóa đơn hằng tháng hiện tại" +
  "12.243.500 đ + thuế" +
  "47 ghế Tiêu chuẩn" +
  "Hóa đơn mới hằng tháng" +
  "12.504.000 đ + thuế" +
  "48 ghế Tiêu chuẩn" +
  "Tạm tính theo tỷ lệ" +
  "24.698 đ" +
  "Thuế bán hàng (10,001%)" +
  "2.470 đ" +
  "Tổng phải trả hôm nay" +
  "27.168 đ" +
  "VISA •••• 4481" +
  "Thay đổi" +
  "Quay lại" +
  "Xác nhận mua";

/** Biến thể: cột tiền đứng SAU dòng phụ "47 ghế Tiêu chuẩn" trong DOM order. */
const MODAL_VI_AMOUNT_AFTER_SUBTITLE =
  "Thêm 1 suất Tiêu chuẩn+ 649.000 đ/tháng" +
  "Hóa đơn hằng tháng hiện tại47 ghế Tiêu chuẩn12.243.500 đ + thuế" +
  "Hóa đơn mới hằng tháng48 ghế Tiêu chuẩn12.504.000 đ + thuế" +
  "Tổng phải trả hôm nay27.168 đ";

/**
 * Ảnh chụp thứ 2 của user (workspace 52 thành viên, mua 2 suất). Quan trọng vì
 * ở workspace này ĐƠN GIÁ và MỨC TĂNG THẬT lệch nhau 2,5 lần:
 *   dòng đơn giá:  + 1.298.000 đ/tháng  (2 × 649.000)
 *   hoá đơn thật:  13.806.500 → 14.327.500 = +521.000  (2 × 260.500)
 * Đọc nhầm dòng đơn giá là ghi audit sai khoản tiền cố định hằng tháng.
 */
const MODAL_VI_2_SUAT =
  "Xem lại giao dịch mua" +
  "Các suất mới được tính phí theo tỷ lệ đến chu kỳ thanh toán tiếp theo." +
  "Thêm 2 suất Tiêu chuẩn" +
  "Có hiệu lực ngay lập tức" +
  "+ 1.298.000 đ/tháng" +
  "Hóa đơn hằng tháng hiện tại" +
  "13.806.500 đ + thuế" +
  "53 ghế Tiêu chuẩn" +
  "Hóa đơn mới hằng tháng" +
  "14.327.500 đ + thuế" +
  "55 ghế Tiêu chuẩn" +
  "Tạm tính theo tỷ lệ" +
  "48.027 đ" +
  "Thuế bán hàng (10,001%)" +
  "4.803 đ" +
  "Tổng phải trả hôm nay" +
  "52.830 đ" +
  "Visa •••• 4481" +
  "Thay đổi" +
  "Quay lại" +
  "Xác nhận mua";

describe("Ảnh thật #2 — mua 2 suất (workspace 53 ghế)", () => {
  it("tổng phải trả hôm nay = 52.830 đ, KHÔNG phải 1.298.000 đ hay 48.027 đ", () => {
    expect(extractChargeAmountFromModal(MODAL_VI_2_SUAT)).toBe("52.830 đ");
  });

  it("mức tăng hằng tháng THẬT = 521.000 đ, không phải 1.298.000 đ của dòng đơn giá", () => {
    const bills = extractMonthlyBills(MODAL_VI_2_SUAT);
    expect(bills.currentVnd).toBe(13_806_500);
    expect(bills.newVnd).toBe(14_327_500);
    expect(bills.deltaVnd).toBe(521_000);
  });

  it("số ghế 53 → 55, chênh lệch đúng bằng 2 suất đang mua", () => {
    const bills = extractMonthlyBills(MODAL_VI_2_SUAT);
    expect(bills.currentSeats).toBe(53);
    expect(bills.newSeats).toBe(55);
    expect(bills.seatDelta).toBe(2);
  });

  it("số suất thêm = 2", () => {
    expect(extractAdditionalSeatCountFromModal(MODAL_VI_2_SUAT)).toBe(2);
  });

  it("tạm tính theo tỷ lệ = 48.027 đ (không lẫn thuế 4.803 đ)", () => {
    expect(extractProrationSubtotal(MODAL_VI_2_SUAT)).toBe("48.027 đ");
  });

  it("KHÔNG có hàm nào trả về dòng đơn giá niêm yết 1.298.000 đ", () => {
    // Workspace được GIẢM GIÁ: niêm yết 649.000/suất nhưng thực trả 260.500.
    // Bất kỳ số liệu nào lỡ đọc trúng dòng niêm yết là ghi audit sai 2,5 lần.
    const bills = extractMonthlyBills(MODAL_VI_2_SUAT);
    const readings = [
      extractChargeAmountFromModal(MODAL_VI_2_SUAT),
      extractProrationSubtotal(MODAL_VI_2_SUAT),
      bills.currentText,
      bills.newText,
    ];
    for (const r of readings) {
      expect(r).not.toContain("1.298.000");
      expect(r).not.toContain("649.000");
    }
  });

  it("thuế bán hàng = 4.803 đ, tỷ lệ 10,001%", () => {
    const tax = extractSalesTax(MODAL_VI_2_SUAT);
    expect(tax.text).toBe("4.803 đ");
    expect(tax.percent).toBe("10,001");
  });

  it("tổng hôm nay = tạm tính + thuế (48.027 + 4.803 = 52.830)", () => {
    // Xác nhận 3 con số ăn khớp nhau → đọc đúng cả 3 dòng, không lệch dòng.
    const sub = parseVndAmount(extractProrationSubtotal(MODAL_VI_2_SUAT));
    const tax = parseVndAmount(extractSalesTax(MODAL_VI_2_SUAT).text);
    const total = parseVndAmount(extractChargeAmountFromModal(MODAL_VI_2_SUAT));
    expect(sub! + tax!).toBe(total);
  });

  it("hoá đơn hằng tháng là TRƯỚC thuế — modal ghi rõ '+ thuế'", () => {
    // Ràng buộc tài liệu hoá: 521.000 KHÔNG phải chi phí thật hằng tháng.
    // Còn phải cộng thuế, và phí ngân hàng/quy đổi thì modal không hề biết.
    expect(MODAL_VI_2_SUAT).toContain("13.806.500 đ + thuế");
    expect(MODAL_VI_2_SUAT).toContain("14.327.500 đ + thuế");
  });

  it("prorate khớp với GIÁ SAU GIẢM chứ không phải giá niêm yết", () => {
    const bills = extractMonthlyBills(MODAL_VI_2_SUAT);
    const prorate = parseVndAmount(extractProrationSubtotal(MODAL_VI_2_SUAT));
    // 48.027 / 521.000 ≈ 9,2% — cùng tỷ lệ với workspace 47 ghế (24.698/260.500
    // ≈ 9,5%). Nếu tính theo niêm yết 1.298.000 thì ra 3,7%, lệch hẳn.
    const ratio = prorate! / bills.deltaVnd!;
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.11);
  });
});

describe("extractChargeAmountFromModal — 'Tổng phải trả hôm nay' (UI 2026-08-22)", () => {
  it("lấy ĐÚNG tổng hôm nay, KHÔNG lấy đơn giá 649.000 đ/tháng đứng trước", () => {
    expect(extractChargeAmountFromModal(MODAL_VI)).toBe("27.168 đ");
  });

  it("`đ` đứng SAU số vẫn đọc được (UI cũ để `đ` đứng trước)", () => {
    expect(
      extractChargeAmountFromModal("Tổng phải trả hôm nay 1.234.567 đ"),
    ).toBe("1.234.567 đ");
  });

  it("vẫn đọc được nhãn UI cũ 'Tổng đến hạn hôm nay' + đ đứng trước", () => {
    expect(
      extractChargeAmountFromModal("Tổng đến hạn hôm nay đ2080.24"),
    ).toBe("đ2080.24");
  });

  it("EN 'Total due today'", () => {
    expect(extractChargeAmountFromModal("Total due today $27.17")).toBe("$27.17");
  });

  it("KHÔNG có nhãn tổng → trả null, KHÔNG đoán bừa cụm tiền đầu tiên", () => {
    expect(
      extractChargeAmountFromModal("Thêm 1 suất Tiêu chuẩn+ 649.000 đ/tháng"),
    ).toBeNull();
  });

  it("prorate đổi mỗi lần mở modal — đọc lần nào ra đúng lần đó", () => {
    // User mở modal 3 lần liên tiếp, ChatGPT tính lại theo số giây còn lại.
    for (const amount of ["27.311 đ", "27.191 đ", "27.168 đ"]) {
      expect(
        extractChargeAmountFromModal(`Tổng phải trả hôm nay${amount}`),
      ).toBe(amount);
    }
  });
});

describe("extractMonthlyBills — khoản tăng CỐ ĐỊNH hằng tháng", () => {
  it("tách đúng 'hiện tại' và 'mới' dù 2 nhãn chỉ khác nhau 1 từ", () => {
    const bills = extractMonthlyBills(MODAL_VI);
    expect(bills.currentText).toBe("12.243.500 đ");
    expect(bills.newText).toBe("12.504.000 đ");
    expect(bills.currentVnd).toBe(12_243_500);
    expect(bills.newVnd).toBe(12_504_000);
    // 260.500 đ/tháng — số user chốt trong yêu cầu.
    expect(bills.deltaVnd).toBe(260_500);
  });

  it("đọc được cả khi cột tiền đứng sau dòng phụ '47 ghế Tiêu chuẩn'", () => {
    const bills = extractMonthlyBills(MODAL_VI_AMOUNT_AFTER_SUBTITLE);
    expect(bills.currentVnd).toBe(12_243_500);
    expect(bills.newVnd).toBe(12_504_000);
    expect(bills.deltaVnd).toBe(260_500);
  });

  it("thiếu dòng 'hóa đơn mới' → KHÔNG mượn số của dòng dưới", () => {
    const bills = extractMonthlyBills(
      "Hóa đơn hằng tháng hiện tại12.243.500 đ + thuếTổng phải trả hôm nay27.168 đ",
    );
    expect(bills.currentVnd).toBe(12_243_500);
    expect(bills.newText).toBeNull();
    expect(bills.deltaVnd).toBeNull();
  });

  it("chấp nhận cách viết 'Hoá đơn' (không dấu sắc trên o)", () => {
    const bills = extractMonthlyBills(
      "Hoá đơn hằng tháng hiện tại1.000.000 đHoá đơn mới hằng tháng1.260.500 đ",
    );
    expect(bills.deltaVnd).toBe(260_500);
  });
});

describe("REGRESSION: nhãn lỏng vớ nhầm dòng ĐƠN GIÁ", () => {
  // Phụ đề modal có sẵn cụm "tính phí THEO TỶ LỆ đến chu kỳ thanh toán tiếp
  // theo". Nhãn lỏng /theo ty le/ khớp trúng phụ đề, và cụm tiền gần nhất phía
  // sau lại chính là dòng đơn giá niêm yết → đọc ra 1.298.000 thay vì phần
  // prorate. Bản trước thoát chỉ vì cửa sổ 90 ký tự cắt đúng giữa số và chữ "đ".
  const PHU_DE_NGAN =
    "Xem lại giao dịch mua" +
    "Các suất mới tính phí theo tỷ lệ đến chu kỳ sau." +
    "Thêm 2 suất Tiêu chuẩn" +
    "Có hiệu lực ngay+ 1.298.000 đ/tháng" +
    "Tổng phải trả hôm nay52.830 đ";

  it("thiếu dòng 'Tạm tính theo tỷ lệ' → trả null, KHÔNG lấy đơn giá từ phụ đề", () => {
    expect(extractProrationSubtotal(PHU_DE_NGAN)).toBeNull();
  });

  it("tổng phải trả hôm nay vẫn đọc đúng trong cùng text đó", () => {
    expect(extractChargeAmountFromModal(PHU_DE_NGAN)).toBe("52.830 đ");
  });
});

describe("REGRESSION: tiền và số ghế phải cùng MỘT dòng", () => {
  // Dòng "hiện tại" có tiền nhưng KHÔNG có số ghế. Nếu dò tiền và ghế độc lập,
  // ghế sẽ rơi xuống nhãn dự phòng khác → ghép số của 2 dòng khác nhau rồi đem
  // so với số suất đang mua.
  const THIEU_GHE_DONG_DAU =
    "Hóa đơn hằng tháng hiện tại13.806.500 đ + thuế" +
    "Hóa đơn mới hằng tháng14.327.500 đ + thuế55 ghế Tiêu chuẩn";

  it("dòng hiện tại không có ghế → currentSeats null, seatDelta null", () => {
    const bills = extractMonthlyBills(THIEU_GHE_DONG_DAU);
    expect(bills.currentVnd).toBe(13_806_500);
    expect(bills.currentSeats).toBeNull();
    expect(bills.newSeats).toBe(55);
    // KHÔNG được ra 55 - <ghế mượn của dòng khác>.
    expect(bills.seatDelta).toBeNull();
  });
});

describe("extractProrationSubtotal", () => {
  it("'Tạm tính theo tỷ lệ' → 24.698 đ (không lẫn với thuế 2.470 đ)", () => {
    expect(extractProrationSubtotal(MODAL_VI)).toBe("24.698 đ");
  });
});

describe("parseVndAmount", () => {
  it("bỏ dấu chấm phân cách nghìn", () => {
    expect(parseVndAmount("12.504.000 đ")).toBe(12_504_000);
    expect(parseVndAmount("27.168 đ")).toBe(27_168);
  });

  it("USD trả null — dấu chấm ở đó là thập phân, đoán bừa ra số sai 100 lần", () => {
    expect(parseVndAmount("$27.17")).toBeNull();
  });

  it("null in → null out", () => {
    expect(parseVndAmount(null)).toBeNull();
  });
});

describe("extractAdditionalSeatCountFromModal — chốt an toàn số suất", () => {
  it("UI mới 'Thêm 1 suất Tiêu chuẩn' → 1", () => {
    expect(extractAdditionalSeatCountFromModal(MODAL_VI)).toBe(1);
  });

  it("KHÔNG bắt nhầm '47 ghế' / '48 ghế' làm số suất thêm", () => {
    expect(
      extractAdditionalSeatCountFromModal(
        "Hóa đơn hằng tháng hiện tại47 ghế Tiêu chuẩnHóa đơn mới hằng tháng48 ghế Tiêu chuẩn",
      ),
    ).toBeNull();
  });

  it("nhiều suất: 'Thêm 5 suất Tiêu chuẩn' → 5", () => {
    expect(extractAdditionalSeatCountFromModal("Thêm 5 suất Tiêu chuẩn")).toBe(5);
  });

  it("UI cũ '3 suất bổ sung' vẫn đọc được", () => {
    expect(extractAdditionalSeatCountFromModal("3 suất cấp phép bổ sung")).toBe(3);
  });

  it("EN 'Add 2 Standard seats' → 2", () => {
    expect(extractAdditionalSeatCountFromModal("Add 2 Standard seats")).toBe(2);
  });
});
