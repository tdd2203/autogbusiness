/**
 * Chốt CHẶN mua nhầm loại suất (user 2026-08-26).
 *
 * Hộp "Quản lý suất" nay có bộ đếm riêng cho từng loại; tăng cả hai thì thẻ tóm
 * tắt viết "Thêm 1 suất Tiêu chuẩn và 1 suất Cao cấp — + 3.505.500 đ/tháng".
 * Suất Cao cấp 3.245.000 đ/tháng, gấp ~12 lần suất Tiêu chuẩn 260.500 đ/tháng.
 *
 * Chốt cũ (`extractAdditionalSeatCountFromModal`) đọc cụm ĐẦU ra đúng 1 nên CHO
 * QUA ca này — test đầu tiên ghim lại đúng cái bẫy đó.
 */
import { describe, expect, it } from "vitest";
import {
  detectMixedSeatTypes,
  extractAdditionalSeatCountFromModal,
} from "./extract-seat-count";

/** Thẻ tóm tắt khi CẢ HAI bộ đếm cùng tăng (ảnh user 26/8/2026). */
const MIXED_CARD = "Thêm 1 suất Tiêu chuẩn và 1 suất Cao cấp + 3.505.500 đ/tháng";

/** Nguyên văn hộp "Quản lý suất" khi CHỈ tăng hàng Tiêu chuẩn (152 → 153). */
const MODAL_STANDARD_ONLY =
  "Quản lý suất Thêm hoặc xóa các suất trong không gian làm việc của bạn. " +
  "Tiêu chuẩn 260.500 đ/tháng 152 người dùng · 143/152 đã gán − 153 + " +
  "Cao cấp 3.245.000 đ/tháng 0 người dùng · 0/0 đã gán − 0 + " +
  "Thêm 1 suất Tiêu chuẩn + 260.500 đ/tháng Quay lại Tiếp tục";

/** Y như trên nhưng bộ đếm Cao cấp cũng bị đẩy lên 1. */
const MODAL_MIXED =
  "Quản lý suất Thêm hoặc xóa các suất trong không gian làm việc của bạn. " +
  "Tiêu chuẩn 260.500 đ/tháng 152 người dùng · 143/152 đã gán − 153 + " +
  "Cao cấp 3.245.000 đ/tháng 0 người dùng · 0/0 đã gán − 1 + " +
  MIXED_CARD +
  " Quay lại Tiếp tục";

describe("detectMixedSeatTypes — chặn mua kèm loại suất khác", () => {
  it("chốt CŨ bỏ lọt ca mua kèm — đây là lý do hàm này tồn tại", () => {
    expect(extractAdditionalSeatCountFromModal(MIXED_CARD)).toBe(1);
  });

  it("thẻ 'Thêm 1 suất Tiêu chuẩn và 1 suất Cao cấp' → CHẶN", () => {
    expect(detectMixedSeatTypes(MIXED_CARD)).toContain("Cao cấp");
  });

  it("cả hộp (có dòng giới thiệu 'Thêm hoặc xóa...') vẫn CHẶN", () => {
    // Bẫy: chữ "Thêm" đầu tiên nằm ở câu giới thiệu, cách thẻ tóm tắt rất xa.
    expect(detectMixedSeatTypes(MODAL_MIXED)).not.toBeNull();
  });

  it("chỉ tăng hàng Tiêu chuẩn → KHÔNG chặn, dù hộp có in hàng Cao cấp", () => {
    expect(detectMixedSeatTypes(MODAL_STANDARD_ONLY)).toBeNull();
  });

  it("hộp CŨ một loại suất → không chặn", () => {
    expect(detectMixedSeatTypes("Thêm 2 suất Tiêu chuẩn + 521.000 đ/tháng")).toBeNull();
    expect(detectMixedSeatTypes("1 suất bổ sung 260.500 đ")).toBeNull();
  });

  it("bản tiếng Anh: 'Add 1 Standard seat and 1 Premium seat' → CHẶN", () => {
    expect(
      detectMixedSeatTypes("Add 1 Standard seat and 1 Premium seat + 3.505.500 đ/month"),
    ).not.toBeNull();
  });

  it("ChatGPT đổi tên loại suất mà vẫn liệt kê 2 cụm → CHẶN theo dấu hiệu số cụm", () => {
    expect(detectMixedSeatTypes("Thêm 1 suất Gói A và 1 suất Gói B")).toContain(
      "2 loại suất",
    );
  });

  it("mua 0 suất loại khác (thẻ nói '0 suất Cao cấp') → không chặn", () => {
    expect(detectMixedSeatTypes("Thêm 1 suất Tiêu chuẩn, 0 suất Cao cấp")).toBeNull();
  });
});
