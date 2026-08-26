/**
 * Ca thật 2026-08-26 (ảnh user): bấm nút cuối xong, hộp in băng-rôn đỏ "Đã xảy
 * ra sự cố khi cập nhật gói đăng ký của bạn" và đứng im. Chốt hai điều ở đây:
 * nhận ra được câu đó (vi/en/zh), và KHÔNG nhận nhầm hộp bình thường — nhận
 * nhầm là bỏ dở một giao dịch đang chạy ngon.
 */
import { describe, expect, it } from "vitest";

import { findModalErrorBanner, isErrorBannerText } from "./detect-error-banner";

/** Node giả: hàm chỉ đụng `textContent` + `children`. */
type FakeNode = { textContent: string; children: FakeNode[] };

function node(text: string, children: FakeNode[] = []): FakeNode {
  return { textContent: text, children };
}

const asEl = (n: FakeNode): HTMLElement => n as unknown as HTMLElement;

describe("isErrorBannerText", () => {
  it("nhận câu lỗi thật của ChatGPT (vi/en/zh)", () => {
    expect(
      isErrorBannerText("Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn"),
    ).toBe(true);
    expect(isErrorBannerText("Có lỗi xảy ra, vui lòng thử lại")).toBe(true);
    expect(isErrorBannerText("Something went wrong updating your subscription")).toBe(
      true,
    );
    expect(isErrorBannerText("An error occurred")).toBe(true);
    expect(isErrorBannerText("更新订阅时出了点问题")).toBe(true);
  });

  it("KHÔNG nhận nội dung hộp xác nhận bình thường", () => {
    expect(
      isErrorBannerText(
        "Xem lại thay đổi người dùng Thêm 1 suất Tiêu chuẩn + 260.500 đ/tháng " +
          "Hóa đơn hằng tháng hiện tại 17.193.000 đ + thuế Xác nhận thay đổi",
      ),
    ).toBe(false);
    expect(isErrorBannerText("Xem lại giao dịch mua · Tổng phải trả hôm nay")).toBe(
      false,
    );
  });

  it("KHÔNG nhận mấy chữ chung chung đứng một mình", () => {
    // "Thử lại" là nhãn nút, "error" có thể nằm trong id/class được ghép vào text.
    expect(isErrorBannerText("Thử lại")).toBe(false);
    expect(isErrorBannerText("error")).toBe(false);
  });
});

describe("findModalErrorBanner", () => {
  it("trả đúng câu băng-rôn chứ không phải cả hộp", () => {
    const banner = node("Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn");
    const modal = node(
      "Xem lại thay đổi người dùngĐã xảy ra sự cố khi cập nhật gói đăng ký của bạn" +
        "Thêm 1 suất Tiêu chuẩnXác nhận thay đổi",
      [
        node("Xem lại thay đổi người dùng"),
        node("Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn", [banner]),
        node("Thêm 1 suất Tiêu chuẩn"),
      ],
    );
    expect(findModalErrorBanner(asEl(modal))).toBe(
      "Đã xảy ra sự cố khi cập nhật gói đăng ký của bạn",
    );
  });

  it("hộp không có lỗi → null", () => {
    const modal = node("Xem lại giao dịch muaTổng phải trả hôm nay 260.500 đ", [
      node("Xem lại giao dịch mua"),
      node("Tổng phải trả hôm nay 260.500 đ"),
    ]);
    expect(findModalErrorBanner(asEl(modal))).toBeNull();
  });
});
