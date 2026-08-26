import { describe, expect, it } from "vitest";
import { splitByDay, type DaySection } from "./AuditLogs";

/* Nhật ký ngăn theo NGÀY giống trang Ví (chốt user 2026-08-26: "có hôm nay rồi
   thì chỉ cần giờ thôi"). Ngày phải chốt theo GIỜ VIỆT NAM — mốc UTC 17:00 đã là
   nửa đêm hôm sau ở VN — nếu không thì dải ngày và giờ trên dòng đá nhau. */

function g(key: string, latestTs: string) {
  return { key, latestTs } as never;
}

function shape(secs: DaySection[]) {
  return secs.map((s) => [s.date, s.groups.map((x) => (x as { key: string }).key)]);
}

describe("splitByDay", () => {
  it("gom các nhóm cùng ngày VN vào một dải, giữ thứ tự mới→cũ", () => {
    const secs = splitByDay([
      g("a", "2026-08-26T03:10:00Z"),
      g("b", "2026-08-26T01:00:00Z"),
      g("c", "2026-08-24T09:00:00Z"),
    ]);
    expect(shape(secs)).toEqual([
      ["2026-08-26", ["a", "b"]],
      ["2026-08-24", ["c"]],
    ]);
  });

  it("chốt ngày theo giờ VN: 17:00Z là đã sang ngày hôm sau", () => {
    const secs = splitByDay([
      g("khuya", "2026-08-25T17:30:00Z"), // 00:30 ngày 26/8 giờ VN
      g("chieu", "2026-08-25T09:00:00Z"), // 16:00 ngày 25/8 giờ VN
    ]);
    expect(shape(secs)).toEqual([
      ["2026-08-26", ["khuya"]],
      ["2026-08-25", ["chieu"]],
    ]);
  });

  it("nhóm bắc cầu qua nửa đêm không sinh dải ngày trùng lặp", () => {
    // Lệnh chạy vắt qua nửa đêm ⇒ nhóm sau có thể mang mốc ngày cũ hơn nhóm
    // đứng trước rồi lại quay về ngày mới — dải ngày vẫn phải gộp về một mối.
    const secs = splitByDay([
      g("a", "2026-08-26T02:00:00Z"),
      g("b", "2026-08-25T16:00:00Z"),
      g("c", "2026-08-26T01:00:00Z"),
    ]);
    expect(shape(secs)).toEqual([
      ["2026-08-26", ["a", "c"]],
      ["2026-08-25", ["b"]],
    ]);
  });

  it("danh sách rỗng ⇒ không dải nào", () => {
    expect(splitByDay([])).toEqual([]);
  });
});
