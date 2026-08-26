/**
 * Băng-rôn XANH "Gói đăng ký của bạn đã được cập nhật thành công" là lời ChatGPT
 * nói thẳng rằng TIỀN ĐÃ TRỪ. Nó chỉ được dùng để KHẲNG ĐỊNH đã mua (cấm mua
 * lại), không bao giờ để phủ định — nên hai thứ phải chốt bằng test: nhận đúng
 * câu thật, và KHÔNG nhận nhầm mấy câu "thành công" khác trên cùng trang (toast
 * "đã gửi lời mời", nhãn nút...) vốn sẽ khoá oan đường mua lại.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { findSuccessToast, isSuccessToastText, isToastNode } from "./detect-success-toast";

describe("isSuccessToastText", () => {
  it("nhận câu thật ChatGPT in ra (ảnh user 26/8/2026)", () => {
    expect(isSuccessToastText("Gói đăng ký của bạn đã được cập nhật thành công")).toBe(true);
  });

  it("nhận cả bản không dấu / xuống dòng / lẫn ký tự thừa", () => {
    expect(isSuccessToastText("Goi dang ky cua ban da duoc cap nhat thanh cong")).toBe(true);
    expect(isSuccessToastText("  Gói đăng ký của bạn\n đã được cập nhật thành công  ")).toBe(true);
  });

  it("nhận bản tiếng Anh và tiếng Trung", () => {
    expect(isSuccessToastText("Your subscription has been updated successfully")).toBe(true);
    expect(isSuccessToastText("Subscription updated")).toBe(true);
    expect(isSuccessToastText("您的订阅已更新成功")).toBe(true);
  });

  it("KHÔNG nhận câu 'thành công' của việc khác", () => {
    expect(isSuccessToastText("Đã gửi lời mời thành công")).toBe(false);
    expect(isSuccessToastText("Thêm thành viên thành công")).toBe(false);
    expect(isSuccessToastText("Thanh toán thành công")).toBe(false);
  });

  it("KHÔNG nhận câu báo hỏng, kể cả khi có chữ 'gói đăng ký'", () => {
    expect(isSuccessToastText("Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn")).toBe(false);
  });

  it("KHÔNG nhận nhãn nút trong hộp mua", () => {
    expect(isSuccessToastText("Cập nhật gói đăng ký")).toBe(false);
    expect(isSuccessToastText("Update subscription")).toBe(false);
  });
});

describe("isToastNode", () => {
  const el = (attrs: Record<string, string>): Element =>
    ({ getAttribute: (n: string) => attrs[n] ?? null }) as unknown as Element;

  it("nhận vùng thông báo — chúng KHÔNG chặn trang nên overlay phải bỏ qua", () => {
    expect(isToastNode(el({ role: "status" }))).toBe(true);
    expect(isToastNode(el({ role: "alert" }))).toBe(true);
    expect(isToastNode(el({ "aria-live": "polite" }))).toBe(true);
    expect(isToastNode(el({ "data-radix-toast-root": "" }))).toBe(true);
  });

  it("hộp thật thì KHÔNG phải toast", () => {
    expect(isToastNode(el({ role: "dialog", "data-state": "open" }))).toBe(false);
  });
});

/** DOM giả tối thiểu: body có textContent + querySelectorAll trả node đã khai. */
function stubDom(bodyText: string, toasts: string[] = [], deep: string[] = []): void {
  const mk = (text: string): unknown => ({
    textContent: text,
    children: [],
    getAttribute: () => null,
  });
  const body = {
    textContent: bodyText,
    children: deep.map(mk),
  };
  vi.stubGlobal("document", {
    body,
    querySelectorAll: () => toasts.map(mk),
  });
}

describe("findSuccessToast", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trang không có câu nào → null (không đi bộ DOM)", () => {
    stubDom("Thành viên Business · 65 thành viên");
    expect(findSuccessToast()).toBeNull();
  });

  it("lấy đúng câu trong node toast, không lấy cả trang", () => {
    stubDom(
      "Thành viên ... Gói đăng ký của bạn đã được cập nhật thành công ... 65 thành viên",
      ["Gói đăng ký của bạn đã được cập nhật thành công"],
    );
    expect(findSuccessToast()).toBe("Gói đăng ký của bạn đã được cập nhật thành công");
  });

  it("không có node toast nào khớp → đi bộ từ body lấy nhánh sâu nhất", () => {
    stubDom(
      "Rất nhiều chữ khác Gói đăng ký của bạn đã được cập nhật thành công và tiếp nữa",
      [],
      ["Gói đăng ký của bạn đã được cập nhật thành công"],
    );
    expect(findSuccessToast()).toBe("Gói đăng ký của bạn đã được cập nhật thành công");
  });
});
