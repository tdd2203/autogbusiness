import { describe, expect, it } from "vitest";
import { shouldSalvageInvite } from "./invite-salvage";

describe("lỗi mời nào là VÔ ĐỊNH (phải F5 phân xử, không hoàn phí ngay)", () => {
  it("VERIFY_FAILED sau khi ĐÃ bấm Gửi → phân xử lại (CA 1, 12/8/2026)", () => {
    // Đúng payload production: click Gửi xong, 15s không toast, dialog vẫn mở.
    expect(
      shouldSalvageInvite({
        error_code: "VERIFY_FAILED",
        error_message:
          'Đã submit nhưng không thấy toast thành công và dialog không đóng sau 15s. Dialog text: "Invite members to the CHAT GPT PRO workspace…"',
        data: { submit_clicked: true, chatgpt_error_hint: null },
      }),
    ).toBe(true);
  });

  it("ChatGPT báo lỗi trong dialog → bằng chứng DƯƠNG là mời không đi, giữ FAILED", () => {
    expect(
      shouldSalvageInvite({
        error_code: "VERIFY_FAILED",
        error_message: 'ChatGPT báo lỗi trong dialog: "already a member".',
        data: { submit_clicked: true, chatgpt_error_hint: "already a member" },
      }),
    ).toBe(false);
  });

  it("VERIFY_FAILED của extension CŨ (không có data) → giữ hành vi cũ, không đoán bừa", () => {
    expect(shouldSalvageInvite({ error_code: "VERIFY_FAILED" })).toBe(false);
  });

  it("kênh message chết giữa chừng → phân xử lại (bug 1/8/2026)", () => {
    expect(
      shouldSalvageInvite({
        error_code: "UNKNOWN",
        error_message:
          "A listener indicated an asynchronous response by returning true, but the message channel closed",
      }),
    ).toBe(true);
  });

  it("CONTENT_TIMEOUT → phân xử lại", () => {
    expect(shouldSalvageInvite({ error_code: "CONTENT_TIMEOUT" })).toBe(true);
  });

  it("lỗi TRƯỚC khi bấm Gửi → biết chắc mời không đi, hoàn phí là ĐÚNG", () => {
    // Không bật được toggle external / không tìm thấy nút / sai trang: chưa hề click.
    for (const error_code of [
      "EXTERNAL_TOGGLE_FAILED",
      "UI_ELEMENT_NOT_FOUND",
      "FAILED_UI_CHANGED",
      "PAGE_NOT_ADMIN",
      "NOT_LOGGED_IN_CHATGPT",
    ]) {
      expect(shouldSalvageInvite({ error_code, error_message: "" })).toBe(false);
    }
  });
});
