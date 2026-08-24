/**
 * Nội dung hộp "Quản lý suất" được ghi vào `result` của task — nó là manh mối duy
 * nhất về NGUYÊN NHÂN khi bộ đếm lệch dòng tỉ lệ. Hai thứ phải đúng: không lọt
 * danh tính ai, và không phình `result`.
 */
import { describe, expect, it } from "vitest";

import { summarizeSeatModalText } from "./check-seat-availability";

describe("summarizeSeatModalText", () => {
  it("gộp xuống một dòng, bỏ khoảng trắng thừa của DOM", () => {
    expect(
      summarizeSeatModalText("  Tiêu chuẩn\n\n  649.000 đ/tháng\t\n 148/151 đã gán  "),
    ).toBe("Tiêu chuẩn 649.000 đ/tháng 148/151 đã gán");
  });

  it("giữ nguyên lời hộp tự khai về thay đổi hẹn kỳ sau — chính là thứ cần đọc", () => {
    const got = summarizeSeatModalText(
      "148/151 đã gán   Đang chờ 1 lượt gỡ, có hiệu lực từ kỳ sau",
    );
    expect(got).toContain("Đang chờ 1 lượt gỡ");
    expect(got).toContain("có hiệu lực từ kỳ sau");
  });

  it("XOÁ mọi thứ hình dạng email — result đi vào DB và có thể lọt ra nhật ký", () => {
    const got = summarizeSeatModalText("Chủ sở hữu boss.nguyen@congty.vn · 60/60 đã gán");
    expect(got).toBe("Chủ sở hữu <email> · 60/60 đã gán");
    expect(got).not.toContain("@congty.vn");
  });

  it("cắt ở 500 ký tự để không phình result của task", () => {
    const got = summarizeSeatModalText("x".repeat(900));
    expect(got).toHaveLength(501); // 500 + dấu …
    expect(got?.endsWith("…")).toBe(true);
  });

  it("rỗng / chỉ khoảng trắng / null → null, không nhét chuỗi rỗng vào DB", () => {
    expect(summarizeSeatModalText(null)).toBeNull();
    expect(summarizeSeatModalText(undefined)).toBeNull();
    expect(summarizeSeatModalText("")).toBeNull();
    expect(summarizeSeatModalText("   \n\t ")).toBeNull();
  });
});
