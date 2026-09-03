/**
 * Luật "danh sách đã đổi chưa" — chốt thứ hai của việc chuyển tab, đi kèm chốt
 * URL vốn có.
 *
 * CA THẬT (auto-sync 25/8 → 3/9/2026, GPT1): URL đổi sang `?tab=invites` ngay
 * khi bấm, bảng bên dưới đổi sau. Chỉ soi URL nên mẻ quét lao vào đọc trúng
 * bảng "Người dùng" còn nằm lại, rồi gắn nhãn `pending` cho 100 thành viên đang
 * hoạt động (workspace chỉ có 3 lời mời chờ thật) và lật 4 trang của bảng đó
 * cho tới lúc hết giờ.
 */
import { describe, expect, it } from "vitest";
import { listSwapped } from "./click-tab-and-wait";

describe("listSwapped", () => {
  it("danh sách y nguyên → CHƯA đổi", () => {
    const usersList = "a@x.com|b@x.com|c@x.com";
    expect(listSwapped(usersList, usersList)).toBe(false);
  });

  it("sang danh sách khác → đã đổi", () => {
    expect(listSwapped("a@x.com|b@x.com", "z@x.com|y@x.com")).toBe(true);
  });

  it("bảng trống cũng là đã đổi — tab Lời mời hết lời mời là kết quả thật", () => {
    expect(listSwapped("a@x.com|b@x.com", "")).toBe(true);
  });

  it("từ trống sang có dòng → đã đổi", () => {
    expect(listSwapped("", "a@x.com")).toBe(true);
  });

  it("cùng trống hai lần → CHƯA đổi (bảng chưa render, đừng vội quét)", () => {
    expect(listSwapped("", "")).toBe(false);
  });
});
