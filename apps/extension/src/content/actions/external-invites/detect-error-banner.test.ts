/**
 * Băng-rôn đỏ "Something went wrong..." hiện NGAY sau cú bấm công tắc "Cho phép
 * lời mời từ miền bên ngoài" (ảnh user 3/9/2026). Ba thứ phải khoá bằng test:
 *
 *   1. Nhận đúng câu thật, cả bản tiếng Anh lẫn bản Việt hoá.
 *   2. KHÔNG nhận dải nâu "A workspace member hit a limit" đứng ngay cạnh nó
 *      trong đúng ảnh đó, cũng KHÔNG nhận nhãn/mô tả tĩnh của trang.
 *   3. Hai dải cùng hiện thì vẫn phải ra câu lỗi — đây là ca thật trong ảnh,
 *      và là chỗ dễ hỏng nhất nếu ai đó thêm danh sách loại trừ.
 */
import { describe, expect, it } from "vitest";

import {
  findIdentityErrorBanner,
  isIdentityErrorText,
} from "./detect-error-banner";

/** Node giả: hàm chỉ đụng `textContent` + `children`. */
type FakeNode = { textContent: string; children: FakeNode[] };

function node(text: string, children: FakeNode[] = []): FakeNode {
  return { textContent: text, children };
}

const asEl = (n: FakeNode): HTMLElement => n as unknown as HTMLElement;

const REAL_BANNER =
  "Something went wrong. If this issue persists please contact us through " +
  "our help center at help.openai.com.";
const LIMIT_BANNER =
  "A workspace member hit a limit Turn on auto-reload to automatically add " +
  "credits and prevent future interruptions.";

describe("isIdentityErrorText", () => {
  it("nhận câu thật ChatGPT in ra", () => {
    expect(isIdentityErrorText(REAL_BANNER)).toBe(true);
  });

  it("nhận bản Việt hoá, bản không dấu, bản xuống dòng", () => {
    expect(isIdentityErrorText("Đã xảy ra sự cố. Vui lòng thử lại.")).toBe(true);
    expect(isIdentityErrorText("Da xay ra su co")).toBe(true);
    expect(isIdentityErrorText("Đã xảy ra\n sự cố")).toBe(true);
    expect(isIdentityErrorText("Không thể lưu thay đổi")).toBe(true);
  });

  it("KHÔNG nhận dải hạn mức tín dụng đứng cạnh", () => {
    expect(isIdentityErrorText(LIMIT_BANNER)).toBe(false);
  });

  it("KHÔNG nhận nhãn và mô tả tĩnh của trang", () => {
    expect(isIdentityErrorText("Allow External Domain Invites")).toBe(false);
    expect(
      isIdentityErrorText(
        "Enable this to allow invites to users from any domain. Disable this " +
          "to limit invitations to users from your verified domains only.",
      ),
    ).toBe(false);
    expect(isIdentityErrorText("Cho phép lời mời từ miền bên ngoài")).toBe(false);
  });

  it("KHÔNG nhận mấy chữ lẻ vốn là nhãn nút", () => {
    expect(isIdentityErrorText("Thử lại")).toBe(false);
    expect(isIdentityErrorText("Error")).toBe(false);
  });
});

describe("findIdentityErrorBanner", () => {
  it("lấy câu NGẮN NHẤT còn khớp, không bốc cả hộp cha", () => {
    const root = node(`Identity & access ${REAL_BANNER} Verified Domains`, [
      node("Identity & access"),
      node(`Thông báo ${REAL_BANNER}`, [node(REAL_BANNER)]),
      node("Verified Domains"),
    ]);
    expect(findIdentityErrorBanner(asEl(root))).toBe(REAL_BANNER);
  });

  it("hai dải cùng hiện → vẫn ra câu lỗi, không bị dải hạn mức chặn", () => {
    const root = node(`${LIMIT_BANNER} ${REAL_BANNER}`, [
      node(LIMIT_BANNER),
      node(REAL_BANNER),
    ]);
    expect(findIdentityErrorBanner(asEl(root))).toBe(REAL_BANNER);
  });

  it("chỉ có dải hạn mức → null", () => {
    const root = node(LIMIT_BANNER, [node(LIMIT_BANNER)]);
    expect(findIdentityErrorBanner(asEl(root))).toBeNull();
  });

  it("trang sạch → null", () => {
    const root = node("Identity & access Allow External Domain Invites", [
      node("Identity & access"),
      node("Allow External Domain Invites"),
    ]);
    expect(findIdentityErrorBanner(asEl(root))).toBeNull();
  });

  it("cắt bớt câu dài quá 300 ký tự để khỏi chép cả trang vào thông báo", () => {
    const long = `${REAL_BANNER} ${"x".repeat(400)}`;
    const root = node(long, []);
    const got = findIdentityErrorBanner(asEl(root));
    expect(got).not.toBeNull();
    expect(got?.length).toBe(301);
    expect(got?.endsWith("…")).toBe(true);
  });
});
