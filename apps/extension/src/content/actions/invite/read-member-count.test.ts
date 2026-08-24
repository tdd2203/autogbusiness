/**
 * Text mẫu lấy từ ảnh chụp /admin/members của user 2026-08-24 (workspace
 * "CHAT GPT PRO", thanh bên và tiêu đề đều in "Business · 146 thành viên").
 */
import { describe, expect, it } from "vitest";
import { parseMemberCount } from "./read-member-count";

const PAGE =
  "Quay lại đoạn trò chuyện" +
  "CHAT GPT PRO" +
  "Business · 146 thành viên" +
  "Chung Thành viên Quyền & vai trò" +
  "Thành viên" +
  "Business · 146 thành viên" +
  "Người dùng Lời mời đang chờ xử lý Yêu cầu đang chờ xử lý" +
  "Quản lý số suất + Mời thành viên";

describe("parseMemberCount", () => {
  it("đọc số thành viên in trên trang", () => {
    expect(parseMemberCount(PAGE)).toBe(146);
  });

  it("nút 'Mời thành viên' không có số đứng trước → không khớp nhầm", () => {
    expect(parseMemberCount("Mời thành viên")).toBeNull();
  });

  it("khớp bản tiếng Anh", () => {
    expect(parseMemberCount("Business · 146 members")).toBe(146);
  });

  it("hai số khác nhau → không dám dùng", () => {
    expect(parseMemberCount("146 thành viên ... 12 thành viên")).toBeNull();
  });

  it("không thấy số nào → null", () => {
    expect(parseMemberCount("Thành viên")).toBeNull();
  });
});
