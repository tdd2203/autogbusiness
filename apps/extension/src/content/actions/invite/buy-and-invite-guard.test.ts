import { describe, expect, it } from "vitest";

import { isBuyAndInviteLabel } from "./execute-invite-inner";

/**
 * Nút CUỐI của hộp "Xem lại giao dịch mua" trong luồng MỜI: bấm là mua ghế bằng
 * tiền thật rồi gửi lời mời trong cùng một cú. Nhãn của nó chứa "gửi lời mời"
 * nên `findInviteSubmitButton` nhận nhầm — lớp chặn này là thứ duy nhất đứng
 * giữa cú bấm đó và thẻ thanh toán của workspace.
 */
describe("chặn nút mua-kèm-gửi-lời-mời", () => {
  it("bắt nhãn thật của ChatGPT (vi/en/zh)", () => {
    expect(isBuyAndInviteLabel("Mua suất người dùng và gửi lời mời")).toBe(true);
    expect(isBuyAndInviteLabel("Mua  suất  và  gửi  lời  mời")).toBe(true);
    expect(isBuyAndInviteLabel("Purchase seats and send invites")).toBe(true);
    expect(isBuyAndInviteLabel("Buy seat and invite")).toBe(true);
    expect(isBuyAndInviteLabel("购买席位并发送邀请")).toBe(true);
  });

  it("KHÔNG chặn oan nút gửi lời mời bình thường", () => {
    for (const label of [
      "Gửi lời mời",
      "Gửi các lời mời",
      "Send invites",
      "Send invitation",
      "发送邀请",
      "Mời thành viên",
      "Mời",
    ]) {
      expect(isBuyAndInviteLabel(label)).toBe(false);
    }
  });

  it("nhãn rỗng / lạ thì để cho luồng cũ xử lý", () => {
    expect(isBuyAndInviteLabel("")).toBe(false);
    expect(isBuyAndInviteLabel("Tiếp tục")).toBe(false);
  });
});
