/**
 * TÊN THÀNH VIÊN đọc từ row — chốt hai lỗi đã vào tới dữ liệu thật (workspace
 * GPT1, đọc DB 28/8/2026):
 *
 *   · 15 thành viên mang tên "Tiêu chuẩn" — row không có tên hiển thị (mọi row ở
 *     tab "Lời mời đang chờ xử lý" đều thế), vòng quét cả-row đi tiếp tới cột
 *     "Loại suất" rồi lấy luôn nhãn cột làm tên.
 *   · Hàng chục thành viên mang tên "NN", "HH", "ĐH"… — đó là chữ viết tắt trong
 *     ô avatar, lọt qua vì bộ lọc cũ chỉ chặn text dài dưới 2 ký tự.
 *
 * Tên thật hai ký tự của tiếng Trung/Nhật ("林曦") phải VẪN giữ được — chặn theo
 * "viết hoa toàn bộ" chứ không theo độ dài.
 */
import { describe, expect, it } from "vitest";
import { isNameText } from "./name";

const PREFIX = "yen.2xtnd.2014";

describe("isNameText", () => {
  it("nhận tên người bình thường", () => {
    expect(isNameText("Trần Thị Kim Hiền", PREFIX)).toBe(true);
    expect(isNameText("ahmed rajab ahmed", PREFIX)).toBe(true);
    expect(isNameText("林曦", PREFIX)).toBe(true);
    expect(isNameText("Ly", PREFIX)).toBe(true);
  });

  it("từ chối nhãn cột Loại suất (mọi cách gõ dấu)", () => {
    for (const label of [
      "Tiêu chuẩn",
      "tieu chuan",
      "TIÊU CHUẨN",
      "Cao cấp",
      "Standard",
      "Premium",
      "ChatGPT",
      "Codex",
    ]) {
      expect(isNameText(label, PREFIX), label).toBe(false);
    }
  });

  it("từ chối chữ viết tắt trong ô avatar", () => {
    for (const initials of ["A", "NN", "HH", "ĐH", "TQ"]) {
      expect(isNameText(initials, PREFIX), initials).toBe(false);
    }
  });

  it("từ chối email, ngày thêm, vai trò và chính phần trước @ của email", () => {
    expect(isNameText("yen.2xtnd.2014@gmail.com", PREFIX)).toBe(false);
    expect(isNameText("26 thg 8, 2026", PREFIX)).toBe(false);
    expect(isNameText("May 17, 2026", PREFIX)).toBe(false);
    expect(isNameText("Thành viên", PREFIX)).toBe(false);
    expect(isNameText("yen.2xtnd.2014", PREFIX)).toBe(false);
  });
});
