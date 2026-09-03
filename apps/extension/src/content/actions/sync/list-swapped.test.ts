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

const USERS = ["a@x.com", "b@x.com", "c@x.com", "d@x.com"];

describe("listSwapped", () => {
  it("danh sách y nguyên → CHƯA đổi", () => {
    expect(listSwapped(USERS, USERS)).toBe(false);
  });

  it("CÙNG bảng nhưng đảo thứ tự → vẫn CHƯA đổi", () => {
    // Đây là ca làm chốt đầu tiên (so 5 email đầu) lọt: danh sách ảo hoá gắn lại
    // dòng theo vị trí cuộn nên thứ tự đổi liên tục.
    expect(listSwapped(USERS, [...USERS].reverse())).toBe(false);
  });

  it("CÙNG bảng nhưng cuộn nên chỉ còn một phần dòng → vẫn CHƯA đổi", () => {
    expect(listSwapped(USERS, ["c@x.com", "d@x.com"])).toBe(false);
  });

  it("sang danh sách khác hẳn → đã đổi", () => {
    expect(listSwapped(USERS, ["z@x.com", "y@x.com"])).toBe(true);
  });

  it("chỉ chung một dòng trên bốn → đã đổi", () => {
    expect(listSwapped(USERS, ["a@x.com", "z@x.com", "y@x.com", "w@x.com"])).toBe(
      true,
    );
  });

  it("bảng trống cũng là đã đổi — tab Lời mời hết lời mời là kết quả thật", () => {
    expect(listSwapped(USERS, [])).toBe(true);
  });

  it("từ trống sang có dòng → đã đổi", () => {
    expect(listSwapped([], ["a@x.com"])).toBe(true);
  });

  it("cùng trống hai lần → CHƯA đổi (bảng chưa render, đừng vội quét)", () => {
    expect(listSwapped([], [])).toBe(false);
  });
});
