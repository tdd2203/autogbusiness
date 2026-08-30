/**
 * Câu "Lời mời từ miền bên ngoài bị vô hiệu hóa với không gian làm việc này"
 * (user gửi nguyên văn 30/8/2026) là bằng chứng do CHÍNH ChatGPT khai rằng công
 * tắc đã lưu xong. Hai thứ phải khoá bằng test:
 *
 *   1. Nhận đúng câu thật, kể cả bản không dấu / "hoá" ↔ "hóa" / tiếng Anh.
 *   2. KHÔNG nhận nhãn của chính công tắc ("Cho phép lời mời từ miền bên
 *      ngoài") — nhãn đó nằm sẵn trên /admin/identity, nhận nhầm là tự khai
 *      bằng chứng cho một cú bấm chưa hề xảy ra.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findExternalToggleToast,
  readToggleToastText,
} from "./detect-toggle-toast";

describe("readToggleToastText", () => {
  it("nhận câu TẮT thật ChatGPT in ra", () => {
    expect(
      readToggleToastText(
        "Lời mời từ miền bên ngoài bị vô hiệu hóa với không gian làm việc này",
      ),
    ).toBe(false);
  });

  it("nhận bản không dấu, bản 'hoá', bản xuống dòng", () => {
    expect(
      readToggleToastText(
        "Loi moi tu mien ben ngoai bi vo hieu hoa voi khong gian lam viec nay",
      ),
    ).toBe(false);
    expect(
      readToggleToastText(
        "Lời mời từ miền bên ngoài\n bị vô hiệu hoá với không gian làm việc này",
      ),
    ).toBe(false);
  });

  it("nhận câu BẬT và phân biệt được với câu TẮT", () => {
    expect(
      readToggleToastText(
        "Lời mời từ miền bên ngoài được bật cho không gian làm việc này",
      ),
    ).toBe(true);
    expect(
      readToggleToastText("External domain invites enabled for this workspace"),
    ).toBe(true);
    expect(
      readToggleToastText("External domain invites disabled for this workspace"),
    ).toBe(false);
  });

  it("KHÔNG nhận nhãn của chính công tắc (thiếu vế tắt/bật)", () => {
    expect(
      readToggleToastText("Cho phép lời mời từ miền bên ngoài"),
    ).toBeNull();
    expect(readToggleToastText("Allow External Domain Invites")).toBeNull();
  });

  it("KHÔNG nhận câu tắt/bật của setting KHÁC trên cùng trang", () => {
    expect(
      readToggleToastText("Tự động tạo tài khoản bị vô hiệu hóa"),
    ).toBeNull();
    expect(
      readToggleToastText("Automatic account creation disabled"),
    ).toBeNull();
  });

  it("nói cả tắt lẫn bật → mập mờ, không dám chọn", () => {
    expect(
      readToggleToastText(
        "Lời mời từ miền bên ngoài được bật rồi bị vô hiệu hóa",
      ),
    ).toBeNull();
  });
});

/** DOM giả tối thiểu: `querySelectorAll` trả đúng các node toast đã khai. */
function stubToasts(texts: string[]): void {
  vi.stubGlobal("document", {
    querySelectorAll: () => texts.map((t) => ({ textContent: t })),
  });
}

describe("findExternalToggleToast", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("đọc câu trong vùng thông báo, trả nguyên văn còn dấu", () => {
    stubToasts([
      "Lời mời từ miền bên ngoài bị vô hiệu hóa với không gian làm việc này",
    ]);
    expect(findExternalToggleToast()).toEqual({
      text: "Lời mời từ miền bên ngoài bị vô hiệu hóa với không gian làm việc này",
      enabled: false,
    });
  });

  it("nhiều node lồng nhau → lấy câu NGẮN NHẤT, không bốc cả cụm cha", () => {
    const short =
      "Lời mời từ miền bên ngoài bị vô hiệu hóa với không gian làm việc này";
    stubToasts([`Thông báo ${short} Đóng`, short]);
    expect(findExternalToggleToast()?.text).toBe(short);
  });

  it("không có vùng thông báo nào khớp → null", () => {
    stubToasts(["Đã gửi lời mời", "Cho phép lời mời từ miền bên ngoài"]);
    expect(findExternalToggleToast()).toBeNull();
  });
});
