/**
 * Lệnh đồng bộ lời mời phải mang số suất về (user 2026-08-31): nó đứng sẵn ở tab
 * "Người dùng" — nơi in hàng thẻ suất — mà trước đây đi về tay không, nên tổng
 * suất trên dashboard đứng im hàng tuần.
 *
 * Chốt hai chiều: đọc được thì gắn ĐÚNG cặp số cho `_absorb_seat_reading`; đọc
 * không được thì KHÔNG gắn gì (gắn 0 là backend ghi đè số cũ bằng số rỗng).
 */
import { describe, expect, it } from "vitest";
import { parseSeatCards } from "../purchase-seat/read-seat-cards";
import { seatFieldsOf } from "./read-seat-fields";

/** Nguyên văn tab "Người dùng" của CHATGPT PRO ngày 31/8/2026 (rút gọn). */
const MEMBERS_PAGE =
  "Thành viên Business · 291 thành viên " +
  "Người dùng Lời mời đang chờ xử lý Yêu cầu đang chờ xử lý " +
  "Suất Tiêu chuẩn Đã gán 291/302 302 " +
  "Suất Cao cấp Đã gán 0/0 0 " +
  "Lọc theo tên Tất cả các vai trò Quản lý số suất + Mời thành viên";

describe("seatFieldsOf — số suất nhặt trong lúc đồng bộ lời mời", () => {
  it("cộng mọi loại suất rồi gắn vào result cho backend ghi vào workspace", () => {
    expect(seatFieldsOf(parseSeatCards(MEMBERS_PAGE))).toEqual({
      seat_total: 302,
      seat_assigned: 291,
    });
  });

  it("không đọc được hàng thẻ → không gắn gì, backend giữ nguyên số cũ", () => {
    expect(seatFieldsOf(null)).toEqual({});
    expect(seatFieldsOf(parseSeatCards("Lọc theo tên Tất cả các vai trò"))).toEqual(
      {},
    );
  });

  it("workspace 0 suất (chưa mua gì) cũng không ghi đè số cũ", () => {
    expect(seatFieldsOf(parseSeatCards("Suất Tiêu chuẩn Đã gán 0/0 0"))).toEqual({});
  });
});
