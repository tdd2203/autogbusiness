/**
 * Text mẫu lấy từ ảnh chụp modal "Quản lý suất" của user 2026-08-22
 * (workspace hiển thị "Business · 52 thành viên").
 *
 * Điểm mấu chốt: trang nói 52 THÀNH VIÊN, còn modal nói ĐÃ MUA 53 suất và gán
 * 52 → còn trống ĐÚNG 1. Nếu lấy số thành viên trên trang làm số suất thì tính
 * ra 0 suất trống và sẽ đi mua thừa.
 */
import { describe, expect, it } from "vitest";
import { parseSeatAvailability } from "./parse-seat-availability";

const MODAL_QUAN_LY_SUAT =
  "Quản lý suất" +
  "Thêm hoặc xóa các suất trong không gian làm việc của bạn." +
  "Tiêu chuẩn 649.000 đ/tháng" +
  "53 người dùng · 52/53 đã gán" +
  "53" +
  "Quay lại" +
  "Tiếp tục";

describe("parseSeatAvailability", () => {
  it("'53 người dùng · 52/53 đã gán' → tổng 53, gán 52, trống 1", () => {
    expect(parseSeatAvailability(MODAL_QUAN_LY_SUAT)).toEqual({
      total: 53,
      assigned: 52,
      free: 1,
    });
  });

  it("workspace đã dùng hết suất → trống 0", () => {
    expect(parseSeatAvailability("47 người dùng · 47/47 đã gán")).toEqual({
      total: 47,
      assigned: 47,
      free: 0,
    });
  });

  it("ảnh đầu tiên của user: 47 người dùng · 46/47 đã gán → trống 1", () => {
    expect(parseSeatAvailability("47 người dùng · 46/47 đã gán")).toEqual({
      total: 47,
      assigned: 46,
      free: 1,
    });
  });

  it("EN 'assigned'", () => {
    expect(parseSeatAvailability("53 users · 52/53 assigned")).toEqual({
      total: 53,
      assigned: 52,
      free: 1,
    });
  });

  it("gán vượt tổng (over-limit) → trống 0, không ra số âm", () => {
    expect(parseSeatAvailability("10 người dùng · 12/10 đã gán")).toEqual({
      total: 10,
      assigned: 12,
      free: 0,
    });
  });

  it("không có cụm tỉ lệ → null (caller phải coi là KHÔNG đọc được)", () => {
    expect(parseSeatAvailability("Tiêu chuẩn 649.000 đ/tháng")).toBeNull();
  });

  it("KHÔNG nhầm '649.000 đ/tháng' thành tỉ lệ suất", () => {
    expect(
      parseSeatAvailability("Tiêu chuẩn 649.000 đ/tháng Quay lại Tiếp tục"),
    ).toBeNull();
  });
});
